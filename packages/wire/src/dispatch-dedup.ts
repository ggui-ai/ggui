/**
 * Task-scoped dispatch deduplication for `useAction`.
 *
 * THE BUG CLASS THIS DEFENDS AGAINST. LLM-generated components
 * sometimes emit nested interactive elements where two handlers wire to
 * the same `useAction` binding — e.g. a `Card as={Clickable} onClick` row
 * containing a `Checkbox onChange`, both calling the same `toggle()`.
 * One user click → onChange fires → click bubbles to the Card → onClick
 * fires → the action dispatches twice. A toggle then runs back-to-back
 * and the user's change disappears. Scenario 7 caught it; the tier-0
 * `double-wired-action` regex warns on the source shape but cannot
 * catch every variant (helper-function indirection, action passed as
 * prop without parens, two `useAction` calls with the same name). The
 * structural invariant — "one user gesture → at most one dispatch per
 * (name, payload)" — lives at runtime, not in source.
 *
 * THE MECHANISM. Each dispatch records `${actionName}::${JSON
 * .stringify(payload)}` in a module-scoped `Set`. A `queueMicrotask`
 * scheduled by the first dispatch in a task drains the set at the end
 * of the current event-loop task. Bubble-triggered re-dispatches from
 * the same gesture run within the same task, collide on the signature,
 * and are suppressed. A second user gesture is a separate task → fresh
 * set → passes through.
 *
 * WHY THIS IS THE FUNDAMENTAL FIX. It operates on the actual runtime
 * invariant (one task = one user interaction) rather than a
 * source-shape proxy. It catches helper-function indirection, action
 * passed as bare reference, and multi-useAction-same-name patterns
 * that the static check misses by construction.
 *
 * NEVER SILENT. When the dedup suppresses, `useAction` logs a
 * `console.warn` with the full diagnostic AND cross-links to the
 * `double-wired-action` tier-0 rule. The suppression is visible in
 * browser DevTools in both dev and prod. Operators investigating a
 * "click does nothing the second time" report will see the warning
 * immediately. A future iteration can route the warning through a
 * structured telemetry sink — today the loud console signal is the
 * paper trail.
 *
 * TRADEOFFS — explicit so a future maintainer doesn't have to spelunk:
 *
 *   - Same `(name, payload)` fired intentionally twice from one tick
 *     (e.g. `dispatch('log',x); dispatch('log',x);` in a single
 *     handler) gets the second call suppressed. The dev-mode warn
 *     surfaces this; the workaround is to vary the payload (`{n:1}` vs
 *     `{n:2}`) which is the right shape for the wire anyway.
 *   - Non-JSON-serializable payloads (BigInt, circular, function
 *     fields) cannot produce a signature; those dispatches always
 *     pass through (no dedup). The wire schema rejects such payloads
 *     downstream, so this is a graceful degradation, not a bug.
 *   - Module-level state is per-iframe — one iframe runs one component,
 *     so the dedup is correctly scoped to that component's gesture
 *     stream. No cross-iframe leak.
 */

const pendingDispatches = new Set<string>();
let microtaskScheduled = false;

/**
 * Compute the dedup signature for a dispatch. Returns `null` when the
 * payload cannot be JSON-serialized — the caller MUST pass through
 * without dedup in that case (no signature, no key).
 */
export function payloadSignature(
  actionName: string,
  data: unknown,
): string | null {
  try {
    return `${actionName}::${JSON.stringify(data ?? null)}`;
  } catch {
    return null;
  }
}

/**
 * Decide whether to accept or suppress a dispatch under task-scoped
 * dedup. On accept, the signature is added to the pending set and
 * scheduled for clearance at the end of the current task.
 */
export interface DispatchDecision {
  /** True iff this dispatch should be suppressed (a duplicate within the task). */
  readonly suppressed: boolean;
  /** Dedup signature, or `null` when the payload was un-serializable. */
  readonly signature: string | null;
}

export function tryAcceptDispatch(
  actionName: string,
  data: unknown,
): DispatchDecision {
  const signature = payloadSignature(actionName, data);
  if (signature === null) {
    // Un-serializable payload — bypass dedup, always accept.
    return { suppressed: false, signature };
  }
  if (pendingDispatches.has(signature)) {
    return { suppressed: true, signature };
  }
  pendingDispatches.add(signature);
  if (!microtaskScheduled) {
    microtaskScheduled = true;
    queueMicrotask(() => {
      pendingDispatches.clear();
      microtaskScheduled = false;
    });
  }
  return { suppressed: false, signature };
}

/**
 * Synchronously drain the dedup state. Test-only — production code
 * relies on the microtask drain. Exported so behavioral tests that
 * assert dedup across simulated gestures can reset between cases.
 */
export function __resetDispatchDedupForTests(): void {
  pendingDispatches.clear();
  microtaskScheduled = false;
}
