/**
 * `PendingEventConsumer` — atomic fetch-and-clear contract for the
 * pending-events buffer that backs `ggui_consume`.
 *
 * **Keying is `stackItemId`-scoped** (Model C, 2026-05-12). Each
 * pushed UI surface (`ggui_push` mints a `stackItemId`) gets its own
 * pipe: opened by `markCreated(stackItemId)` at push time, written
 * by `append(stackItemId, event)` from `ggui_runtime_submit_action`
 * dispatch envelopes, drained by `consumeAndClear(stackItemId)` from
 * `ggui_consume`, and closed by `markDeleted(stackItemId)` on
 * `ggui_pop` / `ggui_close`.
 *
 * Why stackItemId, not sessionId — two stack items in the same
 * session can each have unconsumed events; sessionId-keyed pipes
 * would let one consumer's drain swallow the other's events. The
 * stackItemId surface matches MCP Apps' "one back-channel per
 * rendered widget" mental model and avoids cross-talk.
 *
 * **Lifecycle**:
 *
 *   1. `ggui_push` mints stackItemId → handler calls `markCreated`
 *      so events queued BEFORE the agent's first `ggui_consume`
 *      land in the pipe (the user can click before the agent
 *      starts polling).
 *   2. iframe-runtime fires `ggui_runtime_submit_action` (kind:'dispatch')
 *      → handler calls `append`. The runtime tags the envelope with
 *      `stackItemId` sourced from its `_meta.ggui.bootstrap`.
 *   3. `ggui_consume({stackItemId, timeout})` blocks; long-poll loop
 *      calls `consumeAndClear` until events arrive OR status flips
 *      to `'completed'` OR `timeout` elapses.
 *   4. `ggui_pop` / `ggui_close` → `markDeleted` so subsequent ops
 *      throw `PendingPipeNotFoundError` (the long-poll loop sees
 *      that as terminal and returns).
 *
 * Two implementations ship with `@ggui-ai/mcp-server-core`:
 *   - {@link InMemoryPendingEventConsumer} — OSS dev/test path.
 *   - {@link SqlitePendingEventConsumer}   — OSS persistent path.
 *
 * Cloud's `DynamoPendingEventConsumer` (in `cloud/ggui-protocol-pod`)
 * conforms to the same shape via DDB `UpdateItem` with
 * `RETURN_VALUES=ALL_OLD` for atomic per-stackItem fetch-and-clear.
 *
 * The consumer is a pending-events surface, NOT the append-only
 * event log on `SessionStore.appendEvent`/`observe`. Those are two
 * different streams — the buffer here gets cleared on every consume
 * (queue semantics) while the event log is append-only retained.
 */

import type { SessionStatus } from '@ggui-ai/protocol';

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
 * poll loop terminates on `'completed'` (pipe closed via `markDeleted`
 * or `markStatus('completed')`).
 */
export interface PendingEventConsumeResult {
  readonly events: ReadonlyArray<Record<string, unknown>>;
  readonly status: SessionStatus;
}

/**
 * The contract.
 *
 * Implementations MUST:
 *   - Serialize `consumeAndClear` per `stackItemId` so concurrent
 *     consumers can't each see the same buffered events. Cloud
 *     achieves this via DDB UpdateItem; in-memory uses a per-stack
 *     mutex; sqlite uses a transaction.
 *   - Bump the pipe's activity / expiry on every successful consume
 *     by `ttlMs`. The handler passes the resolved session-TTL value.
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
   * Fetch every buffered pending event for `stackItemId`, clear the
   * buffer, bump the pipe's last-activity heartbeat by `ttlMs`, and
   * return what was there at clear time. Atomic.
   *
   * @throws when the pipe row doesn't exist (typically a
   *   `PendingPipeNotFoundError`).
   */
  consumeAndClear(
    stackItemId: string,
    ttlMs: number,
  ): Promise<PendingEventConsumeResult>;

  /**
   * Append `event` to a stack item's pending-events buffer.
   *
   * Used by `ggui_runtime_submit_action` (and any other producer of
   * agent-bound events) to enqueue a row that the next
   * `consumeAndClear` will surface. Implementations MUST serialize
   * appends per-`stackItemId` so concurrent producers don't lose
   * events; ordering within a single stackItem is FIFO.
   *
   * @throws when the pipe row doesn't exist.
   */
  append(
    stackItemId: string,
    event: Record<string, unknown>,
  ): Promise<void>;

  /**
   * Open a pipe for `stackItemId` so subsequent `append` /
   * `consumeAndClear` calls work. Optional on the interface because
   * the cloud Dynamo adapter implicitly opens via UpdateItem upsert
   * semantics and doesn't expose a separate creation path; OSS
   * impls (InMemory / Sqlite) MUST implement it.
   *
   * Idempotent — calling on an existing pipe is a no-op.
   *
   * The `ggui_push` handler calls this at stackItemId mint time so
   * gesture appends from `ggui_runtime_submit_action` (which can land
   * BEFORE the agent's first `ggui_consume`) don't get lost.
   */
  markCreated?(stackItemId: string, ttlMs?: number): void;

  /**
   * Flip the pipe's observed status — typically to `'completed'` so
   * the consume long-poll loop short-circuits. Optional for the same
   * reason as `markCreated`.
   */
  markStatus?(stackItemId: string, status: SessionStatus): void;

  /**
   * Close + remove the pipe. Subsequent ops throw
   * `PendingPipeNotFoundError`. Called by `ggui_pop` / `ggui_close`
   * to release pipe resources.
   */
  markDeleted?(stackItemId: string): void;
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
  constructor(stackItemId: string) {
    super(`pending-event pipe not found for stack item: ${stackItemId}`);
    this.name = 'PendingPipeNotFoundError';
  }
}

