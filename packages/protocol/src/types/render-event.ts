/**
 * RenderEvent ledger — wire-frame replay primitives (R7).
 *
 * Core protocol-layer types backing the unified cursor-replay model.
 * The same ledger is read by:
 *
 *   - `GET /api/renders/:renderId/events?sinceSequence=N&limit=M` —
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
 * RenderEvent is the wire-frame ledger shape — the structural unit
 * the live-channel transport replays. It sits at the same layer as
 * other transport-level types (`StreamEnvelope`, `AckPayload`). It is
 * NOT an MCP-Apps-integration-specific concept — it's the protocol's
 * primary durable cursor primitive, equally consumed by the
 * `@ggui-ai/iframe-runtime` polling layer and any non-MCP-Apps host.
 *
 * # Source of truth
 *
 * This is the canonical definition. The server-side `RenderStore`
 * seam in `@ggui-ai/mcp-server-core` re-exports these types so
 * implementors (in-memory, sqlite, dynamo) all bind to the same
 * shape. Wave 7 (flatten-render-identity, 2026-05-28): merged the
 * earlier protocol-side `SessionEvent` (sequence + emittedAt + type +
 * payload) into the server-side RenderEvent shape (seq + timestamp +
 * type + data); one ledger primitive everywhere. `timestamp` carries
 * an ISO 8601 UTC string for cross-layer uniformity (was epoch-ms on
 * the server side).
 */

/**
 * Append-only ledger event for one render. Each event carries a
 * monotonic `seq` that is gap-free within a single render, starting
 * at 1.
 *
 * Discriminator is `type`; `data` is type-specific and structurally
 * identical to the matching live-channel wire frame's payload.
 * Consumers fold events into local state by dispatching to the
 * registered handler for `event.type`.
 *
 * @public
 */
export interface RenderEvent<TData = unknown> {
  /**
   * Monotonic, gap-free per render. Starts at 1 for the first event;
   * `0` is the sentinel for "no events yet" / fresh subscriber.
   */
  readonly seq: number;
  /**
   * Wire-frame type. The canonical taxonomy lives at
   * {@link RenderEventType} for type-discrimination ergonomics;
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
export type RenderEventType =
  | 'ui.created'
  | 'ui.updated'
  | 'ui.committed'
  | 'tool.called'
  | 'tool.result'
  | 'user.submitted';

/**
 * Response body for `GET /api/renders/:renderId/events?sinceSequence=N&limit=M`.
 *
 * Pagination semantics:
 *   - `events` — strictly ascending by `seq`; only events with
 *     `seq > sinceSequence`, capped at `limit`.
 *   - `lastSequence` — the server's current high-water mark
 *     (`Render.eventSequence`), NOT the last event's seq in this
 *     page. Clients use it to advance their cursor even when the
 *     page is empty.
 *   - `hasMore` — `true` when `limit` truncated the result. Clients
 *     SHOULD immediately re-fetch with `sinceSequence = lastEventInPage.seq`
 *     until `hasMore === false`.
 *
 * @public
 */
export interface EventsResponse {
  readonly events: ReadonlyArray<RenderEvent>;
  readonly lastSequence: number;
  readonly hasMore: boolean;
}

/**
 * 410 Gone response body — `sinceSequence` predates the server's
 * replay horizon (events evicted from the bounded ring buffer or
 * never written before the ledger went online). Client recovery:
 * re-mount from a fresh snapshot (`/api/renders/:id/state`) and
 * reset the cursor to the returned `currentSequence`.
 *
 * @public
 */
export interface ReplayHorizonPassedError {
  readonly reason: 'REPLAY_HORIZON_PASSED';
  readonly currentSequence: number;
}
