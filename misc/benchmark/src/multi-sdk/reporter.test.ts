import { describe, it, expect } from 'vitest';
import { generateReport, toDisplayReport } from './reporter';
import type { BenchmarkRunResult } from './types';

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
    commit: { id: 'weather-card', name: 'Weather Card', complexity: 'medium' },
    generation: null,
    evaluation: null,
    estimatedCostUsd: 0,
    timestamp: now,
    generator: 'ui-gen-default-haiku-4-5',
  } as unknown as BenchmarkRunResult;
}

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
