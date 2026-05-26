/**
 * SessionEvent ledger — wire-frame replay primitives (R7).
 *
 * Core protocol-layer types backing the unified cursor-replay model.
 * The same ledger is read by:
 *
 *   - `GET /api/sessions/:id/events?sinceSequence=N&limit=M` —
 *     HTTP cursor-replay endpoint; polling clients walk it on a
 *     2s tick.
 *   - WS `subscribe` with `SubscribePayload.sinceSequence` — server
 *     replays events with `sequence > sinceSequence` as `session_event`
 *     wire frames BEFORE entering live-stream mode.
 *
 * Two transports, same cursor — switching transports does not lose
 * events.
 *
 * # Why this is core (not an integration)
 *
 * SessionEvent is the wire-frame ledger shape — the structural unit
 * the live-channel transport replays. It sits at the same layer as
 * other transport-level types (`StreamEnvelope`, `AckPayload`). It is
 * NOT an MCP-Apps-integration-specific concept — it's the protocol's
 * primary durable cursor primitive, equally consumed by the
 * `@ggui-ai/iframe-runtime` polling layer and any non-MCP-Apps host.
 */

/**
 * Wire-frame ledger event (R7). One row in the per-session SessionEvent
 * ledger. Each event is the monotonic atom from which session-slice
 * meta is derived: pushes, updates, drains, etc.
 *
 * Discriminator is `type` (mirrors the live-channel wire-frame `type`
 * the registry-level polling dispatcher routes by). Payload is
 * type-specific and structurally identical to the matching WS frame's
 * `payload`. Consumers fold events into local state by dispatching to
 * the registered handler for `event.type`.
 *
 * @public
 */
export interface SessionEvent<TPayload = unknown> {
  /**
   * Monotonic, gap-free per session. Starts at 1 for the first event;
   * `0` is the sentinel for "no events yet" / fresh subscriber.
   */
  readonly sequence: number;
  /** ISO 8601 UTC timestamp the server stamped on emission. */
  readonly emittedAt: string;
  /**
   * Wire-frame type. Mirrors the live-channel envelope discriminator
   * — `'push'`, `'props_update'`, etc. Open union: first-party
   * servers may mint new types without a protocol bump.
   */
  readonly type: string;
  /**
   * Type-specific payload — structurally identical to the matching WS
   * frame's `payload`. Typed at the consumer via discriminating
   * `event.type` before reading.
   */
  readonly payload: TPayload;
}

/**
 * Response body for `GET /api/sessions/:id/events?sinceSequence=N&limit=M`.
 *
 * Pagination semantics:
 *   - `events` — strictly ascending by `sequence`; only events with
 *     `sequence > sinceSequence`, capped at `limit`.
 *   - `lastSequence` — the server's current high-water mark
 *     (`Session.eventSequence`), NOT the last event's sequence in
 *     this page. Clients use it to advance their cursor even when
 *     the page is empty.
 *   - `hasMore` — `true` when `limit` truncated the result. Clients
 *     SHOULD immediately re-fetch with `sinceSequence = lastEventInPage.sequence`
 *     until `hasMore === false`.
 *
 * @public
 */
export interface EventsResponse {
  readonly events: ReadonlyArray<SessionEvent>;
  readonly lastSequence: number;
  readonly hasMore: boolean;
}

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
