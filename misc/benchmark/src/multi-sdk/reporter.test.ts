import { describe, it, expect } from 'vitest';
import {
  generateReport,
  toDisplayReport,
  JUDGE_COVERAGE_FLOOR,
  CRITERIA_COVERAGE_FLOOR,
} from './reporter';
import type { BenchmarkRunResult } from './types';
import type { PanelEvalResult } from './post-eval.js';
import type { CriterionCoverage } from '@ggui-ai/ui-gen/evaluation';

describe('judge disclosure carries effective sampling (#713)', () => {
  it('propagates each judge\'s applied sampling into meta.judges and the display report', () => {
    const dims = { layout: 80, designTokens: 80, hierarchy: 80, polish: 80, dataPresentation: 80 };
    const panel: PanelEvalResult = {
      passed: true,
      score: 80,
      dimensions: dims,
      spread: 0,
      judges: [
        {
          judge: { model: 'claude-haiku-4-5-20251001', promptVersion: 'v3', sampling: { temperature: 0 } },
          score: 80, dimensions: dims, critique: '', tokens: { input: 1, output: 1 },
        },
        {
          judge: {
            model: 'claude-opus-5',
            promptVersion: 'v3',
            sampling: { temperature: 'provider-default', strippedReason: 'claude-opus-5 rejects sampling params' },
          },
          score: 80, dimensions: dims, critique: '', tokens: { input: 1, output: 1 },
        },
      ],
      promptVersion: 'v3',
      critique: '',
      evalTimeMs: 1,
    };
    const base = outageRun();
    const run: BenchmarkRunResult = {
      ...base,
      generation: { compiledCode: 'x', sourceCode: 'x', tokens: { input: 1, output: 1, total: 2 }, generationTimeMs: 1, turnsUsed: 1 },
      evaluation: panel,
    };
    const report = generateReport([run], 0);
    expect(report.meta.judges?.map((j) => j.sampling)).toEqual([
      { temperature: 0 },
      { temperature: 'provider-default', strippedReason: 'claude-opus-5 rejects sampling params' },
    ]);
    const d = toDisplayReport(report, 'rep-1', 'test');
    expect(d.meta.judges?.[1]?.sampling?.temperature).toBe('provider-default');
  });
});

/**
 * A run where a variant's single cell failed to generate (outage shape):
 * `generation: null` + `evaluation: null`. The published variant /
 * commit summary must carry the -1 "not evaluated" sentinel, never 0
 * (which buildHeadline + the viewer would render as a real score).
 */
function outageRun(): BenchmarkRunResult {
  const now = new Date(0).toISOString();
  return {
    variant: { id: 'google-0', sdkName: 'google', tier: 'balanced', modelId: 'google/x' },
    commit: {
      id: 'weather-card',
      name: 'Weather Card',
      description: '',
      prompt: '',
      complexity: 'medium',
      contract: {},
    },
    generation: null,
    evaluation: null,
    estimatedCostUsd: 0,
    timestamp: now,
    generator: 'ui-gen-default-haiku-4-5',
  };
}

/** A run that generated successfully; `panel` controls whether it was judged. */
function generatedRun(id: string, panel: PanelEvalResult | null): BenchmarkRunResult {
  const base = outageRun();
  return {
    ...base,
    commit: { ...base.commit, id },
    generation: {
      compiledCode: 'x',
      sourceCode: 'x',
      tokens: { input: 1, output: 1, total: 2 },
      generationTimeMs: 1000,
      turnsUsed: 3,
    },
    evaluation: panel,
  };
}

function panelResult(score: number): PanelEvalResult {
  const dims = { layout: score, designTokens: score, hierarchy: score, polish: score, dataPresentation: score };
  return {
    passed: score >= 70,
    score,
    dimensions: dims,
    spread: 0,
    judges: [
      { judge: { model: 'j1', promptVersion: 'v' }, score, dimensions: dims, critique: '', tokens: { input: 1, output: 1 } },
      { judge: { model: 'j2', promptVersion: 'v' }, score, dimensions: dims, critique: '', tokens: { input: 1, output: 1 } },
    ],
    promptVersion: 'v',
    critique: '',
    evalTimeMs: 10,
  };
}

/** A generated run that went through in-loop eval; `coverage` = the instrument's rows (undefined = predates it). */
function tierEvaluatedRun(id: string, coverage: CriterionCoverage[] | undefined): BenchmarkRunResult {
  const run = generatedRun(id, panelResult(80));
  return {
    ...run,
    tierEvaluation: {
      issues: [],
      pass: ['functionality', 'crash', 'interactivity', 'accessibility', 'layout', 'loading', 'visual'],
      ...(coverage ? { criteriaCoverage: coverage } : {}),
    },
  };
}

