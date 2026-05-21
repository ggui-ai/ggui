/**
 * Pure aggregation: results → shape-grouped summaries.
 *
 * Groups by {@link A2uiIntentShape} rather than by case id so the
 * summarizer scales when a future corpus has multiple cases per
 * shape. Null discipline identical to the SLO summarizer — null is
 * first-class, never averaged out, surfaced in `nullCount`.
 */

import type {
  A2uiIntentShape,
  A2uiMinMedianMax,
  A2uiRunResult,
  A2uiShapeSummary,
} from './types.js';

export function reduceA2uiMinMedianMax(
  values: readonly (number | null)[],
): A2uiMinMedianMax {
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

export function summarizeA2uiResults(
  results: readonly A2uiRunResult[],
): readonly A2uiShapeSummary[] {
  const buckets = new Map<A2uiIntentShape, A2uiRunResult[]>();
  for (const r of results) {
    const list = buckets.get(r.tags.intentShape) ?? [];
    list.push(r);
    buckets.set(r.tags.intentShape, list);
  }

  const summaries: A2uiShapeSummary[] = [];
  for (const [shape, runs] of buckets) {
    const timeToFirstFrame = reduceA2uiMinMedianMax(
      runs.map((r) => r.derived.timeToFirstFrame),
    );
    const timeToPreviewFinalize = reduceA2uiMinMedianMax(
      runs.map((r) => r.derived.timeToPreviewFinalize),
    );
    // `frameCount` never null (counter always defined); running it
    // through the same reducer keeps output shape uniform.
    const frameCount = reduceA2uiMinMedianMax(
      runs.map((r) => r.frames.frameCount),
    );
    const parsePassRate = reduceA2uiMinMedianMax(
      runs.map((r) => r.derived.parsePassRate),
    );

    let previewExpectedButMissingCount = 0;
    let runsWithParseFailures = 0;
    let totalParseFailures = 0;
    for (const r of runs) {
      if (r.tags.previewExpected && !r.tags.previewObserved) {
        previewExpectedButMissingCount += 1;
      }
      if (r.frames.parseFailCount > 0) runsWithParseFailures += 1;
      totalParseFailures += r.frames.parseFailCount;
    }

    summaries.push({
      intentShape: shape,
      runs: runs.length,
      timeToFirstFrame,
      timeToPreviewFinalize,
      frameCount,
      parsePassRate,
      previewExpectedButMissingCount,
      runsWithParseFailures,
      totalParseFailures,
    });
  }

  // Stable ordering: form, list, minimal. Shape order is fixed —
  // a future shape (e.g., 'chat') slots in by updating this
  // function AND the A2uiIntentShape union in one commit.
  const order: Record<A2uiIntentShape, number> = {
    form: 0,
    list: 1,
    minimal: 2,
  };
  summaries.sort((a, b) => order[a.intentShape] - order[b.intentShape]);
  return summaries;
}
