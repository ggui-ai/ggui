/**
 * SessionStore — persistent + observable session state.
 *
 * Session management is a first-class product concern (lifecycle,
 * live events, cross-device sync, privacy), not plumbing. This
 * interface preserves those semantics across hosted and OSS.
 *
 * Reference implementations:
 *   - InMemorySessionStore      (tests, dev)
 *   - SqliteSessionStore        (OSS default; SSE fanout via in-process EventEmitter)
 *   - PostgresSessionStore      (optional; LISTEN/NOTIFY fanout)
 *   - DynamoSessionStore        (hosted runtime; AppSync subscriptions)
 */
import type {
  HostContextProjection,
  Session,
  SessionStackEntry,
} from '@ggui-ai/protocol';

/**
 * Typed session event. Append-only. Every event carries a monotonic `seq`
 * that is gap-free within a single session, starting at 1.
 */
export interface SessionEvent {
  seq: number;
  type: SessionEventType;
  timestamp: number;
  /** Event-type-specific payload. Discriminate on `type` at the consumer. */
  data: unknown;
}

/**
 * Canonical event-type taxonomy. Implementations MUST emit events for the
 * core types; custom types may be added with a `x-` or `ext:` prefix.
 */
export type SessionEventType =
  | 'ui.created'
  | 'ui.updated'
  | 'ui.committed'
  | 'tool.called'
  | 'tool.result'
  | 'user.submitted'
  | 'session.closed';

/**
 * Options for {@link SessionStore.observe}.
 */
export interface ObserveOptions {
  /**
   * First sequence number to deliver. Default: `1` (replay from beginning).
   * On reconnect, pass `lastSeen + 1`.
   */
  fromSeq?: number;
  /**
   * Whether to keep the stream open after historical replay. Default: `true`.
   * Set `false` for a one-shot snapshot fetch.
   */
  tail?: boolean;
}

/**
 * Input for {@link SessionStore.create}.
 */
export interface CreateSessionInput {
  appId: string;
  userId?: string;
  /**
   * Optional deterministic session id. Implementations that can honor
   * caller-provided ids SHOULD use this when present; implementations that
   * only generate ids (DDB auto-pk, UUID-on-insert, etc.) MAY ignore it
   * and assign their own.
   *
   * Motivating case: OSS live-channel `subscribe` messages provide the
   * sessionId the client wants to join, so the server can be idempotent
   * on reconnect without round-tripping through a separate mint step.
   */
  id?: string;
  /**
   * Optional structured authenticated end-user identity, populated by
   * the auth gate before the session is materialized. When supplied,
   * implementations MUST persist it as-is and surface it on
   * subsequent `get()` calls.
   *
   * Cloud's dynamoSessionStore reads this via a separate auth-gate
   * write path today; threading it through `create()` here unifies
   * the surface and enables the conformance suite to pin round-trip
   * parity uniformly across impls.
   */
  endUserIdentity?: import('@ggui-ai/protocol').EndUserIdentity;
  /** Optional initial metadata — region, residency, market, etc. */
  metadata?: Record<string, unknown>;
  /**
   * Theme preset id for this chat-scoped session — sits at layer 2 of
   * the bootstrap-meta theme-resolution chain (stack-item explicit >
   * session.themeId > App.defaultThemeId > server fallback). Sourced
   * from `ggui_new_session`'s `themeId?` input or the per-app
   * `App.defaultThemeId` default. Persisted across restart by stores
   * that survive restart (sqlite, dynamo); ephemeral on the in-memory
   * reference.
   */
  themeId?: string;
  /**
   * Host-supplied session-grouping slice, parsed from the inbound
   * `tools/call` request's `_meta["ai.ggui/host-session"]`. Set ONCE
   * at session creation (the first call materializing this row);
   * subsequent calls naming the same session id MUST NOT update it.
   *
   * Captures opt-in host identity for later rehydration via
   * `ggui_list_sessions(hostName, hostSessionId)`. Implementations
   * MUST persist both fields together on stores that survive restart;
   * the in-memory reference holds it for the process lifetime only.
   * Absent on legacy rows (pre-slice) — those sessions are
   * non-rehydratable by design.
   */
  hostSession?: {
    readonly hostName: string;
    readonly hostSessionId: string;
  };
}

/**
 * Filter for {@link SessionStore.list}.
 */
