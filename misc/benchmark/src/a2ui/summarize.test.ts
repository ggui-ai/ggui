/**
 * Summarizer tests — pin the aggregation + null-as-signal shape
 * on inputs constructed explicitly (no dependency on the runner).
 */

import { describe, expect, it } from 'vitest';
import { reduceA2uiMinMedianMax, summarizeA2uiResults } from './summarize.js';
import type { A2uiRunResult } from './types.js';

describe('reduceA2uiMinMedianMax', () => {
  it('odd count — median is middle element', () => {
    expect(reduceA2uiMinMedianMax([10, 30, 20])).toEqual({
      count: 3,
      nullCount: 0,
      min: 10,
      median: 20,
      max: 30,
    });
  });

  it('even count — median averages middle two', () => {
    const s = reduceA2uiMinMedianMax([10, 20, 30, 40]);
    expect(s.median).toBe(25);
    expect(s.count).toBe(4);
  });

  it('nulls separated from min/median/max math', () => {
    const s = reduceA2uiMinMedianMax([10, null, 30, null, 20]);
    expect(s).toEqual({
      count: 3,
      nullCount: 2,
      min: 10,
      median: 20,
      max: 30,
    });
  });

  it('all null → every stat null; nullCount preserved', () => {
    expect(reduceA2uiMinMedianMax([null, null])).toEqual({
      count: 0,
      nullCount: 2,
      min: null,
      median: null,
      max: null,
    });
  });

  it('empty input → zero counts', () => {
    expect(reduceA2uiMinMedianMax([])).toEqual({
      count: 0,
      nullCount: 0,
      min: null,
      median: null,
      max: null,
    });
  });
});

// ── Summary grouping + aggregation ─────────────────────────────────

function mkRun(overrides: Partial<A2uiRunResult> = {}): A2uiRunResult {
  const checkpoints = overrides.checkpoints ?? {
    startedAt: 100,
    firstFrameAt: 110,
    previewFinalizedAt: 150,
    handoffGapMs: null,
  };
  const frames = overrides.frames ?? {
    frameCount: 4,
    parsePassCount: 4,
    parseFailCount: 0,
  };
  const tags = overrides.tags ?? {
    caseId: 'form-feedback',
    intentShape: 'form' as const,
    previewExpected: true,
    previewObserved: true,
    finalizeObserved: true,
  };
  return {
    caseId: tags.caseId,
    runIndex: overrides.runIndex ?? 0,
    checkpoints,
    frames,
    tags,
    derived: {
      timeToFirstFrame:
        checkpoints.firstFrameAt === null
          ? null
          : checkpoints.firstFrameAt - checkpoints.startedAt,
      timeToPreviewFinalize:
        checkpoints.previewFinalizedAt === null
          ? null
          : checkpoints.previewFinalizedAt - checkpoints.startedAt,
      parsePassRate:
        frames.frameCount === 0
          ? null
          : frames.parsePassCount / frames.frameCount,
      framesBeforeFinalize:
        checkpoints.previewFinalizedAt === null ? null : frames.frameCount,
    },
    parseIssueSamples: [],
    errors: [],
  };
}

describe('summarizeA2uiResults', () => {
  it('groups by intent shape — one shape produces length-1 array', () => {
    const s = summarizeA2uiResults([mkRun(), mkRun({ runIndex: 1 })]);
    expect(s).toHaveLength(1);
    expect(s[0]!.intentShape).toBe('form');
    expect(s[0]!.runs).toBe(2);
  });

  it('stable ordering: form, list, minimal', () => {
    const out = summarizeA2uiResults([
      mkRun({ tags: { caseId: 'x', intentShape: 'minimal', previewExpected: true, previewObserved: true, finalizeObserved: true } }),
      mkRun({ tags: { caseId: 'x', intentShape: 'list', previewExpected: true, previewObserved: true, finalizeObserved: true } }),
      mkRun({ tags: { caseId: 'x', intentShape: 'form', previewExpected: true, previewObserved: true, finalizeObserved: true } }),
    ]);
    expect(out.map((s) => s.intentShape)).toEqual(['form', 'list', 'minimal']);
  });

  it('previewExpectedButMissingCount — expected but not observed flags regressions', () => {
    const observed = mkRun();
    const missed = mkRun({
      tags: {
        caseId: 'form-feedback',
        intentShape: 'form',
        previewExpected: true,
        previewObserved: false,
        finalizeObserved: true,
      },
      checkpoints: {
        startedAt: 100,
        firstFrameAt: null, // the key difference
        previewFinalizedAt: 150,
        handoffGapMs: null,
      },
    });
    const [s] = summarizeA2uiResults([observed, missed]);
    expect(s!.previewExpectedButMissingCount).toBe(1);
  });

  it('does NOT flag previewExpected=false runs', () => {
    const tolerated = mkRun({
      tags: {
        caseId: 'minimal-no-preview',
        intentShape: 'minimal',
        previewExpected: false,
        previewObserved: false,
        finalizeObserved: false,
      },
    });
    const [s] = summarizeA2uiResults([tolerated]);
    expect(s!.previewExpectedButMissingCount).toBe(0);
  });

  it('parse-failure aggregation — runsWithParseFailures + totalParseFailures', () => {
    const clean = mkRun();
    const oneFail = mkRun({
      runIndex: 1,
      frames: { frameCount: 4, parsePassCount: 3, parseFailCount: 1 },
    });
    const manyFail = mkRun({
      runIndex: 2,
      frames: { frameCount: 4, parsePassCount: 1, parseFailCount: 3 },
    });
    const [s] = summarizeA2uiResults([clean, oneFail, manyFail]);
    expect(s!.runsWithParseFailures).toBe(2);
    expect(s!.totalParseFailures).toBe(4);
  });

  it('timeToFirstFrame aggregation — null-safe across a mixed run set', () => {
    const observed = mkRun(); // firstFrameAt=110, ttf=10
    const missed = mkRun({
      runIndex: 1,
      tags: {
        caseId: 'form-feedback',
        intentShape: 'form',
        previewExpected: true,
        previewObserved: false,
        finalizeObserved: true,
      },
      checkpoints: {
        startedAt: 100,
        firstFrameAt: null,
        previewFinalizedAt: 150,
        handoffGapMs: null,
      },
    });
    const [s] = summarizeA2uiResults([observed, missed]);
    expect(s!.timeToFirstFrame.count).toBe(1);
    expect(s!.timeToFirstFrame.nullCount).toBe(1);
    expect(s!.timeToFirstFrame.min).toBe(10);
    expect(s!.timeToFirstFrame.max).toBe(10);
  });

  it('empty input → empty array', () => {
    expect(summarizeA2uiResults([])).toEqual([]);
  });
});
