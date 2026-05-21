/**
 * Floor-dimension tests — narrow scope:
 *
 *   1. `applyFloor` helper — tag + suffix semantics, idempotence,
 *      undefined passthrough (preserves pre-floor behavior).
 *   2. `buildFloorSummaries` reporter — grouping, error-bucket sum,
 *      predefined-tool metrics, single-floor arrays.
 *
 * Runner-level floor propagation is covered by the existing bench
 * integration — adding another real-LLM integration test here would
 * double the cost for no coverage gain.
 */

import { describe, expect, it } from 'vitest';
import { applyFloor } from './variants';
import { buildFloorSummaries } from './reporter';
import type { BenchmarkRunResult, BenchmarkVariant } from './types';

function mkVariant(overrides: Partial<BenchmarkVariant> = {}): BenchmarkVariant {
  return {
    id: 'claude-fast',
    sdkName: 'claude',
    tier: 'fast',
    modelId: 'anthropic/claude-haiku-4-5',
    ...overrides,
  };
}

describe('applyFloor', () => {
  it('undefined floor — passes variants through unchanged (preserves historical behavior)', () => {
    const input = [mkVariant()];
    const out = applyFloor(input, undefined);
    expect(out).toHaveLength(1);
    expect(out[0]!.floor).toBeUndefined();
    expect(out[0]!.id).toBe('claude-fast');
  });

  it('explicit oss floor — tags and suffixes', () => {
    const out = applyFloor([mkVariant()], 'oss');
    expect(out[0]!.floor).toBe('oss');
    expect(out[0]!.id).toBe('claude-fast-oss');
  });

  it('hosted floor — tags and suffixes', () => {
    const out = applyFloor([mkVariant()], 'hosted');
    expect(out[0]!.floor).toBe('hosted');
    expect(out[0]!.id).toBe('claude-fast-hosted');
  });

  it('idempotent — re-applying the same floor does not double the suffix', () => {
    const once = applyFloor([mkVariant()], 'hosted');
    const twice = applyFloor(once, 'hosted');
    expect(twice[0]!.id).toBe('claude-fast-hosted');
    expect(twice[0]!.floor).toBe('hosted');
  });

  it('does not mutate input variants (pure)', () => {
    const input: BenchmarkVariant[] = [mkVariant()];
    const snapshot = JSON.stringify(input);
    applyFloor(input, 'hosted');
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('preserves other variant fields unchanged', () => {
    const input = mkVariant({
      modelRoles: { thinking: 'anthropic/claude-opus-4-6' },
      rendering: { device: 'mobile', shell: 'chat' } as unknown as BenchmarkVariant['rendering'],
    });
    const [tagged] = applyFloor([input], 'hosted');
    expect(tagged!.modelRoles).toEqual(input.modelRoles);
    expect(tagged!.rendering).toEqual(input.rendering);
  });

  it('handles empty input', () => {
    expect(applyFloor([], 'hosted')).toEqual([]);
    expect(applyFloor([], undefined)).toEqual([]);
  });
});

// ─── buildFloorSummaries ────────────────────────────────────────────

/**
 * GenerationResult extends AdapterResult with a `breakdown` field the
 * reporter's floor aggregation reads via runtime checks. Tests
 * construct the wider shape and cast once at the seam — matches how
 * `generation-dispatch.ts` produces the value at runtime.
 */
type GenerationWithBreakdown = NonNullable<BenchmarkRunResult['generation']> & {
  breakdown?: {
    phases: { impl: number; patch: number; evalFix: number };
    outcomes: {
      pass: number;
      patchInvalid: number;
      selfCheckFail: number;
      diffFail: number;
    };
    evalRounds: number;
    llmMs: number;
    toolMs: number;
    evalMs: number;
  };
};

function mkGeneration(
  breakdownOutcomes?: GenerationWithBreakdown['breakdown'] extends infer B
    ? B extends { outcomes: infer O }
      ? O
      : never
    : never,
): BenchmarkRunResult['generation'] {
  const gen: GenerationWithBreakdown = {
    sourceCode: 'x',
    componentCode: 'x',
    compiledCode: 'x',
    turnsUsed: 3,
    tokens: { input: 100, output: 100, total: 200 },
    generationTimeMs: 10_000,
    finishReason: 'stop',
  } as GenerationWithBreakdown;
  if (breakdownOutcomes !== undefined) {
    gen.breakdown = {
      phases: { impl: 1, patch: 1, evalFix: 1 },
      outcomes: breakdownOutcomes,
      evalRounds: 1,
      llmMs: 8000,
      toolMs: 1000,
      evalMs: 1000,
    };
  }
  return gen;
}

function mkRun(overrides: Partial<BenchmarkRunResult>): BenchmarkRunResult {
  return {
    variant: mkVariant(),
    commit: {
      id: 'weather-card',
      name: 'Weather',
      description: '',
      complexity: 'simple',
      prompt: '',
      contract: { propsSpec: { properties: {} } },
    },
    generation: mkGeneration({
      pass: 3,
      patchInvalid: 0,
      selfCheckFail: 0,
      diffFail: 0,
    }),
    evaluation: { finalScore: 75 } as BenchmarkRunResult['evaluation'],
    estimatedCostUsd: 0.01,
    timestamp: '2026-04-20T00:00:00Z',
    floor: 'oss',
    pathUsage: {
      predefinedToolAvailable: false,
      predefinedToolCalls: 0,
      capHit: false,
    },
    generator: 'ui-gen-default-haiku-4-5',
    ...overrides,
  };
}

describe('buildFloorSummaries', () => {
  it('groups by floor — single floor produces length-1 array (no blank row)', () => {
    const summaries = buildFloorSummaries([mkRun({ floor: 'oss' }), mkRun({ floor: 'oss' })]);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.floor).toBe('oss');
    expect(summaries[0]!.runs).toBe(2);
  });

  it('orders oss before hosted so side-by-side reads baseline→hosted', () => {
    const summaries = buildFloorSummaries([
      mkRun({ floor: 'hosted' }),
      mkRun({ floor: 'oss' }),
    ]);
    expect(summaries.map((s) => s.floor)).toEqual(['oss', 'hosted']);
  });

  it('successRate counts ALL runs (including failures); avgTime only successful runs', () => {
    const failedRun = mkRun({
      floor: 'oss',
      generation: null,
      evaluation: null,
      error: 'timeout',
    });
    const successfulRun = mkRun({ floor: 'oss' });
    const [summary] = buildFloorSummaries([failedRun, successfulRun]);
    expect(summary!.runs).toBe(2);
    expect(summary!.successRate).toBe(0.5);
    // avgTime averages only the one successful run's 10_000ms
    expect(summary!.avgTimeMs).toBe(10_000);
  });

  it('capHitRate counts ALL runs (including failures)', () => {
    const capped = mkRun({
      floor: 'oss',
      pathUsage: {
        predefinedToolAvailable: false,
        predefinedToolCalls: 0,
        capHit: true,
      },
    });
    const summaries = buildFloorSummaries([capped, mkRun({ floor: 'oss' })]);
    expect(summaries[0]!.capHitRate).toBe(0.5);
  });

  it('predefinedToolCallRate — fraction of runs where the tool was called', () => {
    const called = mkRun({
      floor: 'hosted',
      pathUsage: {
        predefinedToolAvailable: true,
        predefinedToolCalls: 2,
        capHit: false,
      },
    });
    const notCalled = mkRun({
      floor: 'hosted',
      pathUsage: {
        predefinedToolAvailable: true,
        predefinedToolCalls: 0,
        capHit: false,
      },
    });
    const summaries = buildFloorSummaries([called, notCalled]);
    expect(summaries[0]!.predefinedToolCallRate).toBe(0.5);
    expect(summaries[0]!.avgPredefinedToolCalls).toBe(1); // (2 + 0) / 2
  });

  it('oss floor always shows 0 predefined-tool metrics (tool structurally absent)', () => {
    const [summary] = buildFloorSummaries([mkRun({ floor: 'oss' })]);
    expect(summary!.predefinedToolCallRate).toBe(0);
    expect(summary!.avgPredefinedToolCalls).toBe(0);
  });

  it('errorBuckets — sums breakdown.outcomes across runs on the same floor', () => {
    const r1 = mkRun({
      floor: 'oss',
      generation: mkGeneration({ pass: 2, patchInvalid: 3, selfCheckFail: 1, diffFail: 0 }),
    });
    const r2 = mkRun({
      floor: 'oss',
      generation: mkGeneration({ pass: 1, patchInvalid: 2, selfCheckFail: 0, diffFail: 1 }),
    });
    const [s] = buildFloorSummaries([r1, r2]);
    expect(s!.errorBuckets).toEqual({
      pass: 3,
      patchInvalid: 5,
      selfCheckFail: 1,
      diffFail: 1,
    });
  });

  it('runs with no breakdown contribute 0 to error buckets (no regress on the sum)', () => {
    // mkRun's default generation carries breakdown with pass=3.
    const withBreakdown = mkRun({ floor: 'oss' });
    // Pass `undefined` to mkGeneration to produce a generation
    // WITHOUT a breakdown field (older adapter-raw path).
    const withoutBreakdown = mkRun({
      floor: 'oss',
      generation: mkGeneration(undefined),
    });
    const [s] = buildFloorSummaries([withBreakdown, withoutBreakdown]);
    // Only the run-with-breakdown contributes. pass=3, rest zero.
    expect(s!.errorBuckets).toEqual({
      pass: 3,
      patchInvalid: 0,
      selfCheckFail: 0,
      diffFail: 0,
    });
  });

  it('empty input → empty array', () => {
    expect(buildFloorSummaries([])).toEqual([]);
  });
});