const ALL_RAN: CriterionCoverage[] = [
  { criterion: 'functionality', tier: 1, status: 'ran' },
  { criterion: 'crash', tier: 1, status: 'ran' },
  { criterion: 'visual', tier: 2, status: 'ran' },
];
const VISUAL_SKIPPED: CriterionCoverage[] = [
  { criterion: 'functionality', tier: 1, status: 'ran' },
  { criterion: 'crash', tier: 1, status: 'ran' },
  { criterion: 'visual', tier: 2, status: 'skipped', reason: 'no tool call returned' },
];

describe('criteria coverage meta (#591 class)', () => {
  it('counts ran/skipped per criterion over tier-evaluated cells', () => {
    const report = generateReport(
      [tierEvaluatedRun('a', ALL_RAN), tierEvaluatedRun('b', VISUAL_SKIPPED)],
      0,
    );
    const visual = report.meta.criteriaCoverage?.find((c) => c.criterion === 'visual');
    expect(visual).toEqual({ criterion: 'visual', tier: 2, ran: 1, skipped: 1, unknown: 0, notApplicable: 0 });
    const crash = report.meta.criteriaCoverage?.find((c) => c.criterion === 'crash');
    expect(crash).toEqual({ criterion: 'crash', tier: 1, ran: 2, skipped: 0, unknown: 0, notApplicable: 0 });
  });

  it('counts a tier-evaluated cell without the field as unknown — never as ran', () => {
    const report = generateReport(
      [tierEvaluatedRun('a', ALL_RAN), tierEvaluatedRun('b', undefined)],
      0,
    );
    const visual = report.meta.criteriaCoverage?.find((c) => c.criterion === 'visual');
    expect(visual).toEqual({ criterion: 'visual', tier: 2, ran: 1, skipped: 0, unknown: 1, notApplicable: 0 });
  });

  it('omits criteriaCoverage entirely when no cell carries the instrument', () => {
    const report = generateReport([tierEvaluatedRun('a', undefined), generatedRun('b', null)], 0);
    expect(report.meta.criteriaCoverage).toBeUndefined();
    expect(report.meta.criteriaCoverageDegraded).toBeUndefined();
  });

  it('flags criteriaCoverageDegraded when any criterion ran under the floor', () => {
    // visual ran 1 of 3 tier-evaluated cells (33%) — under the 0.8 floor.
    const report = generateReport(
      [tierEvaluatedRun('a', ALL_RAN), tierEvaluatedRun('b', VISUAL_SKIPPED), tierEvaluatedRun('c', undefined)],
      0,
    );
    expect(1 / 3).toBeLessThan(CRITERIA_COVERAGE_FLOOR);
    expect(report.meta.criteriaCoverageDegraded).toBe(true);
  });

  it('does not flag degraded when every criterion ran at or above the floor', () => {
    const report = generateReport([tierEvaluatedRun('a', ALL_RAN), tierEvaluatedRun('b', ALL_RAN)], 0);
    expect(report.meta.criteriaCoverage).toHaveLength(3);
    expect(report.meta.criteriaCoverageDegraded).toBeUndefined();
  });

  it('excludes not-applicable rows (evaluator bypassed by design) from the denominator', () => {
    // Contract (ui-gen): a same-image low-risk bypass cell stamps one
    // `not-applicable` row per criterion — no criterion was applicable, so
    // the cell is evidence neither for nor against any criterion.
    const bypass: CriterionCoverage[] = ALL_RAN.map((c) => ({
      ...c,
      status: 'not-applicable',
      reason: 'same-image low-risk bypass',
    }));
    const report = generateReport([tierEvaluatedRun('a', ALL_RAN), tierEvaluatedRun('b', bypass)], 0);
    const visual = report.meta.criteriaCoverage?.find((c) => c.criterion === 'visual');
    // The bypass cell is COUNTED as not-applicable (visible), not in the denominator.
    expect(visual).toEqual({ criterion: 'visual', tier: 2, ran: 1, skipped: 0, unknown: 0, notApplicable: 1 });
    expect(report.meta.criteriaCoverageDegraded).toBeUndefined();
  });

  it('an all-bypass run is INSTRUMENT PRESENT with everything not-applicable — never "absent"', () => {
    // rnd, Exp 006: 18 low-risk cells, every row not-applicable, read as
    // "(0,0,0,9) = absent" — the exact conflation the instrument exists to kill.
    const bypass: CriterionCoverage[] = ALL_RAN.map((c) => ({
      ...c,
      status: 'not-applicable',
      reason: 'same-image low-risk bypass',
    }));
    const report = generateReport([tierEvaluatedRun('a', bypass), tierEvaluatedRun('b', bypass)], 0);
    expect(report.meta.criteriaCoverage).toHaveLength(3);
    expect(report.meta.criteriaCoverage?.[0]).toEqual({
      criterion: 'functionality', tier: 1, ran: 0, skipped: 0, unknown: 0, notApplicable: 2,
    });
    expect(report.meta.criteriaCoverageDegraded).toBeUndefined();
  });

  it('treats an empty criteriaCoverage array as unknown — ui-gen never emits it', () => {
    const report = generateReport([tierEvaluatedRun('a', ALL_RAN), tierEvaluatedRun('b', [])], 0);
    const visual = report.meta.criteriaCoverage?.find((c) => c.criterion === 'visual');
    expect(visual).toEqual({ criterion: 'visual', tier: 2, ran: 1, skipped: 0, unknown: 1, notApplicable: 0 });
  });

  it('propagates meta summary and per-cell rows to the display report', () => {
    const report = generateReport([tierEvaluatedRun('a', VISUAL_SKIPPED)], 0);
    const d = toDisplayReport(report, 'rep-1', 'test');
    expect(d.meta.criteriaCoverage?.find((c) => c.criterion === 'visual')?.skipped).toBe(1);
    expect(d.meta.criteriaCoverageDegraded).toBe(true);
    expect(d.results[0]?.tierEvaluation?.criteriaCoverage).toEqual(VISUAL_SKIPPED);
  });
});

