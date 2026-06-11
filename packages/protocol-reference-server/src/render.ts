/**
 * In-memory GguiSession store for the reference server.
 *
 * GguiSessions are ephemeral and process-local — this is the whole
 * point of the reference server. Persistence is explicitly out of
 * scope. Restart drops state; that's documented behavior, not a TODO.
 *
 * Each GguiSession carries:
 *   - an optional declared `actionSpec` (installed by the
 *     `create-session` ConformanceHost directive) — the action
 *     handler (`./action-router.ts`) enforces the declared-action
 *     contract (name membership + per-entry payload schema) for
 *     inbound `data:submit` envelopes against it;
 *   - an event ledger (the consume buffer) — appended actions get a
 *     monotonic per-session `sequence` the action ack echoes back;
 *   - an outbound stream-sequence cursor — the `emit-envelope`
 *     ConformanceHost directive stamps `StreamEnvelope.seq` on
 *     injected `{type:'data'}` frames from it;
 *   - an optional persisted `hostContext` — the
 *     `host_context_observed` Client→Server handler
 *     (`./host-context.ts`) overwrites it with the iframe-observed
 *     `HostContextProjection`; the ConformanceHost's
 *     `readSessionField` seam reads it back for `session-state`
 *     grading.
 *
 * Wire-shape note: the conformance kit drives the reference server
 * over the SPEC §12.2 wire using the canonical render-identity field
 * `sessionId`.
 */
import type { ActionSpec, HostContextProjection } from '@ggui-ai/protocol';

/**
 * One appended consume-buffer event. The ledger is the reference
 * server's stand-in for a real ggui server's persisted event store —
 * `sequence` is assigned at append time, starts at 1, and increases
 * monotonically per session. The agent-side drain (`ggui_consume`) is
 * an MCP surface this WS-only server does not implement; the ledger
 * exists so the ack's `payload.sequence` is a real persistence proof,
 * not a fabricated counter.
 */
export interface SessionEvent {
  readonly sequence: number;
  /** Event type, e.g. `'user.submitted'` for inbound actions. */
  readonly type: string;
  /** The appended envelope body, verbatim. */
  readonly data: unknown;
}

export interface GguiSession {
  readonly sessionId: string;
  readonly appId: string;
  /**
   * Declared actionSpec — the protocol's `ActionSpec` (action name →
   * `ActionEntry`, including each entry's optional payload `schema`).
   * `undefined` means no contract is declared and the action handler
   * accepts every action (mirroring the first-party
   * `assertActionContract` no-op on undeclared specs). Installed by
   * the `create-session` directive's `actionSpec` field (the
   * ConformanceHost adapter maps the kit's declaration onto the
   * protocol type); never mutated after install.
   */
  actionSpec?: ActionSpec;
  /** Consume-buffer event ledger. Append via {@link appendEvent}. */
  readonly events: SessionEvent[];
  /**
   * Outbound stream-delivery sequence cursor — the `seq` stamped on
   * the most recent `{type:'data'}` StreamEnvelope emitted for this
   * render. Starts at 0 (nothing emitted yet); advanced by
   * {@link GguiSessionStore.nextStreamSeq}. Per-render and monotonic,
   * mirroring the StreamEnvelope sequencing contract (`seq` starts at
   * 1, gap-free within a render). Distinct from the consume-buffer
   * ledger's `sequence` — that counts INBOUND appended actions; this
   * counts OUTBOUND stream deliveries.
   */
  streamSeq: number;
  /**
   * Persisted `HostContextProjection` — written by the
   * `host_context_observed` Client→Server handler
   * (`./host-context.ts`) as an idempotent overwrite (re-delivery
   * replaces, never merges). `undefined` until the client's first
   * observation lands. Read back through the ConformanceHost's
   * `readSessionField('hostContext')` introspection seam, which is how
   * the kit's `session-state` fixtures grade the persistence
   * obligation.
   */
  hostContext?: HostContextProjection;
  readonly subscribers: Set<Subscriber>;
  /**
   * Per-GguiSession protocol-version override. When set, the WS subscribe
   * + UPGRADE_REQUIRED paths advertise this value in place of the
   * server-instance-level `versionOverride`.
   *
   * Discipline (mirrors `ReferenceServerOptions.versionOverride`):
   * conformance fault-injection ONLY. Populated exclusively by the
   * `server-version-override` setup directive in the conformance host
   * adapter — production code paths leave this `undefined`.
   *
   * Why per-GguiSession, not per-instance: parallel kit fixtures share
   * one `ReferenceServer`. Mutating the instance-level override would
   * leak across GguiSessions; the per-GguiSession field scopes the mismatch
   * to the one fixture that asked for it.
   */
  versionOverride?: string;
}

