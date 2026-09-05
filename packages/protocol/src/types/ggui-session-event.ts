import type { z } from 'zod';
import type { runtimePullEventsPageSchema } from '../schemas/mcp';
import type { DeepReadonly } from './readonly';
/**
 * GguiSessionEvent ledger — wire-frame replay primitives (R7).
 *
 * Core protocol-layer types backing the unified cursor-replay model.
 * The same ledger is read by:
 *
 *   - `GET /api/sessions/:sessionId/events?sinceSequence=N&limit=M` —
 *     HTTP cursor-replay endpoint; polling clients walk it on a
 *     2s tick.
 *   - WS `subscribe` with `SubscribePayload.sinceSequence` — server
 *     replays events with `seq > sinceSequence` as `render_event`
 *     wire frames BEFORE entering live-stream mode.
 *
 * Two transports, same cursor — switching transports does not lose
 * events.
 *
 * # Why this is core (not an integration)
 *
 * GguiSessionEvent is the wire-frame ledger shape — the structural unit
 * the live-channel transport replays. It sits at the same layer as
 * other transport-level types (`StreamEnvelope`, `AckPayload`). It is
 * NOT an MCP-Apps-integration-specific concept — it's the protocol's
 * primary durable cursor primitive, equally consumed by the
 * `@ggui-ai/iframe-runtime` polling layer and any non-MCP-Apps host.
 *
 * # Source of truth
 *
 * This is the canonical definition. The server-side `GguiSessionStore`
 * seam in `@ggui-ai/mcp-server-core` re-exports these types so
 * implementors (in-memory, sqlite, dynamo) all bind to the same
 * shape. Wave 7 (flatten-render-identity, 2026-05-28): merged the
 * earlier protocol-side `SessionEvent` (sequence + emittedAt + type +
 * payload) into the server-side GguiSessionEvent shape (seq + timestamp +
 * type + data); one ledger primitive everywhere. `timestamp` carries
 * an ISO 8601 UTC string for cross-layer uniformity (was epoch-ms on
 * the server side).
 */

/**
 * Append-only ledger event for one GguiSession. Each event carries a
 * monotonic `seq` that is gap-free within a single GguiSession, starting
 * at 1.
 *
 * Discriminator is `type`; `data` is type-specific and structurally
 * identical to the matching live-channel wire frame's payload.
 * Consumers fold events into local state by dispatching to the
 * registered handler for `event.type`.
 *
 * @public
 */
export interface GguiSessionEvent<TData = unknown> {
  /**
   * Monotonic, gap-free per render. Starts at 1 for the first event;
   * `0` is the sentinel for "no events yet" / fresh subscriber.
   */
  readonly seq: number;
  /**
   * Wire-frame type. The canonical taxonomy lives at
   * {@link GguiSessionEventType} for type-discrimination ergonomics;
   * keeping the field as a plain string lets first-party servers mint
   * new types without a protocol bump.
   */
  readonly type: string;
  /** ISO 8601 UTC timestamp the server stamped on emission. */
  readonly timestamp: string;
  /**
   * Type-specific payload — structurally identical to the matching
   * live-channel frame's payload. Typed at the consumer via
   * discriminating `event.type` before reading.
   */
  readonly data: TData;
}

/**
 * Canonical event-type taxonomy. Implementations MUST emit events for
 * the core types; custom types may be added with a `x-` or `ext:`
 * prefix.
 *
 * No terminal event. Renders decay implicitly via TTL — there is no
 * `'session.closed'` / `'render.terminated'` literal because there is
 * no terminal write to make. Observers detect end-of-life by
 * `expiresAt` elapsing relative to wall-clock.
 *
 * @public
 */
export type GguiSessionEventType =
  | 'ui.created'
  | 'ui.updated'
  | 'ui.committed'
  | 'ui.reminted'
  | 'tool.called'
  | 'tool.result'
  | 'user.submitted';

/**
 * Payload of a `'ui.reminted'` event — the epoch transition record
 * (#483). Appended ONLY by `ggui_update` (never `ggui_amend`, never a
 * no-op update): the session head advanced to a NEW epoch-numbered
 * render record at this seq.
 *
 * `epoch` is the number the head advanced TO (the first update after
 * render appends `{epoch: 1}`). Epochs are LEDGER-DERIVED — there is
 * no counter field on the session row; the count of reminted events
 * at a seq IS the epoch at that seq (see
 * {@link deriveEpochFromEvents}). Frames freeze when they observe a
 * reminted event whose `epoch` exceeds the epoch in their own
 * resource URI (the #483 freeze latch).
 */
export interface UiRemintedEventData {
  readonly epoch: number;
}

/**
 * Payload of a `'ui.updated'` event — the ledger's record of a props
 * change (the taxonomy twin of the live-channel `props_update`
 * frame). `epoch` (#483) names the history record the props belong
 * to: an update stamps the epoch it MINTED, an amend stamps the
 * current head — so pinned `#N` reconstruction replays exactly the
 * events with `epoch ≤ N` up to the N+1 boundary, and frames never
 * apply props from a newer epoch than their own.
 */
export interface UiUpdatedEventData {
  readonly sessionId: string;
  readonly props: Record<string, unknown>;
  /** Absent on pre-#483 ledgers — read as "the then-current epoch". */
  readonly epoch?: number;
}

/**
 * Head epoch implied by an event list: the count of `'ui.reminted'`
 * events. `ggui_render` mints epoch 0 with NO event, so an empty (or
 * remint-free) ledger is epoch 0 by construction. Callers slicing the
 * ledger at a seq get the epoch AS OF that seq — which is exactly how
 * pinned `#N` snapshots reconstruct (props replayed to the N-th
 * remint boundary).
 */
export function deriveEpochFromEvents(
  events: ReadonlyArray<Pick<GguiSessionEvent, 'type'>>,
): number {
  let epoch = 0;
  for (const event of events) {
    if (event.type === 'ui.reminted') epoch += 1;
  }
  return epoch;
}

/**
 * Response body for `GET /api/sessions/:sessionId/events?sinceSequence=N&limit=M`.
 *
 * Pagination semantics:
 *   - `events` — strictly ascending by `seq`; only events with
 *     `seq > sinceSequence`, capped at `limit`.
 *   - `lastSequence` — the server's current high-water mark
 *     (`GguiSession.eventSequence`), NOT the last event's seq in this
 *     page. Clients use it to advance their cursor even when the
 *     page is empty.
 *   - `hasMore` — `true` when `limit` truncated the result. Clients
 *     SHOULD immediately re-fetch with `sinceSequence = lastEventInPage.seq`
 *     until `hasMore === false`.
 *
 * @public
 */
export type EventsResponse = DeepReadonly<
  z.infer<typeof runtimePullEventsPageSchema>
>;

/**
 * 410 Gone response body — `sinceSequence` predates the server's
 * replay horizon (events evicted from the bounded ring buffer or
 * never written before the ledger went online). Client recovery:
 * re-mount from a fresh snapshot (`/api/sessions/:id/state`) and
 * reset the cursor to the returned `currentSequence`.
 *
 * @public
 */
export interface ReplayHorizonPassedError {
  readonly reason: 'REPLAY_HORIZON_PASSED';
  readonly currentSequence: number;
}
