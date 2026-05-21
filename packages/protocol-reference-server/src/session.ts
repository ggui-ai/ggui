/**
 * In-memory session store for the reference server.
 *
 * Sessions are ephemeral and process-local — this is the whole
 * point of the reference server. Persistence is explicitly out of
 * scope. Restart drops state; that's documented behavior, not a TODO.
 *
 * Each session carries an actionSpec map that the `register-actionspec`
 * ConformanceHost directive populates. The action router
 * (`./action-router.ts`) consults this map at dispatch time to
 * resolve action-name → tool-name → handler.
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
 * registered streamSpec for the session. Real ggui servers may
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

export interface Session {
  readonly sessionId: string;
  readonly appId: string;
  readonly actionSpecs: Map<string, ActionSpecEntry>;
  readonly streamSpecs: Map<string, StreamSpecEntry>;
  readonly subscribers: Set<Subscriber>;
  /**
   * Per-session protocol-version override. When set, the WS subscribe
   * + UPGRADE_REQUIRED paths advertise this value in place of the
   * server-instance-level `versionOverride`.
   *
   * Discipline (mirrors `ReferenceServerOptions.versionOverride`):
   * conformance fault-injection ONLY. Populated exclusively by the
   * `server-version-override` setup directive in the conformance host
   * adapter — production code paths leave this `undefined`.
   *
   * Why per-session, not per-instance: parallel kit fixtures share
   * one `ReferenceServer`. Mutating the instance-level override would
   * leak across sessions; the per-session field scopes the mismatch
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
 * In-memory session store. Wraps a `Map<sessionId, Session>` with
 * the operations the ConformanceHost adapter + WS subscribe handler
 * need. No locking — JS single-threaded; all calls originate from
 * the event loop.
 */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private lastCreated: string | undefined;

  create(sessionId: string, appId: string): Session {
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) {
      this.lastCreated = sessionId;
      return existing;
    }
    const session: Session = {
      sessionId,
      appId,
      actionSpecs: new Map(),
      streamSpecs: new Map(),
      subscribers: new Set(),
    };
    this.sessions.set(sessionId, session);
    this.lastCreated = sessionId;
    return session;
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

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  close(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  addSubscriber(sessionId: string, subscriber: Subscriber): Session {
    const session = this.create(sessionId, 'conformance');
    session.subscribers.add(subscriber);
    return session;
  }

  removeSubscriber(sessionId: string, subscriber: Subscriber): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    session.subscribers.delete(subscriber);
  }

  registerActionSpec(sessionId: string, entry: ActionSpecEntry): void {
    const session = this.create(sessionId, 'conformance');
    session.actionSpecs.set(entry.name, entry);
  }

  /**
   * Register a stream channel ↔ refresh-tool binding on the named
   * session. Same "create-if-missing" semantics as
   * {@link registerActionSpec} so the ConformanceHost adapter can
   * dispatch this directive before subscribe lands. Keyed by
   * `entry.channel` — registering the same channel twice replaces
   * the prior binding, matching the action-spec map's behavior.
   */
  registerStreamSpec(sessionId: string, entry: StreamSpecEntry): void {
    const session = this.create(sessionId, 'conformance');
    session.streamSpecs.set(entry.channel, entry);
  }

  /**
   * Set the per-session protocol-version override. Used by the
   * `server-version-override` ConformanceHost directive — populates
   * {@link Session.versionOverride} so the WS subscribe handler
   * advertises this value (and emits UPGRADE_REQUIRED keyed off it)
   * for THIS session only, leaving parallel sessions on the instance-
   * level default.
   *
   * Same "create-if-missing" semantics as the other register* setters
   * so directive ordering relative to subscribe doesn't matter.
   */
  setVersionOverride(sessionId: string, version: string): void {
    const session = this.create(sessionId, 'conformance');
    session.versionOverride = version;
  }

  /**
   * Fan out a frame to every subscriber on the named session. Used by
   * the `emit-envelope` ConformanceHost directive — kit fixtures use
   * it to inject WS-observable side-effects (envelopes the server
   * would not normally emit on its own) so the kit can assert
   * downstream consequences (sequencing, fan-out, observability).
   *
   * Returns `true` if the session existed and at least one subscriber
   * received the frame; `false` if the session is unknown OR has no
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
    const session = this.sessions.get(sessionId);
    if (session === undefined) return false;
    if (session.subscribers.size === 0) return false;
    for (const subscriber of session.subscribers) {
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
