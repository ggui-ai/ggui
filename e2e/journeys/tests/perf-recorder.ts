/**
 * Small, opt-in perf/quality gate recorder for the `journeys-ggui-oss`
 * harness.
 *
 * Purpose: now that the Phase 5 / 5.5 literal OSS E2E gate is closed
 * (see `docs/plans/2026-04-21-oss-split-e2e-phases.md` §16), we need a
 * narrow, trustworthy timing layer on a handful of OSS-critical paths
 * — NOT a broad observability/tracing rollout. Records are attached
 * to Playwright testInfo on every run (pass + fail) so CI captures
 * trend data, and a conservative budget is enforced only on paths
 * that are deterministic enough to not flap.
 *
 * Two explicit lanes, matching the 4-lane test taxonomy + the
 * OSS-full-gen plan's Slice 10 advisory/blocking split:
 *
 *   - `'blocking'` — deterministic, in-memory or local-loopback paths
 *     where a blown budget is a real regression signal. These ALSO
 *     assert via {@link PerfRecorder.assertBudget}, so a threshold
 *     violation fails the test.
 *
 *   - `'advisory'` — live-LLM / provider-backed paths. Captured as
 *     data (attached + logged) but never enforced. The OSS full-gen
 *     plan §Slice 10 + §7.3 footguns explicitly call out that LLM
 *     latency varies too much to be a blocking CI gate today.
 *
 * Output format (stable; future sessions can aggregate off this without
 * log-parsing): an array of {@link PerfRecord} serialized as
 * `perf-timings.json`. One attachment per test. Example:
 *
 *   [
 *     { "name": "pair-mint", "elapsedMs": 11, "lane": "blocking",
 *       "budgetMs": 2000 },
 *     { "name": "push-cold-llm", "elapsedMs": 8421, "lane": "advisory",
 *       "notes": "anthropic cold path" }
 *   ]
 *
 * A compact `perf:` line per record is also written to stdout, so a CI
 * log scrolls carry the signal even when artifact download is skipped.
 *
 * What this helper deliberately does NOT do (so future sessions don't
 * scope-creep it into a tracing subsystem):
 *
 *   - Parse `tool_invoked` events off `ggui serve` stdout. That
 *     belongs to a dedicated spawn-reporter; here we only measure the
 *     spec's own observable wall-clock.
 *   - Aggregate across tests / workers. Each test emits its own
 *     attachment; a downstream reporter/merger is out of scope.
 *   - Compute percentiles. N per test is small (usually 1-2); a single
 *     elapsedMs per record is the honest reading.
 *   - Touch server-side code. Purely a test-harness helper.
 */
import type { TestInfo } from '@playwright/test';
import { test } from '@playwright/test';

/** The two honesty lanes — blocking or advisory. */
export type PerfLane = 'blocking' | 'advisory';

/**
 * One timed observation from a spec. Kept flat + JSON-serializable so
 * attachments + stdout lines share the same shape.
 */
export interface PerfRecord {
  /**
   * Stable identifier for the path. Use kebab-case + the critical
   * vocabulary (e.g., `cold-boot`, `pair-mint`, `tools-list`,
   * `push-cold-llm`, `chat-message-llm`).
   * Consistency matters more than cleverness — future aggregators
   * group on this.
   */
  readonly name: string;
  /**
   * Wall-clock milliseconds. Rounded to integer ms at capture time —
   * sub-millisecond precision is noise against network + process
   * boundaries.
   */
  readonly elapsedMs: number;
  /** See {@link PerfLane}. Determines whether the record is enforced. */
  readonly lane: PerfLane;
  /**
   * Present when `lane === 'blocking'`. A conservative upper bound
   * chosen so ordinary CI variance stays inside it. See the
   * BUDGET_RATIONALE block below for the specific values used.
   */
  readonly budgetMs?: number;
  /**
   * Optional free-form context. Use sparingly; the `name` should
   * carry most meaning. Useful for disambiguating when the same
   * name appears with different conditions (e.g., provider variant).
   */
  readonly notes?: string;
}

/**
 * Why each blocking budget was chosen (kept in code so a future
 * reviewer doesn't have to grep docs to evaluate a regression):
 *
 *   - `cold-boot` — 15_000ms. Matches the pre-existing
 *     {@link READY_TIMEOUT_MS} in `ggui-serve-harness.ts`; promoting
 *     it to an explicit PerfRecord just makes the wall-clock visible.
 *     Observed local-loopback values are ~1000-4000ms; 15s leaves
 *     ~3-4× headroom for cold CI workers with high disk latency.
 *
 *   - `pair-mint` — 2_000ms. Single `POST /pair` against an in-memory
 *     `InMemoryPairingService`. Observed: 5-20ms. 2s is ~100× headroom
 *     — the right threshold for "something has gone catastrophically
 *     wrong" without flapping on a busy runner.
 *
 *   - `tools-list` — 2_000ms. Single JSON-RPC `tools/list` against
 *     the in-memory MCP backend, no cache, no LLM. Observed: 10-40ms.
 *     Same 100× headroom rationale as `pair-mint`.
 *
 * These are intentionally generous. A timing below the budget says
 * nothing about whether the code is fast; a violation says "this
 * path is broken or silently fell through to a slow path."
 */
export const BLOCKING_BUDGETS_MS = {
  'cold-boot': 15_000,
  'pair-mint': 2_000,
  'tools-list': 2_000,
} as const satisfies Record<string, number>;

/**
 * Narrowing helper — the keys of {@link BLOCKING_BUDGETS_MS}. Specs
 * pass a value of this type to {@link PerfRecorder.recordBlocking} and
 * get the budget looked up automatically, so a typo in the record
 * name becomes a type error instead of a silently-unenforced budget.
 */
