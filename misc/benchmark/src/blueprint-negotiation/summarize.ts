/**
 * Pure aggregation: negotiation run results → per-mode summaries.
 *
 * Null discipline:
 *   - `falsePositiveRate` is null when no miss-expected runs exist
 *     in the group — we don't synthesize 0/0 = 0.
 *   - `falseNegativeRate` same shape.
 *   - `exactMatchRateOnHits` null when no observed hits in the group.
 *   - `emptyRegistryCleanMissRate` populated ONLY on the `empty`-mode
 *     row; null elsewhere so the "success on empty" invariant is
 *     visible without reading across rows.
 */

import type {
  NegotiationMinMedianMax,
  NegotiationModeSummary,
  NegotiationRunResult,
  RegistryMode,
} from './types.js';

export function reduceNegotiationMinMedianMax(
  values: readonly (number | null)[],
): NegotiationMinMedianMax {
  let nullCount = 0;
  const present: number[] = [];
  for (const v of values) {
    if (v === null) nullCount += 1;
    else present.push(v);
  }
  if (present.length === 0) {
    return { count: 0, nullCount, min: null, median: null, max: null };
  }
  const sorted = [...present].sort((a, b) => a - b);
  return {
    count: present.length,
    nullCount,
    min: sorted[0]!,
    median: computeMedian(sorted),
    max: sorted[sorted.length - 1]!,
  };
}

function computeMedian(sorted: readonly number[]): number {
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function summarizeNegotiationResults(
  results: readonly NegotiationRunResult[],
): readonly NegotiationModeSummary[] {
  const buckets = new Map<RegistryMode, NegotiationRunResult[]>();
  for (const r of results) {
    const list = buckets.get(r.tags.registryMode) ?? [];
    list.push(r);
    buckets.set(r.tags.registryMode, list);
  }

  const summaries: NegotiationModeSummary[] = [];
  for (const [mode, runs] of buckets) {
    const hits = runs.filter((r) => r.tags.observedOutcome === 'hit');
    const wrongHits = runs.filter((r) => r.tags.observedOutcome === 'wrong_hit');
    const errs = runs.filter((r) => r.tags.observedOutcome === 'error');
    const missExpected = runs.filter((r) => r.tags.expectedOutcome === 'miss');
    const hitExpected = runs.filter((r) => r.tags.expectedOutcome === 'hit');

    // False positive: expected miss but observed any kind of hit.
    const fpRuns = missExpected.filter(
      (r) => r.tags.observedOutcome === 'hit' || r.tags.observedOutcome === 'wrong_hit',
    );
    // False negative: expected hit but observed miss.
    const fnRuns = hitExpected.filter((r) => r.tags.observedOutcome === 'miss');

    // Exact-match rate on observed hits: observed id matches expected id.
    const exactMatches = hits.filter(
      (r) =>
        r.tags.expectedBlueprintId !== null &&
        r.tags.observedBlueprintId === r.tags.expectedBlueprintId,
    );

    const decisionTimeMs = reduceNegotiationMinMedianMax(
      runs.map((r) => r.derived.decisionTimeMs),
    );

    summaries.push({
      registryMode: mode,
      runs: runs.length,
      hitRate: runs.length > 0 ? hits.length / runs.length : 0,
      falsePositiveRate:
        missExpected.length === 0 ? null : fpRuns.length / missExpected.length,
      falseNegativeRate:
        hitExpected.length === 0 ? null : fnRuns.length / hitExpected.length,
      exactMatchRateOnHits:
        hits.length === 0 ? null : exactMatches.length / hits.length,
      // Only populate on the empty-mode row — the success-on-empty
      // invariant should be legible without cross-row reasoning.
      emptyRegistryCleanMissRate:
        mode === 'empty'
          ? runs.length === 0
            ? null
            : runs.filter((r) => r.tags.observedOutcome === 'miss').length /
              runs.length
          : null,
      wrongHitRate: runs.length > 0 ? wrongHits.length / runs.length : 0,
      errorRate: runs.length > 0 ? errs.length / runs.length : 0,
      arbitrationCorrectnessRate: 0, // v0 — always 0 until multi-registry lands
      decisionTimeMs,
    });
  }

  // Deterministic order: oss → hosted → empty, so reports read in the
  // "default → hosted → edge" direction that matches the floor bench's
  // sort convention.
  const order: Record<RegistryMode, number> = { oss: 0, hosted: 1, empty: 2 };
  summaries.sort((a, b) => order[a.registryMode] - order[b.registryMode]);
  return summaries;
}