export interface SessionFilter {
  appId?: string;
  userId?: string;
  status?: 'active' | 'completed' | 'expired';
  createdAfter?: number;
  createdBefore?: number;
  limit?: number;
  cursor?: string;
  /**
   * Filter by the host that created the session — paired with
   * {@link hostSessionId} for full-key lookups, or used alone to list
   * every session a given host has ever opened against this app.
   * Powers the `ggui_list_sessions` tool's host-scoped resume flow.
   */
  hostName?: string;
  /**
   * Filter by the host-supplied grouping key. Typically paired with
   * {@link hostName} so the same host-side id across two different
   * hosts cannot alias. Matches the persisted slice from
   * {@link CreateSessionInput.hostSession}; sessions without a host
   * slice never match (one-shot rows are non-rehydratable).
   */
  hostSessionId?: string;
}

/**
 * Patch shape for {@link SessionStore.update}. Partial; only fields present
 * are updated. Writing an event is NOT done through `update` — use
 * `appendEvent`.
 */
export interface SessionPatch {
  lastActivityAt?: number;
  expiresAt?: number;
  metadata?: Record<string, unknown>;
  /**
   * Latest host-context projection echoed by the iframe-runtime.
   * Wire path: client →
   * `host_context_observed` live-channel message → server inbound
   * handler → `update(sessionId, { hostContext })` → persisted on
   * `Session.hostContext`. Idempotent overwrite; merge logic lives
   * client-side in `host-context-emitter`.
   */
  hostContext?: HostContextProjection;
  /**
   * Updated on every `canvas_navigated`
   * inbound envelope to the new top of the iframe's NavStackModel.
   * Pass `null` to clear (user popped to empty nav stack).
   */
  activeStackItemId?: string | null;
}

/**
 * Append-only event writer. Returns the assigned `seq`.
 * Implementations MUST ensure `seq` is monotonic + gap-free per session.
 */
export interface AppendEventInput {
  sessionId: string;
  type: SessionEventType;
  data: unknown;
}

export interface SessionStore {
  create(input: CreateSessionInput): Promise<Session>;
  get(id: string): Promise<Session | null>;
  list(filter: SessionFilter): Promise<Session[]>;
  update(id: string, patch: SessionPatch): Promise<Session>;
  delete(id: string): Promise<void>;

  /**
   * Upsert a stack entry by `entry.id`, update `currentStackIndex` to
   * point at the affected slot, and return the updated Session.
   *
   * Behavior:
   *
   *   - If no existing entry has the same `id`, the entry is appended
   *     to the tail and `currentStackIndex` is set to the new last
   *     index — plain append semantics.
   *   - If an existing entry already has the same `id`, the entry
   *     replaces it IN PLACE (preserving its position in the stack)
   *     and `currentStackIndex` is set to that existing index.
   *
   * Why upsert instead of strict append: ggui_push fires a placeholder
   * stack item synchronously so the live renderer has a surface to
   * paint provisional-preview frames into; when generation later
   * settles, the SAME `stackItemId` is reused to commit the authoritative
   * componentCode. Strict-append would have produced two stack entries
   * with the same id — a violation of the implicit "ids are unique"
   * invariant the iframe-runtime's `StackModel.upsert` already
   * enforces on the consumer side. Aligning the producer with the
   * consumer keeps the wire shape coherent.
   *
   * Implementations MUST preserve FIFO ordering for first-write
   * appends. The replace path SHOULD NOT shift other entries — that's
   * what makes it an in-place update. Time-of-replace mutations to
   * `lastActivityAt` are still required (the session is being mutated).
   */
  appendStackItem(
    sessionId: string,
    entry: SessionStackEntry,
  ): Promise<Session>;

  /**
   * Remove the top entry from a session's stack. Returns `{poppedId,
   * stackSize}` reflecting state AFTER the pop.
   *
   * Behavior:
   *
   *   - Empty stack: no-op, returns `{poppedId: null, stackSize: 0}`.
   *     Empty stack is NOT an error — `ggui_pop` is idempotent at the
   *     bottom.
   *   - Non-empty stack: removes `stack[stack.length - 1]`, decrements
   *     `currentStackIndex` by one (clamped to 0 minimum), removes the
   *     popped item's entry from the stackItemId secondary index,
   *     bumps `lastActivityAt`. Returns the popped item's id +
   *     post-pop stack length.
   *
   * Implementations MUST refuse to pop from a closed session
   * (symmetric with `appendStackItem`'s closed-session reject).
   * Returning `{poppedId: null, stackSize}` on a closed session would
   * be ambiguous with empty-stack — throw instead.
   */
  popStackItem(
    sessionId: string,
  ): Promise<{ readonly poppedId: string | null; readonly stackSize: number }>;