export type BlockingBudgetKey = keyof typeof BLOCKING_BUDGETS_MS;

/**
 * Accumulates {@link PerfRecord}s during a test, then emits them as
 * one `perf-timings.json` attachment at finalize-time. Also logs a
 * compact `perf:` line to stdout per record so CI log scrolls carry
 * the same signal without the artifact download.
 *
 * One recorder per test. `test.describe.serial` suites that share a
 * single harness lifetime still create one recorder per test — each
 * spec-step owns its own slice of timings, which keeps the
 * per-attachment signal focused.
 */
export class PerfRecorder {
  private readonly records: PerfRecord[] = [];

  /**
   * Measure `fn()` and record the elapsed time under `name`. Returns
   * `fn`'s resolved value so the call site reads naturally:
   *
   *   const token = await perf.timeBlocking('pair-mint', () => mint());
   *
   * Blocking path. `name` must be a key of {@link BLOCKING_BUDGETS_MS}
   * — typos become type errors. The budget lookup happens here, so
   * the spec doesn't duplicate the number.
   */
  async timeBlocking<T>(
    name: BlockingBudgetKey,
    fn: () => Promise<T>,
    notes?: string,
  ): Promise<T> {
    const start = Date.now();
    const out = await fn();
    const elapsedMs = Date.now() - start;
    this.recordBlocking(name, elapsedMs, notes);
    return out;
  }

  /**
   * Measure `fn()` and record the elapsed time as advisory — no
   * budget, no enforcement. Use for LLM / provider-backed paths.
   */
  async timeAdvisory<T>(
    name: string,
    fn: () => Promise<T>,
    notes?: string,
  ): Promise<T> {
    const start = Date.now();
    const out = await fn();
    const elapsedMs = Date.now() - start;
    this.recordAdvisory(name, elapsedMs, notes);
    return out;
  }

  /**
   * Record a pre-measured blocking elapsed. Use when the timing is
   * captured outside a simple `fn()` call — e.g., the spawn-to-READY
   * window inside `spawnGguiServe` where the callback/promise shape
   * doesn't fit `timeBlocking`. Emits the `perf:` stdout line
   * immediately so a hanging test still produces partial signal.
   */
  recordBlocking(
    name: BlockingBudgetKey,
    elapsedMs: number,
    notes?: string,
  ): void {
    const budgetMs = BLOCKING_BUDGETS_MS[name];
    const record: PerfRecord = notes
      ? { name, elapsedMs, lane: 'blocking', budgetMs, notes }
      : { name, elapsedMs, lane: 'blocking', budgetMs };
    this.records.push(record);
    // eslint-disable-next-line no-console -- stdout line by design.
    console.log(
      `perf: ${name} ${elapsedMs}ms lane=blocking budget=${budgetMs}ms`,
    );
  }

  /**
   * Record a pre-measured advisory elapsed. Use when the timing was
   * captured by pre-existing spec code (e.g., `Date.now()` deltas
   * around a POST) and only the structured output + stdout line are
   * missing.
   */
  recordAdvisory(name: string, elapsedMs: number, notes?: string): void {
    const record: PerfRecord = notes
      ? { name, elapsedMs, lane: 'advisory', notes }
      : { name, elapsedMs, lane: 'advisory' };
    this.records.push(record);
    // eslint-disable-next-line no-console
    console.log(`perf: ${name} ${elapsedMs}ms lane=advisory`);
  }

  /**
   * Assert every recorded blocking timing stayed inside its budget.
   * Advisory records are skipped. Safe to call on an empty recorder.
   *
   * Keep this call site explicit — specs should invoke it inline at
   * the end of the assertion block, not in `afterEach`. A budget
   * violation means "this blocking path is broken," which is exactly
   * the kind of signal that should fail a single test clearly rather
   * than be attributed to a generic teardown.
   */
  assertBudgets(): void {
    const violations = this.records
      .filter(
        (r): r is PerfRecord & { budgetMs: number } =>
          r.lane === 'blocking' && typeof r.budgetMs === 'number',
      )
      .filter((r) => r.elapsedMs > r.budgetMs);
    if (violations.length === 0) return;
    const lines = violations.map(
      (v) =>
        `  - ${v.name}: ${v.elapsedMs}ms (budget ${v.budgetMs}ms)` +
        (v.notes ? ` — ${v.notes}` : ''),
    );
    throw new Error(
      `perf budget violations (blocking lane):\n${lines.join('\n')}`,
    );
  }

  /**
   * Attach the accumulated records as `perf-timings.json` to the
   * current test. Always attaches (pass + fail) — trend signal is
   * the whole point, so we don't hide it on green runs the way
   * failure-only artifacts do.
   *
   * Idempotent on empty recorders (no attachment if no records).
   */
  async attach(testInfo: TestInfo = test.info()): Promise<void> {
    if (this.records.length === 0) return;
    await testInfo.attach('perf-timings.json', {
      body: JSON.stringify(this.records, null, 2),
      contentType: 'application/json',
    });
  }

  /**
   * Read-only view of collected records. Exposed for specs that need
   * to cross-check against another assertion (e.g., a cache-hit
   * being faster than its own cold run).
   */
  get snapshot(): readonly PerfRecord[] {
    return this.records;
  }
}

/**
 * Construct a fresh recorder. Pure factory — no singletons — so
 * parallel specs / serial sub-tests each own independent state.
 */
export function createPerfRecorder(): PerfRecorder {
  return new PerfRecorder();
}
