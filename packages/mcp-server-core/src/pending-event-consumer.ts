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
 * A hosted deployment's durable implementation conforms to the same
 * shape with an atomic per-render fetch-and-clear on its own store.
 *
 * The consumer is a pending-events surface, NOT the append-only
 * event log on `GguiSessionStore.appendEvent`/`observe`. Those are two
 * different streams — the buffer here gets cleared on every consume
 * (queue semantics) while the event log is append-only retained.
 */

import {
  type GguiSessionStatus,
  type PendingEvent,
  pendingEventSchema,
} from '@ggui-ai/protocol';

/**
 * Result envelope from a single `consumeAndClear` call.
 *
 * `events` are the rows buffered at clear time, each the protocol's
 * `PendingEvent` (ggui#839). The contract on this boundary: `consumeAndClear`
 * MUST NOT return a row that fails `pendingEventSchema`, and MUST NOT drop a
 * well-formed row because a sibling failed. Each adapter meets it in the
 * form its store allows — see the MUST list on {@link PendingEventConsumer}.
 *
 * `status` carries the pipe's lifecycle phase. The handler's long-
 * poll loop terminates on `'expired'` (TTL elapsed) — the pipe
 * surfaces the same status the underlying render reports.
 */
export interface PendingEventConsumeResult {
  readonly events: ReadonlyArray<PendingEvent>;
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
 *   - Validate every appended row through {@link parsePendingEventRow}
 *     before storing it (ggui#839) — a row that fails refuses the append
 *     with {@link PendingEventMalformedError}: the producer's own
 *     violation, surfaced to the producer; nothing is stored.
 *   - Never return a drained row that fails `pendingEventSchema`, and
 *     never drop a well-formed row because a sibling failed. The form
 *     follows the store: a TRANSACTIONAL drain (sqlite) parses inside the
 *     transaction and refuses the drain whole — rollback, nothing cleared,
 *     `PendingEventMalformedError` thrown, so the failure stays visible on
 *     every consume of that session; a DESTRUCTIVE drain (DynamoDB, where
 *     read and clear are one write) quarantines PER ROW — the malformed row
 *     is logged as `pending_event_malformed` (sessionId, id, issues, the raw
 *     row) and the well-formed siblings are delivered; the in-memory
 *     adapter holds the typed struct it validated on append and parses
 *     nothing on drain. The published contract-tests suite
 *     (`runPendingEventStoreBoundaryConformance`) is the observable form.
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
   * IDEMPOTENCY (ggui#405): `event.id` is a non-empty string (the
   * protocol's `pendingEventSchema`), and append MUST be idempotent per
   * `(sessionId, event.id)` for the pipe's LIFETIME — a duplicate append is a silent no-op, including
   * after the original entry was drained by `consumeAndClear`. This is
   * what makes transport-level retries of `ggui_runtime_submit_action`
   * safe: a relay that lost the RESPONSE (but whose request was
   * delivered) can replay without double-firing the user's gesture.
   * NOTE: the WS ingress DOES pass an id today — but mints it server-side per call
   * (`randomBytes(4)`, action-ingress.ts), so for WS-ingressed entries
   * this idempotency is structurally satisfied and semantically inert:
   * a re-fired gesture gets a fresh id and a fresh row. Gesture-stable
   * WS dedup requires the client-minted `actionId` on the wire
   * envelope (ggui#599 leg 2).
   *
   * @throws when the pipe row doesn't exist.
   */
  append(sessionId: string, event: PendingEvent): Promise<void>;

  /**
   * Open a pipe for `sessionId` so subsequent `append` /
   * `consumeAndClear` calls work. Optional on the interface because
   * an adapter may open the pipe through another write entirely: the
   * cloud Dynamo adapter's pipe row IS the session row, opened by the
   * render-row write — its `append` is guarded by
   * `attribute_exists(id)` and THROWS on an absent row (it does NOT
   * upsert; ggui#599 cycle-2 corrected the earlier "upsert semantics"
   * claim here). OSS impls (InMemory / Sqlite) MUST implement it.
   *
   * FUTURE-BRIDGE PINS (ggui#599 cycle-2 — obligations any slice that
   * threads a caller-supplied consumer into the WS action ingress must
   * discharge first): (1) SIZE — this contract names no entry-size
   * bound; the WS channel accepts frames far larger than some backing
   * rows can absorb, and an oversized append that fails after the
   * ledger write produced a full ack to the client (the lying-ack
   * class). Define the cap + failure mode before bridging. (2)
   * ATOMICITY — ledger and pipe are separate writes with no cross-
   * write transaction; enumerate the partial-failure states in the
   * bridging slice.
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
 * A hosted deployment has its own equivalent; the handlers compare by
 * the `name` field so no peer dependency on any one implementation is
 * needed.
 */
export class PendingPipeNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`pending-event pipe not found for render: ${sessionId}`);
    this.name = 'PendingPipeNotFoundError';
  }
}

/** One reason a stored row failed `pendingEventSchema` — the failing path and the schema's message. */
export interface PendingEventIssue {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly message: string;
}

/**
 * A row that fails the protocol's `pendingEventSchema` (ggui#839). Thrown by
 * `append` before anything is stored — the producer's own violation — and
 * by a TRANSACTIONAL drain (`consumeAndClear` on sqlite), which refuses the
 * drain whole and rolls back: nothing cleared, so the failure stays visible
 * on every consume of that session. A DESTRUCTIVE drain (DynamoDB) never
 * throws it on drain — it quarantines the row and logs
 * `pending_event_malformed`. Carries `sessionId`, the row's `id` when it was
 * readable, and the schema's issues. Detect by `name`, like
 * {@link PendingPipeNotFoundError}.
 */
export class PendingEventMalformedError extends Error {
  readonly sessionId: string;
  /** The row's `id`, when the malformed row carried a readable one. */
  readonly rowId: string | undefined;
  readonly issues: ReadonlyArray<PendingEventIssue>;
  constructor(
    sessionId: string,
    issues: ReadonlyArray<PendingEventIssue>,
    rowId?: string,
  ) {
    super(
      `pending-event row${rowId === undefined ? '' : ` ${rowId}`} for session ${sessionId} fails pendingEventSchema: ${issues
        .map((issue) => `${issue.path.map(String).join('.') || '(row)'}: ${issue.message}`)
        .join('; ')}`,
    );
    this.name = 'PendingEventMalformedError';
    this.sessionId = sessionId;
    this.rowId = rowId;
    this.issues = issues;
  }
}

/**
 * `name`-detection of {@link PendingEventMalformedError}, like the
 * `PendingPipeNotFoundError` pattern: a structurally identical class from
 * another copy of this package matches too.
 */
export function isPendingEventMalformedError(err: unknown): err is PendingEventMalformedError {
  return err instanceof Error && err.name === 'PendingEventMalformedError';
}

/** The row's `id` when the unparsed row is an object carrying a non-empty string there. */
function readableRowId(row: unknown): string | undefined {
  if (typeof row !== 'object' || row === null || !('id' in row)) return undefined;
  return typeof row.id === 'string' && row.id.length > 0 ? row.id : undefined;
}

/**
 * Parse one row at the store boundary: every adapter calls this on each
 * row it accepts on `append` (before storing it), and an adapter that reads
 * rows back from a serialization (a JSON column, an unmarshalled item) calls
 * it again on each drained row. The row arrives as whatever the producer or
 * the store handed over and leaves as the protocol's `PendingEvent` — or
 * throws {@link PendingEventMalformedError}, naming the row when its `id`
 * was readable.
 */
export function parsePendingEventRow(sessionId: string, row: unknown): PendingEvent {
  const parsed = pendingEventSchema.safeParse(row);
  if (!parsed.success) {
    throw new PendingEventMalformedError(sessionId, parsed.error.issues, readableRowId(row));
  }
  return parsed.data;
}
