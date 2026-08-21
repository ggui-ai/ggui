import { describe, it, expect } from 'vitest';
import { generateReport, toDisplayReport, JUDGE_COVERAGE_FLOOR } from './reporter';
import type { BenchmarkRunResult } from './types';
import type { PanelEvalResult } from './post-eval.js';

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
