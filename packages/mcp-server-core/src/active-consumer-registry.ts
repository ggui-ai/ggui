/**
 * `ActiveConsumerRegistry` — optional seam tracking which renders
 * currently have at least one in-flight `ggui_consume` long-poll.
 *
 * **Why this exists.** `ggui_runtime_submit_action` appends a user-action
 * envelope onto the sessionId-keyed pending-events pipe; the agent's
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
 *   - `submit-action.ts` queries `hasActive(sessionId)` AFTER a
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
 * `sessionId` are valid (rare, but possible — e.g. a debugging tool
 * peeking alongside the agent). The registry stores a reference count;
 * `hasActive` is `count > 0`. `enter` increments, `exit` decrements; once
 * count hits zero, the entry is removed from the map (no zombie keys).
 *
 * @public
 */
export interface ActiveConsumerRegistry {
  /**
   * Increment the consumer count for `sessionId`. Called from
   * `consume.ts` at the top of the handler (before the long-poll loop)
   * so a concurrent `submit-action.ts` append sees `hasActive: true`
   * even during the 1.5s sleep between consumeAndClear ticks.
   */
  enter(sessionId: string): void;

  /**
   * Decrement the consumer count for `sessionId`. Called from
   * `consume.ts`'s `finally` block so EVERY exit path (success, timeout,
   * error) cleans up. When the count reaches zero the entry is removed.
   */
  exit(sessionId: string): void;

  /**
   * True iff at least one consume long-poll is currently registered for
   * `sessionId`. Called from `submit-action.ts` after a successful
   * pipe append; the result rides back to the iframe as
   * `consumerPresent`.
   */
  hasActive(sessionId: string): boolean;

  /**
   * Resolve `true` the INSTANT a consumer is (or becomes) registered
   * for `sessionId`, or `false` when `timeoutMs` elapses first.
   *
   * The doorbell-grace primitive (2026-08-12): `submit-action.ts` uses
   * this instead of probe-polling `hasActive` so a consume parking
   * mid-window flips the answer with zero quantization delay. An
   * already-active consumer resolves synchronously-fast (microtask);
   * the wait NEVER rejects.
   */
  waitForConsumer(sessionId: string, timeoutMs: number): Promise<boolean>;

  /**
   * Milliseconds since the LAST consumer for `sessionId` exited, or
   * `undefined` when none has ever exited (no consume has completed
   * for this render since process start).
   *
   * Powers the ADAPTIVE grace window: a recent exit means the agent is
   * mid-loop (consume → act → consume) and a re-poll is likely — worth
   * waiting for; a stale (or absent) exit on an old render means no
   * consume is coming this turn and the doorbell should ring promptly.
   * In-process timestamps — same single-instance scope as the counts
   * (see the InMemory impl's multi-pod note).
   */
  msSinceLastExit(sessionId: string): number | undefined;
}

