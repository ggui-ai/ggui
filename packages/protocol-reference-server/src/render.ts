/**
 * In-memory GguiSession store for the reference server.
 *
 * GguiSessions are ephemeral and process-local — this is the whole
 * point of the reference server. Persistence is explicitly out of
 * scope. Restart drops state; that's documented behavior, not a TODO.
 *
 * Each GguiSession carries an actionSpec map that the `register-actionspec`
 * ConformanceHost directive populates. The action router
 * (`./action-router.ts`) consults this map at dispatch time to
 * resolve action-name → tool-name → handler.
 *
 * Wire-shape note: the conformance kit drives the reference server
 * over the SPEC §12.2 wire using the canonical render-identity field
 * `sessionId`.
 */

/**
 * Actionspec entry maps an action name (the value wired into DOM
 * `data-ggui-action` attributes on real UIs; here sent verbatim on
 * the fixture's inputEnvelope) to the registered tool name the
 * router should dispatch to.
 */
export interface ActionSpecEntry {
  readonly name: string;
  readonly tool: string;
}

/**
 * Streamspec entry binds a stream channel to a "refresh tool" — the
 * tool the action-router invokes after a successful wired-action
 * dispatch to produce the channel's next snapshot. Mirrors the real
 * `streamSpec[channel].tool` shape declared by ggui blueprints (SPEC
 * §2.3 StreamSpec refresh triggers): a wired action mutates state,
 * the refresh tool reads fresh state, the stream-update wraps the
 * read into an envelope on the named channel.
 *
 * Reference-server scope: refresh-tool invocation is unconditional
 * — every successful wired-action dispatch fans out through every
 * registered streamSpec for the GguiSession. Real ggui servers may
 * filter by which actions touch which channels; the reference
 * server's narrower contract is "any successful action triggers all
 * declared refreshes", which is sufficient for the kit's
 * `stream-refresh-success` proof and stays under the package's
 * 20–50 LOC budget for refresh-stream support.
 */
export interface StreamSpecEntry {
  readonly channel: string;
  readonly tool: string;
}

export interface GguiSession {
  readonly sessionId: string;
  readonly appId: string;
  readonly actionSpecs: Map<string, ActionSpecEntry>;
  readonly streamSpecs: Map<string, StreamSpecEntry>;
  readonly subscribers: Set<Subscriber>;
  /**
   * Per-render protocol-version override. When set, the WS subscribe
   * + UPGRADE_REQUIRED paths advertise this value in place of the
   * server-instance-level `versionOverride`.
   *
   * Discipline (mirrors `ReferenceServerOptions.versionOverride`):
   * conformance fault-injection ONLY. Populated exclusively by the
   * `server-version-override` setup directive in the conformance host
   * adapter — production code paths leave this `undefined`.
   *
   * Why per-render, not per-instance: parallel kit fixtures share
   * one `ReferenceServer`. Mutating the instance-level override would
   * leak across renders; the per-render field scopes the mismatch
   * to the one fixture that asked for it.
   */
  versionOverride?: string;
}

/**
 * Minimal subscriber handle — the action router calls `send()` to
 * emit stream frames (including `_ggui:contract-error`) back to the
 * subscribed WebSocket.
 */
export interface Subscriber {
  send(frame: unknown): void;
}

/**
 * In-memory GguiSession store. Wraps a `Map<sessionId, GguiSession>` with
 * the operations the ConformanceHost adapter + WS subscribe handler
 * need. No locking — JS single-threaded; all calls originate from
 * the event loop.
 */
export class GguiSessionStore {
  private readonly renders = new Map<string, GguiSession>();
  private lastCreated: string | undefined;

  create(sessionId: string, appId: string): GguiSession {
    const existing = this.renders.get(sessionId);
    if (existing !== undefined) {
      this.lastCreated = sessionId;
      return existing;
    }
    const render: GguiSession = {
      sessionId,
      appId,
      actionSpecs: new Map(),
      streamSpecs: new Map(),
      subscribers: new Set(),
    };
    this.renders.set(sessionId, render);
    this.lastCreated = sessionId;
    return render;
  }