/**
 * Minimal subscriber handle — the server calls `send()` to emit
 * frames (acks, errors, stream envelopes) back to the subscribed
 * WebSocket.
 */
export interface Subscriber {
  send(frame: unknown): void;
}

/**
 * Append one event to the session's consume-buffer ledger and return
 * the monotonic sequence it was assigned. The action handler calls
 * this BEFORE acking — append-then-ack is the ordering contract the
 * kit's `action-ack-sequence` fixture grades.
 */
export function appendEvent(
  render: GguiSession,
  event: { readonly type: string; readonly data: unknown },
): number {
  const sequence = render.events.length + 1;
  render.events.push({ sequence, type: event.type, data: event.data });
  return sequence;
}

/**
 * In-memory GguiSession store. Wraps a `Map<sessionId, GguiSession>` keyed by sessionId with
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
      events: [],
      streamSeq: 0,
      subscribers: new Set(),
    };
    this.renders.set(sessionId, render);
    this.lastCreated = sessionId;
    return render;
  }

  /**
   * The sessionId most recently passed to `create()`. Used by the
   * ConformanceHost's directive dispatchers whose JSON shapes don't
   * carry a sessionId (`server-version-override`, `emit-envelope`) —
   * the adapter scopes them to the "most recently created" render,
   * matching the fixture-authoring convention that create-session
   * always precedes the scoped directive.
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

  /**
   * Install the declared actionSpec on the named render. Same
   * "create-if-missing" semantics as the other setters so directive
   * ordering relative to subscribe doesn't matter. Called by the
   * `create-session` ConformanceHost directive when the fixture
   * authors an `actionSpec` — actions are part of the render's
   * identity, so the declaration rides session creation rather than a
   * separate registration directive.
   */
  declareActionSpec(sessionId: string, actionSpec: ActionSpec): void {
    const render = this.create(sessionId, 'conformance');
    render.actionSpec = actionSpec;
  }

  /**
   * Set the per-render protocol-version override. Used by the
   * `server-version-override` ConformanceHost directive — populates
   * {@link GguiSession.versionOverride} so the WS subscribe handler
   * advertises this value (and emits UPGRADE_REQUIRED keyed off it)
   * for THIS GguiSession only, leaving parallel GguiSessions on the instance-
   * level default.
   *
   * Same "create-if-missing" semantics as the other setters so
   * directive ordering relative to subscribe doesn't matter.
   */
  setVersionOverride(sessionId: string, version: string): void {
    const render = this.create(sessionId, 'conformance');
    render.versionOverride = version;
  }

  /**
   * Assign the next outbound stream sequence for the named render —
   * advances {@link GguiSession.streamSeq} and returns the new value
   * (first assignment = 1). Called by the `emit-envelope`
   * ConformanceHost directive when stamping the `StreamEnvelope` it
   * injects. Sequence assignment is emission-scoped, not
   * delivery-scoped: a frame emitted with zero subscribers attached
   * still consumes its sequence number, mirroring buffer-backed
   * servers that assign `seq` at append time regardless of who is
   * connected.
   *
   * Same "create-if-missing" semantics as the other setters so
   * directive ordering relative to subscribe doesn't matter.
   */
  nextStreamSeq(sessionId: string): number {
    const render = this.create(sessionId, 'conformance');
    render.streamSeq += 1;
    return render.streamSeq;
  }

  /**
   * Fan out a frame to every subscriber on the named render. Used by
   * the `emit-envelope` ConformanceHost directive — kit fixtures use
   * it to inject WS-observable side-effects (envelopes the server
   * would not normally emit on its own) so the kit can assert
   * downstream consequences (sequencing, fan-out).
   *
   * Returns `true` if the GguiSession existed and at least one subscriber
   * received the frame; `false` if the GguiSession is unknown OR has no
   * subscribers attached. Caller may use the boolean to log a warning
   * when a fixture's directive-injection lands before any subscribe
   * — the directive then has no observable effect, which is usually
   * a fixture-authoring bug worth surfacing.
   *
   * Subscriber-level send failures (closed socket, etc.) are
   * swallowed — one bad subscriber must not block fan-out to the
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
