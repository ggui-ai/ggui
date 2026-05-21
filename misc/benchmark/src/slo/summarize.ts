/**
 * Pure aggregation from {@link SloRunResult}[] → {@link SloPathSummary}[].
 *
 * Null discipline: every metric column tracks non-null samples
 * separately from null runs. `nullCount` is first-class output so
 * downstream dashboards can surface "N% of runs never emitted a
 * preview frame" as a deliberate signal, not an averaged-away zero.
 */

import type {
  SloBranchPath,
  SloMinMedianMax,
  SloPathSummary,
  SloRunResult,
} from './types.js';

/**
 * Reduce a list of possibly-null numbers to min / median / max +
 * null count. Count is the number of non-null inputs; min/median/max
 * are computed only over those.
 */
export function reduceMinMedianMax(
  values: readonly (number | null)[],
): SloMinMedianMax {
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
  const min = sorted[0]!;
  const max = sorted[sorted.length - 1]!;
  const median = computeMedian(sorted);
  return { count: present.length, nullCount, min, median, max };
}

/** Median of a pre-sorted array. Even length → average of middle two. */
function computeMedian(sorted: readonly number[]): number {
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Group + aggregate results by {@link SloRunTags.path}. Paths that
 * have no runs in the input are OMITTED from the output — reporters
 * that want an "all three branches always present" view layer that
 * concern themselves.
 */
export function summarizeResults(
  results: readonly SloRunResult[],
): readonly SloPathSummary[] {
  const buckets = new Map<SloBranchPath, SloRunResult[]>();
  for (const r of results) {
    const list = buckets.get(r.tags.path) ?? [];
    list.push(r);
    buckets.set(r.tags.path, list);
  }

  const summaries: SloPathSummary[] = [];
  for (const [path, runs] of buckets) {
    const timeToFirstPreview = reduceMinMedianMax(
      runs.map((r) => r.derived.timeToFirstPreview),
    );
    const timeToPreviewFinalize = reduceMinMedianMax(
      runs.map((r) => r.derived.timeToPreviewFinalize),
    );
    const timeToFinalCompiled = reduceMinMedianMax(
      runs.map((r) => r.derived.timeToFinalCompiled),
    );
    // `previewFrames` is never null (counter always defined), but
    // running it through the same reducer keeps the shape uniform
    // on the output. `nullCount` will be 0 on this column.
    const previewFrames = reduceMinMedianMax(
      runs.map((r) => r.tags.previewFrames),
    );
    let previewObservedCount = 0;
    let previewExpectedButMissingCount = 0;
    for (const r of runs) {
      if (r.tags.previewObserved) previewObservedCount += 1;
      if (r.tags.previewExpected && !r.tags.previewObserved) {
        previewExpectedButMissingCount += 1;
      }
    }
    summaries.push({
      path,
      runs: runs.length,
      timeToFirstPreview,
      timeToPreviewFinalize,
      timeToFinalCompiled,
      previewFrames,
      previewObservedCount,
      previewExpectedButMissingCount,
    });
  }
  // Sort for stable output — same input ordering always produces
  // the same JSON.
  summaries.sort((a, b) => a.path.localeCompare(b.path));
  return summaries;
}
