/**
 * `PendingEventConsumer` — atomic fetch-and-clear contract for the
 * pending-events buffer that backs `ggui_consume`.
 *
 * **Keying is `sessionId`-scoped.** Each rendered UI surface
 * (`ggui_render` mints a `sessionId`) gets its own pipe: opened by
 * `markCreated(sessionId)` at render time, written by
 * `append(sessionId, event)` from `ggui_runtime_submit_action`
 * dispatch envelopes AND from the live channel's WS `data:submit`
 * action ingress (both project onto the same `ConsumeEventEntry`
 * shape), drained by `consumeAndClear(sessionId)` from `ggui_consume`.
 *
 * Per-render keying (rather than per-conversation) means two renders
 * in the same host conversation can each have unconsumed events
 * without one consumer's drain swallowing the other's. The sessionId
 * surface matches MCP Apps' "one back-channel per rendered widget"
 * mental model.
 *
 * **Lifecycle**:
 *
 *   1. `ggui_render` mints sessionId → handler calls `markCreated`
 *      so events queued BEFORE the agent's first `ggui_consume`
 *      land in the pipe (the user can click before the agent
 *      starts polling).
 *   2. iframe-runtime fires `ggui_runtime_submit_action` (kind:'dispatch')
 *      → handler calls `append`. The runtime tags the envelope with
 *      `sessionId` sourced from its `_meta.ggui.bootstrap`.
 *   3. `ggui_consume({sessionId, timeout})` blocks; long-poll loop
 *      calls `consumeAndClear` until events arrive OR `timeout`
 *      elapses. GguiSession TTL eventually reaps the pipe; subsequent
 *      ops throw `PendingPipeNotFoundError`, which the handler
 *      treats as the loop-terminating signal.
 *
 * Two implementations ship with `@ggui-ai/mcp-server-core`:
 *   - {@link InMemoryPendingEventConsumer} — OSS dev/test path.
 *   - {@link SqlitePendingEventConsumer}   — OSS persistent path.
 *
 * Cloud's `DynamoPendingEventConsumer` (in `cloud/ggui-protocol-pod`)
 * conforms to the same shape via DDB `UpdateItem` with
 * `RETURN_VALUES=ALL_OLD` for atomic per-render fetch-and-clear.
 *
 * The consumer is a pending-events surface, NOT the append-only
 * event log on `GguiSessionStore.appendEvent`/`observe`. Those are two
 * different streams — the buffer here gets cleared on every consume
 * (queue semantics) while the event log is append-only retained.
 */

import type { GguiSessionStatus } from '@ggui-ai/protocol';

/**
 * Result envelope from a single `consumeAndClear` call.
 *
 * `events` is whatever was buffered at clear time. The handler
 * coerces each entry to a canonical `PendingEvent` shape downstream;
 * this interface keeps the row shape opaque so adapters that
 * marshal differently (DDB unmarshall, JSON column read, in-memory
 * struct) stay free to do so.
 *
 * `status` carries the pipe's lifecycle phase. The handler's long-
 * poll loop terminates on `'expired'` (TTL elapsed) — the pipe
 * surfaces the same status the underlying render reports.
 */
export interface PendingEventConsumeResult {
  readonly events: ReadonlyArray<Record<string, unknown>>;
  readonly status: GguiSessionStatus;
}

/**
 * The contract.
 *
 * Implementations MUST:
 *   - Serialize `consumeAndClear` per `sessionId` so concurrent
 *     consumers can't each see the same buffered events. Cloud
 *     achieves this via DDB UpdateItem; in-memory uses a per-render
 *     mutex; sqlite uses a transaction.
 *   - Bump the pipe's activity / expiry on every successful consume
 *     by `ttlMs`. The handler passes the resolved render-TTL value.
 *   - Throw {@link PendingPipeNotFoundError} (or a structurally-
 *     equivalent class with `name === 'PendingPipeNotFoundError'`)
 *     when the pipe row is gone — distinguishes "no events buffered"
 *     (empty array, status active) from "pipe was reaped mid-poll".
 *   - Report `events: []` + a stable `status` when the pipe
 *     exists but has nothing buffered. This is the long-poll's
 *     baseline check.
 *
 * Implementations MAY emit additional metadata via the result by
 * extending `PendingEventConsumeResult`; downstream handlers
 * consume the narrow shape via this base type.
 */