describe('judge coverage meta (#565)', () => {
  it('reports evaluatedCount and judgeCoverage over the generated subset', () => {
    const report = generateReport(
      [generatedRun('a', panelResult(80)), generatedRun('b', null), outageRun()],
      0,
    );
    expect(report.meta.evaluatedCount).toBe(1);
    expect(report.meta.judgeCoverage).toBe(0.5);
  });

  it('flags judgeCoverageDegraded when coverage is under the floor', () => {
    const report = generateReport(
      [generatedRun('a', panelResult(80)), generatedRun('b', null), generatedRun('c', null)],
      0,
    );
    expect(report.meta.judgeCoverage).toBeLessThan(JUDGE_COVERAGE_FLOOR);
    expect(report.meta.judgeCoverageDegraded).toBe(true);
  });

  it('does not flag degraded at full coverage', () => {
    const report = generateReport(
      [generatedRun('a', panelResult(80)), generatedRun('b', panelResult(90))],
      0,
    );
    expect(report.meta.judgeCoverage).toBe(1);
    expect(report.meta.judgeCoverageDegraded).toBeUndefined();
  });

  it('does not flag degraded when evaluation was deliberately skipped', () => {
    const report = generateReport([generatedRun('a', null)], 0, { evaluationSkipped: true });
    expect(report.meta.evaluatedCount).toBe(0);
    expect(report.meta.judgeCoverage).toBe(0);
    expect(report.meta.judgeCoverageDegraded).toBeUndefined();
  });

  it('does not flag degraded on a total generation outage (no eligible cells)', () => {
    const report = generateReport([outageRun()], 0);
    expect(report.meta.judgeCoverage).toBe(0);
    expect(report.meta.judgeCoverageDegraded).toBeUndefined();
  });

  it('propagates coverage fields to the display report', () => {
    const report = generateReport([generatedRun('a', panelResult(80)), generatedRun('b', null), generatedRun('c', null)], 0);
    const d = toDisplayReport(report, 'rep-1', 'test');
    expect(d.meta.evaluatedCount).toBe(1);
    expect(d.meta.judgeCoverage).toBeCloseTo(1 / 3, 5);
    expect(d.meta.judgeCoverageDegraded).toBe(true);
  });
});

describe('toDisplayReport outage handling', () => {
  it('emits -1 (not 0) for a variant whose cells all failed to generate', () => {
    const report = generateReport([outageRun()], 0);
    const d = toDisplayReport(report, 'rep-1', 'test');
    const v = d.variantSummaries.find((s) => s.variantId === 'google-0');
    expect(v).toBeDefined();
    expect(v!.avgScore).toBe(-1);
  });

  it('emits -1 (not 0) for a commit whose cells all failed to generate', () => {
    const report = generateReport([outageRun()], 0);
    const d = toDisplayReport(report, 'rep-1', 'test');
    const c = d.commitSummaries.find((s) => s.commitId === 'weather-card');
    expect(c).toBeDefined();
    expect(c!.avgScore).toBe(-1);
  });
});