  /**
   * O(1) reverse lookup — map a globally-unique stack-item id (`stackItemId`)
   * back to its owning session. Implementations MUST maintain this index
   * incrementally inside `appendStackItem` (insert / replace on upsert)
   * and `delete` (remove every entry whose sessionId matches).
   *
   * Used by `ggui_update`, where the agent passes only `stackItemId` (no
   * sessionId) and the handler has to resolve the owning session +
   * tenancy-check before patching props. Returns `null` when:
   *
   *   - The stackItemId never existed (typo, fabricated, replay from a
   *     different deployment), OR
   *   - The owning session was deleted (cascading sweep should have
   *     removed the index entry already), OR
   *   - The stackItemId belongs to a different appId than the caller (the
   *     handler MAY treat this case identically to "not found" to
   *     avoid leaking cross-tenant existence).
   *
   * The returned shape carries `appId` so the caller can tenancy-gate
   * without a second `get(sessionId)` round-trip — common path is
   * compare-then-load.
   */
  getSessionByStackItemId(
    stackItemId: string,
  ): Promise<{ readonly sessionId: string; readonly appId: string } | null>;

  /** Write a new event and return the assigned `seq`. */
  appendEvent(input: AppendEventInput): Promise<number>;

  /**
   * List events for a session with `seq > sinceSeq`, capped at `limit`.
   *
   * Backs the R7 `GET /api/sessions/:id/events?sinceSequence=N&limit=M`
   * HTTP endpoint and the WS-subscribe `sinceSequence` cursor replay
   * (`SubscribePayload.sinceSequence`). Returns `{events, lastSequence,
   * hasMore, horizonSeq}` where:
   *
   *   - `events` — strictly ascending by `seq`, only entries with
   *     `seq > sinceSeq`, up to `limit` items.
   *   - `lastSequence` — the session's current high-water mark
   *     (`Session.eventSequence`) regardless of pagination. Clients use
   *     this to advance their cursor on empty pages.
   *   - `hasMore` — `true` when the page was truncated by `limit`.
   *   - `horizonSeq` — the lowest `seq` the implementation can still
   *     replay (events with `seq <= horizonSeq` have been evicted from
   *     the bounded retention window). `0` means "no horizon — full
   *     history is replayable since session creation". A caller's
   *     `sinceSeq < horizonSeq` MUST be treated as
   *     REPLAY_HORIZON_PASSED.
   *
   * Returns `null` when the session does not exist (404-equivalent;
   * distinct from an empty `events[]` page on a live session).
   *
   * Implementations MUST honor `limit` strictly — even if more events
   * are available, `events.length <= limit`.
   */
  listEventsSince(
    sessionId: string,
    sinceSeq: number,
    limit: number,
  ): Promise<{
    readonly events: readonly SessionEvent[];
    readonly lastSequence: number;
    readonly hasMore: boolean;
    readonly horizonSeq: number;
  } | null>;

  /**
   * Subscribe to the append-only event stream for a session.
   *
   * **Normative semantics** (every implementation MUST satisfy these):
   *
   * - **Snapshot + tail.** Default: replay all historical events in order
   *   (from `opts.fromSeq`, default 1), then yield new events as written.
   *   `tail: false` stops after historical replay.
   *
   * - **Ordering.** FIFO within a single session. `seq` is monotonic and
   *   gap-free starting at 1. No ordering guarantee across sessions.
   *
   * - **Reconnect / resume.** Consumers track the last `seq` they processed
   *   and pass `fromSeq` on reconnect to resume without full replay.
   *   Delivery is at-least-once; consumers MUST dedupe by `seq`.
   *
   * - **Stream shape.** Append-only typed events, NOT state-change diffs.
   *   Consumers reconstruct current state by folding events.
   *
   * - **Close.** The iterable ends cleanly when the session is closed (the
   *   terminal `session.closed` event is emitted first) or when the consumer
   *   disposes. No indefinite hang on a closed session.
   */
  observe(id: string, opts?: ObserveOptions): AsyncIterable<SessionEvent>;
}
