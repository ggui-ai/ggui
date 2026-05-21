/**
 * Summarizer tests — the aggregation layer is where the null-as-signal
 * convention becomes observable. These pin:
 *
 *   - min/median/max correctness on odd + even sample counts
 *   - nullCount separation (null runs do NOT enter min/median/max math)
 *   - grouping by branch path
 *   - previewExpectedButMissingCount — the primary regression signal
 */

import { describe, expect, it } from 'vitest';
import { reduceMinMedianMax, summarizeResults } from './summarize.js';
import type { SloRunResult } from './types.js';

describe('reduceMinMedianMax', () => {
  it('odd count — median is middle element', () => {
    const s = reduceMinMedianMax([10, 20, 30]);
    expect(s).toEqual({
      count: 3,
      nullCount: 0,
      min: 10,
      median: 20,
      max: 30,
    });
  });

  it('even count — median is average of two middle elements', () => {
    const s = reduceMinMedianMax([10, 20, 30, 40]);
    expect(s.median).toBe(25);
    expect(s.min).toBe(10);
    expect(s.max).toBe(40);
    expect(s.count).toBe(4);
  });

  it('unsorted input — reducer sorts before computing median', () => {
    const s = reduceMinMedianMax([30, 10, 20]);
    expect(s.min).toBe(10);
    expect(s.median).toBe(20);
    expect(s.max).toBe(30);
  });

  it('nulls are separated from min/median/max math', () => {
    const s = reduceMinMedianMax([10, null, 30, null, 20]);
    expect(s.count).toBe(3);
    expect(s.nullCount).toBe(2);
    expect(s.min).toBe(10);
    expect(s.median).toBe(20);
    expect(s.max).toBe(30);
  });

  it('all null input → every stat null, nullCount accurate', () => {
    const s = reduceMinMedianMax([null, null, null]);
    expect(s).toEqual({
      count: 0,
      nullCount: 3,
      min: null,
      median: null,
      max: null,
    });
  });

  it('empty input → zero counts, null stats', () => {
    const s = reduceMinMedianMax([]);
    expect(s).toEqual({
      count: 0,
      nullCount: 0,
      min: null,
      median: null,
      max: null,
    });
  });
});

function mkRun(overrides: Partial<SloRunResult>): SloRunResult {
  return {
    caseId: 'x',
    runIndex: 0,
    checkpoints: {
      startedAt: 0,
      firstPreviewAt: 10,
      previewFinalizedAt: 40,
      finalCompiledAt: 5,
      finalDomVisibleAt: null,
    },
    tags: {
      path: 'blueprint_hit',
      previewFrames: 1,
      usedBlueprint: true,
      usedGeneration: false,
      previewExpected: true,
      previewObserved: true,
      finalCompiledReliable: false,
    },
    derived: {
      timeToFirstPreview: 10,
      timeToPreviewFinalize: 40,
      timeToFinalCompiled: 5,
      timeToFinalVisible: null,
    },
    errors: [],
    ...overrides,
  };
}

describe('summarizeResults', () => {
  it('groups by branch path and aggregates each group independently', () => {
    const results = [
      mkRun({ tags: { ...mkRun({}).tags, path: 'blueprint_hit' } }),
      mkRun({
        runIndex: 1,
        tags: { ...mkRun({}).tags, path: 'blueprint_hit' },
      }),
      mkRun({
        runIndex: 0,
        tags: {
          ...mkRun({}).tags,
          path: 'oss_miss',
          previewFrames: 0,
          previewExpected: false,
          previewObserved: false,
          usedBlueprint: false,
        },
        derived: {
          timeToFirstPreview: null,
          timeToPreviewFinalize: null,
          timeToFinalCompiled: 5,
          timeToFinalVisible: null,
        },
      }),
    ];
    const summary = summarizeResults(results);
    expect(summary).toHaveLength(2);
    const bp = summary.find((s) => s.path === 'blueprint_hit')!;
    expect(bp.runs).toBe(2);
    expect(bp.timeToFirstPreview.count).toBe(2);
    expect(bp.timeToFirstPreview.nullCount).toBe(0);

    const oss = summary.find((s) => s.path === 'oss_miss')!;
    expect(oss.runs).toBe(1);
    expect(oss.timeToFirstPreview.count).toBe(0);
    expect(oss.timeToFirstPreview.nullCount).toBe(1);
    expect(oss.previewObservedCount).toBe(0);
  });

  it('sorts summaries by path for stable output', () => {
    const summary = summarizeResults([
      mkRun({ tags: { ...mkRun({}).tags, path: 'oss_miss' } }),
      mkRun({ tags: { ...mkRun({}).tags, path: 'blueprint_hit' } }),
      mkRun({ tags: { ...mkRun({}).tags, path: 'generation_miss' } }),
    ]);
    expect(summary.map((s) => s.path)).toEqual([
      'blueprint_hit',
      'generation_miss',
      'oss_miss',
    ]);
  });

  it('previewExpectedButMissingCount flags expected-but-absent frames', () => {
    // Case where emitter was wired (expected) but no frame landed
    // (observed false) — the regression signal.
    const results = [
      mkRun({
        tags: {
          ...mkRun({}).tags,
          previewExpected: true,
          previewObserved: false,
        },
      }),
      mkRun({
        runIndex: 1,
        tags: {
          ...mkRun({}).tags,
          previewExpected: true,
          previewObserved: true,
        },
      }),
    ];
    const [s] = summarizeResults(results);
    expect(s!.previewExpectedButMissingCount).toBe(1);
    expect(s!.previewObservedCount).toBe(1);
  });

  it('oss_miss: previewExpected=false runs do NOT trigger missing signal', () => {
    const results = [
      mkRun({
        tags: {
          ...mkRun({}).tags,
          path: 'oss_miss',
          previewExpected: false,
          previewObserved: false,
        },
      }),
    ];
    const [s] = summarizeResults(results);
    // Expected=false + observed=false is the legitimate case, not a regression.
    expect(s!.previewExpectedButMissingCount).toBe(0);
    expect(s!.previewObservedCount).toBe(0);
  });

  it('empty input → empty summary array', () => {
    expect(summarizeResults([])).toEqual([]);
  });
});