export interface PendingEventConsumer {
  /**
   * Fetch every buffered pending event for `sessionId`, clear the
   * buffer, bump the pipe's last-activity heartbeat by `ttlMs`, and
   * return what was there at clear time. Atomic.
   *
   * @throws when the pipe row doesn't exist (typically a
   *   `PendingPipeNotFoundError`).
   */
  consumeAndClear(
    sessionId: string,
    ttlMs: number,
  ): Promise<PendingEventConsumeResult>;

  /**
   * Append `event` to a render's pending-events buffer.
   *
   * Used by `ggui_runtime_submit_action` (and any other producer of
   * agent-bound events) to enqueue a row that the next
   * `consumeAndClear` will surface. Implementations MUST serialize
   * appends per-`sessionId` so concurrent producers don't lose
   * events; ordering within a single render is FIFO.
   *
   * @throws when the pipe row doesn't exist.
   */
  append(
    sessionId: string,
    event: Record<string, unknown>,
  ): Promise<void>;

  /**
   * Open a pipe for `sessionId` so subsequent `append` /
   * `consumeAndClear` calls work. Optional on the interface because
   * the cloud Dynamo adapter implicitly opens via UpdateItem upsert
   * semantics and doesn't expose a separate creation path; OSS
   * impls (InMemory / Sqlite) MUST implement it.
   *
   * Idempotent — calling on an existing pipe is a no-op.
   *
   * The `ggui_render` handler calls this at sessionId mint time so
   * gesture appends from `ggui_runtime_submit_action` (which can land
   * BEFORE the agent's first `ggui_consume`) don't get lost.
   */
  markCreated?(sessionId: string, ttlMs?: number): void;

  /**
   * Flip the pipe's lifecycle status without consuming events. Lets
   * tests + handler-side close paths transition a render into a
   * terminal state (`'expired'`) so the next `consumeAndClear`
   * short-circuits its long-poll loop and returns the new status to
   * the caller.
   *
   * Optional on the interface for the same reason as `markCreated`:
   * cloud's Dynamo adapter writes status via UpdateItem upserts and
   * doesn't surface a separate setter. OSS impls (InMemory / Sqlite)
   * MUST implement it.
   *
   * No-op when the pipe doesn't exist — callers shouldn't need to
   * guard a status flip against a vanished render.
   */
  markStatus?(sessionId: string, status: GguiSessionStatus): void;

  /**
   * Tear down the pipe for `sessionId`. Subsequent `append` /
   * `consumeAndClear` calls MUST throw {@link PendingPipeNotFoundError}
   * exactly as if the pipe had never been opened. Used by paired
   * close paths (handler-side cleanup, render-close races) and by
   * tests that simulate mid-poll pipe disappearance.
   *
   * Optional on the interface for the same reason as `markCreated`:
   * cloud's Dynamo adapter relies on TTL-based reaping and doesn't
   * expose explicit deletion. OSS impls (InMemory / Sqlite) MUST
   * implement it.
   *
   * Idempotent — deleting a non-existent pipe is a no-op.
   */
  markDeleted?(sessionId: string): void;
}

/**
 * Sentinel error class shape. Implementations either throw THIS
 * class or one structurally identical (with `name ===
 * 'PendingPipeNotFoundError'`); consumers detect via `instanceof`
 * or `name` check, whichever is convenient.
 *
 * Cloud has its own equivalent in `cloud/ggui-protocol-pod`; OSS
 * handlers compare by `name` field to avoid a peer-dep on the cloud
 * package.
 */
export class PendingPipeNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`pending-event pipe not found for render: ${sessionId}`);
    this.name = 'PendingPipeNotFoundError';
  }
}

