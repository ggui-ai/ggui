/**
 * `ActiveConsumerRegistry` — optional seam tracking which renders
 * currently have at least one in-flight `ggui_consume` long-poll.
 *
 * **Why this exists.** `ggui_runtime_submit_action` appends a user-action
 * envelope onto the renderId-keyed pending-events pipe; the agent's
 * `ggui_consume` long-poll drains it mid-turn. When no long-poll is
 * currently registered (typical case: agent finished its turn, no
 * pending consume call), the appended event sits in the pipe until the
 * agent's NEXT turn calls consume — which may be never on its own. The
 * iframe-runtime needs to know this at append time so it can immediately
 * emit a `ui/message` nudge ("there's pending work — call ggui_consume")
 * instead of waiting on its 10s claim timer.
 *
 * Today's `PendingEventConsumer` is queue-only (`append` / `consumeAndClear`
 * / `markCreated` / `markDeleted`) — it has zero concept of "who's
 * listening." This seam adds the missing dimension as an OPTIONAL
 * collaborator wired into `consume.ts` (enter/exit) and `submit-action.ts`
 * (hasActive) by the server composition root.
 *
 * **Wiring contract.**
 *   - `consume.ts` wraps its long-poll in `try { enter(); … } finally
 *     { exit(); }` so EVERY exit path (events returned, timeout elapsed,
 *     pipe vanished, error) decrements the count.
 *   - `submit-action.ts` queries `hasActive(renderId)` AFTER a
 *     successful pipe append. If `false`, the response carries
 *     `consumerPresent: false` and the iframe takes the immediate-nudge
 *     fast-path.
 *   - When the seam is absent (cloud pod today; future ephemeral
 *     deployments without shared state), submit-action surfaces
 *     `consumerPresent: undefined` → iframe falls back to the 10s timer
 *     path (graceful degradation, today's behavior preserved).
 *
 * **Why a separate seam, not a `PendingEventConsumer` method.** Mirrors
 * the established optional-seam pattern (`DrainAckNotifier`, `ObserverNotifier`,
 * `ConsumeLogger`) — keeps the queue contract narrow + lets cloud wire
 * a Redis-backed registry without touching the DDB UpdateItem path.
 *
 * **Counting semantics.** Multiple concurrent long-polls on the same
 * `renderId` are valid (rare, but possible — e.g. a debugging tool
 * peeking alongside the agent). The registry stores a reference count;
 * `hasActive` is `count > 0`. `enter` increments, `exit` decrements; once
 * count hits zero, the entry is removed from the map (no zombie keys).
 *
 * @public
 */
export interface ActiveConsumerRegistry {
  /**
   * Increment the consumer count for `renderId`. Called from
   * `consume.ts` at the top of the handler (before the long-poll loop)
   * so a concurrent `submit-action.ts` append sees `hasActive: true`
   * even during the 1.5s sleep between consumeAndClear ticks.
   */
  enter(renderId: string): void;

  /**
   * Decrement the consumer count for `renderId`. Called from
   * `consume.ts`'s `finally` block so EVERY exit path (success, timeout,
   * error) cleans up. When the count reaches zero the entry is removed.
   */
  exit(renderId: string): void;

  /**
   * True iff at least one consume long-poll is currently registered for
   * `renderId`. Called from `submit-action.ts` after a successful
   * pipe append; the result rides back to the iframe as
   * `consumerPresent`.
   */
  hasActive(renderId: string): boolean;
}

