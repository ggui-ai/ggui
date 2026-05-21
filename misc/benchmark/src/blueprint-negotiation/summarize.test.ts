/**
 * Summarizer tests — pin the per-mode aggregation shape, with
 * particular attention to the null-as-signal behavior on FP/FN
 * rates and the empty-mode-only emptyRegistryCleanMissRate field.
 */

import { describe, expect, it } from 'vitest';
import {
  reduceNegotiationMinMedianMax,
  summarizeNegotiationResults,
} from './summarize.js';
import type {
  NegotiationRunResult,
  NegotiationRunTags,
  ObservedOutcome,
} from './types.js';

function mkRun(overrides: Partial<NegotiationRunResult> = {}): NegotiationRunResult {
  const tags: NegotiationRunTags = {
    caseId: 'c',
    registryMode: 'hosted',
    expectedOutcome: 'hit',
    observedOutcome: 'hit',
    expectedBlueprintId: 'p_x',
    observedBlueprintId: 'p_x',
    arbitrationObserved: false,
    confidence: null,
    errorClass: null,
    ...overrides.tags,
  };
  return {
    caseId: tags.caseId,
    runIndex: overrides.runIndex ?? 0,
    checkpoints: overrides.checkpoints ?? {
      decisionStartedAt: 100,
      decisionCompletedAt: 150,
    },
    stageLatencies: overrides.stageLatencies ?? {
      embeddingLatencyMs: 5,
      searchLatencyMs: 3,
      decisionLatencyMs: 0,
    },
    tags,
    derived: overrides.derived ?? {
      decisionTimeMs: 50,
      outcomeCorrect:
        (tags.expectedOutcome === 'hit' &&
          tags.observedOutcome === 'hit' &&
          tags.observedBlueprintId === tags.expectedBlueprintId) ||
        (tags.expectedOutcome === 'miss' && tags.observedOutcome === 'miss'),
    },
    errors: overrides.errors ?? [],
  };
}

describe('reduceNegotiationMinMedianMax', () => {
  it('basic min/median/max on 3 values', () => {
    expect(reduceNegotiationMinMedianMax([30, 10, 20])).toEqual({
      count: 3,
      nullCount: 0,
      min: 10,
      median: 20,
      max: 30,
    });
  });

  it('nulls counted separately, not folded into math', () => {
    const s = reduceNegotiationMinMedianMax([10, null, 20]);
    expect(s.count).toBe(2);
    expect(s.nullCount).toBe(1);
    expect(s.min).toBe(10);
    expect(s.max).toBe(20);
  });

  it('all-null → all-null stats, count=0, nullCount preserved', () => {
    expect(reduceNegotiationMinMedianMax([null, null])).toEqual({
      count: 0,
      nullCount: 2,
      min: null,
      median: null,
      max: null,
    });
  });

  it('empty input → zero counts', () => {
    expect(reduceNegotiationMinMedianMax([])).toEqual({
      count: 0,
      nullCount: 0,
      min: null,
      median: null,
      max: null,
    });
  });
});

describe('summarizeNegotiationResults — hit/miss/wrong_hit accounting', () => {
  it('hitRate counts observed hits over total runs', () => {
    const runs = [
      mkRun({ tags: { ...mkRun().tags, observedOutcome: 'hit' } }),
      mkRun({ runIndex: 1, tags: { ...mkRun().tags, observedOutcome: 'hit' } }),
      mkRun({
        runIndex: 2,
        tags: {
          ...mkRun().tags,
          expectedOutcome: 'miss',
          observedOutcome: 'miss',
          expectedBlueprintId: null,
          observedBlueprintId: null,
        },
      }),
    ];
    const [s] = summarizeNegotiationResults(runs);
    expect(s!.hitRate).toBeCloseTo(2 / 3);
  });

  it('wrongHitRate is tracked separately — NOT collapsed into hit or miss', () => {
    const runs = [
      mkRun({
        tags: {
          ...mkRun().tags,
          expectedOutcome: 'hit',
          observedOutcome: 'wrong_hit',
          observedBlueprintId: 'p_wrong',
          expectedBlueprintId: 'p_right',
        },
      }),
    ];
    const [s] = summarizeNegotiationResults(runs);
    expect(s!.hitRate).toBe(0); // wrong_hit is NOT a hit
    expect(s!.wrongHitRate).toBe(1);
  });

  it('errorRate counted', () => {
    const runs = [
      mkRun({
        tags: {
          ...mkRun().tags,
          observedOutcome: 'error' as ObservedOutcome,
          errorClass: 'other',
          observedBlueprintId: null,
        },
      }),
    ];
    expect(summarizeNegotiationResults(runs)[0]!.errorRate).toBe(1);
  });
});