  /**
   * The sessionId most recently passed to `create()`. Used by the
   * ConformanceHost's `register-actionspec` dispatcher — that
   * directive doesn't carry a sessionId in its JSON shape, so the
   * adapter needs the "most recently created" scope to bind the
   * actionspec to. This matches the fixture-authoring convention that
   * create-session always precedes register-actionspec.
   */
  lastCreatedSessionId(): string | undefined {
    return this.lastCreated;
  }

  get(sessionId: string): GguiSession | undefined {
    return this.renders.get(sessionId);
  }

  close(sessionId: string): boolean {
    return this.renders.delete(sessionId);
  }

  addSubscriber(sessionId: string, subscriber: Subscriber): GguiSession {
    const render = this.create(sessionId, 'conformance');
    render.subscribers.add(subscriber);
    return render;
  }

  removeSubscriber(sessionId: string, subscriber: Subscriber): void {
    const render = this.renders.get(sessionId);
    if (render === undefined) return;
    render.subscribers.delete(subscriber);
  }

  registerActionSpec(sessionId: string, entry: ActionSpecEntry): void {
    const render = this.create(sessionId, 'conformance');
    render.actionSpecs.set(entry.name, entry);
  }

  /**
   * Register a stream channel ↔ refresh-tool binding on the named
   * render. Same "create-if-missing" semantics as
   * {@link registerActionSpec} so the ConformanceHost adapter can
   * dispatch this directive before subscribe lands. Keyed by
   * `entry.channel` — registering the same channel twice replaces
   * the prior binding, matching the action-spec map's behavior.
   */
  registerStreamSpec(sessionId: string, entry: StreamSpecEntry): void {
    const render = this.create(sessionId, 'conformance');
    render.streamSpecs.set(entry.channel, entry);
  }

  /**
   * Set the per-render protocol-version override. Used by the
   * `server-version-override` ConformanceHost directive — populates
   * {@link GguiSession.versionOverride} so the WS subscribe handler
   * advertises this value (and emits UPGRADE_REQUIRED keyed off it)
   * for THIS render only, leaving parallel renders on the instance-
   * level default.
   *
   * Same "create-if-missing" semantics as the other register* setters
   * so directive ordering relative to subscribe doesn't matter.
   */
  setVersionOverride(sessionId: string, version: string): void {
    const render = this.create(sessionId, 'conformance');
    render.versionOverride = version;
  }

  /**
   * Fan out a frame to every subscriber on the named render. Used by
   * the `emit-envelope` ConformanceHost directive — kit fixtures use
   * it to inject WS-observable side-effects (envelopes the server
   * would not normally emit on its own) so the kit can assert
   * downstream consequences (sequencing, fan-out, observability).
   *
   * Returns `true` if the GguiSession existed and at least one subscriber
   * received the frame; `false` if the GguiSession is unknown OR has no
   * subscribers attached. Caller may use the boolean to log a warning
   * when a fixture's directive-injection lands before any subscribe
   * — the directive then has no observable effect, which is usually
   * a fixture-authoring bug worth surfacing.
   *
   * Subscriber-level send failures (closed socket, etc.) are
   * swallowed per the same convention as the action router's
   * `broadcast()` — one bad subscriber must not block fan-out to the
   * rest.
   */
  injectFrame(sessionId: string, frame: unknown): boolean {
    const render = this.renders.get(sessionId);
    if (render === undefined) return false;
    if (render.subscribers.size === 0) return false;
    for (const subscriber of render.subscribers) {
      try {
        subscriber.send(frame);
      } catch {
        // Subscriber lifecycle issues (closed socket, etc.) are the
        // subscriber's problem — the store keeps fanning out.
      }
    }
    return true;
  }
}