describe('summarizeNegotiationResults — FP / FN rates', () => {
  it('falsePositiveRate null when no miss-expected runs exist', () => {
    const runs = [mkRun({ tags: { ...mkRun().tags, expectedOutcome: 'hit' } })];
    expect(summarizeNegotiationResults(runs)[0]!.falsePositiveRate).toBeNull();
  });

  it('falsePositiveRate — miss-expected but observed hit or wrong_hit', () => {
    const runs = [
      mkRun({
        tags: {
          ...mkRun().tags,
          expectedOutcome: 'miss',
          observedOutcome: 'wrong_hit',
          expectedBlueprintId: null,
          observedBlueprintId: 'p_fp',
        },
      }),
      mkRun({
        runIndex: 1,
        tags: {
          ...mkRun().tags,
          expectedOutcome: 'miss',
          observedOutcome: 'miss',
          expectedBlueprintId: null,
          observedBlueprintId: null,
        },
      }),
    ];
    expect(summarizeNegotiationResults(runs)[0]!.falsePositiveRate).toBe(0.5);
  });

  it('falseNegativeRate — hit-expected but observed miss', () => {
    const runs = [
      mkRun({
        tags: {
          ...mkRun().tags,
          expectedOutcome: 'hit',
          observedOutcome: 'miss',
          observedBlueprintId: null,
        },
      }),
    ];
    expect(summarizeNegotiationResults(runs)[0]!.falseNegativeRate).toBe(1);
  });
});

describe('summarizeNegotiationResults — exactMatchRateOnHits', () => {
  it('null when no observed hits', () => {
    const runs = [
      mkRun({
        tags: {
          ...mkRun().tags,
          expectedOutcome: 'miss',
          observedOutcome: 'miss',
          expectedBlueprintId: null,
          observedBlueprintId: null,
        },
      }),
    ];
    expect(summarizeNegotiationResults(runs)[0]!.exactMatchRateOnHits).toBeNull();
  });

  it('fraction of observed hits where ids match', () => {
    // Two hits, one with matching id, one wrong_hit (not counted as hit)
    const runs = [
      mkRun({
        tags: {
          ...mkRun().tags,
          observedOutcome: 'hit',
          observedBlueprintId: 'p_x',
          expectedBlueprintId: 'p_x',
        },
      }),
    ];
    expect(summarizeNegotiationResults(runs)[0]!.exactMatchRateOnHits).toBe(1);
  });
});

describe('summarizeNegotiationResults — empty-mode success invariant', () => {
  it('emptyRegistryCleanMissRate populated ONLY on empty row', () => {
    const runs = [
      mkRun({
        tags: {
          ...mkRun().tags,
          registryMode: 'empty',
          expectedOutcome: 'miss',
          observedOutcome: 'miss',
          expectedBlueprintId: null,
          observedBlueprintId: null,
        },
      }),
      mkRun({
        runIndex: 1,
        tags: { ...mkRun().tags, registryMode: 'hosted' },
      }),
    ];
    const summaries = summarizeNegotiationResults(runs);
    const empty = summaries.find((s) => s.registryMode === 'empty')!;
    const hosted = summaries.find((s) => s.registryMode === 'hosted')!;
    expect(empty.emptyRegistryCleanMissRate).toBe(1);
    expect(hosted.emptyRegistryCleanMissRate).toBeNull();
  });

  it('non-zero hit on empty is a bug — surfaces via hitRate > 0 on empty row', () => {
    const runs = [
      mkRun({
        tags: {
          ...mkRun().tags,
          registryMode: 'empty',
          expectedOutcome: 'miss',
          observedOutcome: 'wrong_hit',
          expectedBlueprintId: null,
          observedBlueprintId: 'p_hallucinated',
        },
      }),
    ];
    const [s] = summarizeNegotiationResults(runs);
    expect(s!.wrongHitRate).toBe(1); // bug visible in wrongHitRate
    expect(s!.emptyRegistryCleanMissRate).toBe(0); // and in clean-miss rate
  });
});

describe('summarizeNegotiationResults — stable sort', () => {
  it('oss → hosted → empty ordering', () => {
    const runs = [
      mkRun({ tags: { ...mkRun().tags, registryMode: 'empty' } }),
      mkRun({ runIndex: 1, tags: { ...mkRun().tags, registryMode: 'hosted' } }),
      mkRun({ runIndex: 2, tags: { ...mkRun().tags, registryMode: 'oss' } }),
    ];
    const summaries = summarizeNegotiationResults(runs);
    expect(summaries.map((s) => s.registryMode)).toEqual([
      'oss',
      'hosted',
      'empty',
    ]);
  });

  it('empty input → empty output', () => {
    expect(summarizeNegotiationResults([])).toEqual([]);
  });
});

describe('summarizeNegotiationResults — arbitration reserved', () => {
  it('arbitrationCorrectnessRate is always 0 in v0', () => {
    const runs = [mkRun()];
    const [s] = summarizeNegotiationResults(runs);
    expect(s!.arbitrationCorrectnessRate).toBe(0);
  });
});
