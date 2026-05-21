/**
 * Multi-generator dimension tests (MVB-8).
 *
 * Narrow scope:
 *   1. `getGeneratorVariants` — returns the locked 2-variant preset.
 *   2. `resolveGeneratorSlug` — variant routing through the default
 *      + explicit slug paths.
 *   3. `BenchmarkRunner.runSingle` — generator dispatch for unknown
 *      slug + advanced-without-playwright + advanced-with-playwright
 *      (mocked).
 *   4. `formatVarianceBlock` — prompt projection.
 *   5. `buildGeneratorComparisonMatrix` + `buildGeneratorSummaries`
 *      — matrix shape + aggregation.
 *   6. `PERSONALIZATION_COMMITS` — corpus shape.
 *   7. Integration — 2 commits × 2 generators = 4 cells, all rows
 *      populated in the report.
 *
 * No real LLM calls — adapters are absent from the runner so unknown
 * generators / playwright-missing short-circuits trigger first.
 */
import { describe, it, expect } from 'vitest';
import {
  GeneratorAdapter,
  type GenerateParams,
} from '@ggui-ai/ui-gen/adapters/index';
import type { AdapterResult, AdapterMode, ProviderName } from '@ggui-ai/ui-gen/adapters/types';
import {
  BenchmarkRunner,
  formatVarianceBlock,
  resolveGeneratorSlug,
} from './runner';
import { getGeneratorVariants } from './variants';
import {
  PERSONALIZATION_COMMITS,
  BENCHMARK_COMMITS,
} from './commits';
import {
  buildGeneratorComparisonMatrix,
  buildGeneratorSummaries,
  generateReport,
  renderReportMarkdown,
} from './reporter';
import {
  ADVANCED_GENERATOR_SLUG,
  DEFAULT_GENERATOR_SLUG,
  type BenchmarkRunResult,
  type BenchmarkVariant,
  type BenchmarkCommit,
} from './types';

// =============================================================================
// 1. Variant presets
// =============================================================================

describe('getGeneratorVariants', () => {
  it('returns exactly two variants comparing default vs advanced generators', () => {
    const variants = getGeneratorVariants();
    expect(variants).toHaveLength(2);
    const ids = variants.map((v) => v.id);
    expect(ids).toContain('gen-default-haiku');
    expect(ids).toContain('gen-advanced-opus');
  });

  it('uses the locked generator slugs', () => {
    const variants = getGeneratorVariants();
    const slugs = variants.map((v) => v.generator);
    expect(slugs).toContain(DEFAULT_GENERATOR_SLUG);
    expect(slugs).toContain(ADVANCED_GENERATOR_SLUG);
  });

  it('default-haiku variant targets the fast Claude tier', () => {
    const variant = getGeneratorVariants().find(
      (v) => v.generator === DEFAULT_GENERATOR_SLUG,
    );
    expect(variant?.sdkName).toBe('claude');
    expect(variant?.tier).toBe('fast');
  });
});

// =============================================================================
// 2. resolveGeneratorSlug
// =============================================================================

describe('resolveGeneratorSlug', () => {
  function mkVariant(overrides: Partial<BenchmarkVariant> = {}): BenchmarkVariant {
    return {
      id: 'claude-fast',
      sdkName: 'claude',
      tier: 'fast',
      modelId: 'anthropic/claude-haiku-4-5',
      ...overrides,
    };
  }

  it('defaults to ui-gen-default-haiku-4-5 when variant.generator is absent', () => {
    expect(resolveGeneratorSlug(mkVariant())).toBe(DEFAULT_GENERATOR_SLUG);
  });

  it('returns the explicit slug when set', () => {
    expect(
      resolveGeneratorSlug(mkVariant({ generator: ADVANCED_GENERATOR_SLUG })),
    ).toBe(ADVANCED_GENERATOR_SLUG);
  });

  it('collapses empty/whitespace generator strings to the default', () => {
    expect(resolveGeneratorSlug(mkVariant({ generator: '' }))).toBe(
      DEFAULT_GENERATOR_SLUG,
    );
    expect(resolveGeneratorSlug(mkVariant({ generator: '   ' }))).toBe(
      DEFAULT_GENERATOR_SLUG,
    );
  });
});

// =============================================================================
// 3. Runner generator dispatch (mock adapter — never makes real LLM calls)
// =============================================================================

/**
 * Minimal adapter stub that satisfies `isAvailable()` so the runner's
 * task-filter doesn't drop the test variant before `runSingle()` is
 * called. `generate()` throws if dispatch ever actually invokes it —
 * MVB-8 dispatch tests assert short-circuit paths (unknown slug,
 * advanced-missing-playwright) that resolve BEFORE generate runs.
 */
class MockAdapter extends GeneratorAdapter {
  readonly provider: ProviderName = 'claude';
  readonly mode: AdapterMode = 'raw';
  readonly displayName = 'Mock';
  isAvailable(): boolean {
    return true;
  }
  async generate(_params: GenerateParams): Promise<AdapterResult> {
    throw new Error(
      'MockAdapter.generate should not be invoked — MVB-8 dispatch tests short-circuit before generate.',
    );
  }
}

describe('BenchmarkRunner generator dispatch', () => {
  const commit: BenchmarkCommit = {
    id: 'weather-card',
    name: 'Weather Card',
    description: '',
    complexity: 'simple',
    prompt: 'prompt',
    contract: { intent: 'test' } as BenchmarkCommit['contract'],
  };

  function makeRunnerWithMockAdapter(
    config: ConstructorParameters<typeof BenchmarkRunner>[0] = {},
  ): BenchmarkRunner {
    const runner = new BenchmarkRunner(config);
    runner.registerAdapter(new MockAdapter({}));
    return runner;
  }

  it('advanced generator without Playwright → SKIP with clear error message', async () => {
    const runner = makeRunnerWithMockAdapter();
    const report = await runner.run({
      variants: [{
        id: 'claude-advanced',
        sdkName: 'claude',
        tier: 'balanced',
        modelId: 'anthropic/claude-opus-4-7',
        generator: ADVANCED_GENERATOR_SLUG,
      }],
      commits: [commit],
    });
    expect(report.results).toHaveLength(1);
    expect(report.results[0]!.generator).toBe(ADVANCED_GENERATOR_SLUG);
    expect(report.results[0]!.error).toMatch(/requires Playwright/);
    expect(report.results[0]!.generation).toBeNull();
  });

  it('unknown generator slug → SKIP with clear error message', async () => {
    const runner = makeRunnerWithMockAdapter();
    const report = await runner.run({
      variants: [{
        id: 'claude-unknown',
        sdkName: 'claude',
        tier: 'fast',
        modelId: 'anthropic/claude-haiku-4-5',
        generator: 'ui-gen-future-experimental-llm',
      }],
      commits: [commit],
    });
    expect(report.results).toHaveLength(1);
    expect(report.results[0]!.error).toMatch(/Unknown generator slug/);
    expect(report.results[0]!.generator).toBe('ui-gen-future-experimental-llm');
  });

  it('advanced generator with Playwright stub → passes the gate, then routes to dispatch (errors downstream is OK)', async () => {
    // With playwright stubbed, the advanced-not-available SKIP is
    // bypassed. The run will go on to invoke dispatchGeneration which
    // fails because MockAdapter throws — that's fine; the dispatch
    // failure shows up as `error` on the result, the `generator` field
    // still records the slug, and we've proved the gate is configurable.
    const runner = makeRunnerWithMockAdapter({
      // Field is read off the config object via narrow shape check
      // (`{ playwright?: { chromium?: unknown } }`) in the runner.
      playwright: { chromium: {} },
    } as ConstructorParameters<typeof BenchmarkRunner>[0]);
    const report = await runner.run({
      variants: [{
        id: 'claude-advanced',
        sdkName: 'claude',
        tier: 'balanced',
        modelId: 'anthropic/claude-opus-4-7',
        generator: ADVANCED_GENERATOR_SLUG,
      }],
      commits: [commit],
    });
    expect(report.results).toHaveLength(1);
    expect(report.results[0]!.generator).toBe(ADVANCED_GENERATOR_SLUG);
    // Either the gate passed (and dispatch failed with a different
    // error) or the result is still classified as a Playwright-skip
    // — we explicitly assert it's NOT the playwright-missing message.
    expect(report.results[0]!.error ?? '').not.toMatch(/requires Playwright/);
  });
});

// =============================================================================
// 4. formatVarianceBlock
// =============================================================================

describe('formatVarianceBlock', () => {
  it('returns empty string when variance is undefined', () => {
    expect(formatVarianceBlock(undefined)).toBe('');
  });

  it('returns empty string when variance has no recognized fields', () => {
    expect(formatVarianceBlock({})).toBe('');
  });

  it('projects persona / aesthetic / seedPrompt into a prompt block', () => {
    const block = formatVarianceBlock({
      persona: 'minimalist',
      aesthetic: 'flat',
      seedPrompt: 'monochrome accent',
    });
    expect(block).toContain('## Variance Hint');
    expect(block).toContain('Persona: minimalist');
    expect(block).toContain('Aesthetic: flat');
    expect(block).toContain('Style note: monochrome accent');
  });
});

// =============================================================================
// 5. Reporter — buildGeneratorComparisonMatrix + summaries
// =============================================================================

function mkResult(overrides: Partial<BenchmarkRunResult> = {}): BenchmarkRunResult {
  return {
    variant: {
      id: 'claude-fast',
      sdkName: 'claude',
      tier: 'fast',
      modelId: 'anthropic/claude-haiku-4-5',
    },
    commit: {
      id: 'weather-card',
      name: 'Weather Card',
      description: '',
      complexity: 'simple',
      prompt: '',
      contract: { intent: 'test' } as BenchmarkCommit['contract'],
    },
    generation: {
      compiledCode: 'code',
      tokens: { input: 100, output: 50, total: 150 },
      generationTimeMs: 1000,
      turnsUsed: 2,
    },
    evaluation: {
      passed: true,
      finalScore: 80,
      dimensions: {
        completeness: 80,
        visualPolish: 80,
        interactivity: 80,
        accessibility: 80,
        codeQuality: 80,
      },
      issues: [],
    },
    estimatedCostUsd: 0.01,
    timestamp: '2026-05-12T00:00:00Z',
    floor: 'oss',
    pathUsage: {
      predefinedToolAvailable: false,
      predefinedToolCalls: 0,
      capHit: false,
    },
    generator: DEFAULT_GENERATOR_SLUG,
    ...overrides,
  };
}

describe('buildGeneratorComparisonMatrix', () => {
  it('groups results by generator → commit → sdk', () => {
    const results: BenchmarkRunResult[] = [
      mkResult({ generator: DEFAULT_GENERATOR_SLUG }),
      mkResult({
        generator: ADVANCED_GENERATOR_SLUG,
        evaluation: {
          passed: true,
          finalScore: 90,
          dimensions: {
            completeness: 90,
            visualPolish: 90,
            interactivity: 90,
            accessibility: 90,
            codeQuality: 90,
          },
          issues: [],
        },
      }),
    ];
    const matrix = buildGeneratorComparisonMatrix(results);
    expect(matrix[DEFAULT_GENERATOR_SLUG]).toBeDefined();
    expect(matrix[ADVANCED_GENERATOR_SLUG]).toBeDefined();
    expect(matrix[DEFAULT_GENERATOR_SLUG]!['weather-card']!.claude!.avgScore).toBe(80);
    expect(matrix[ADVANCED_GENERATOR_SLUG]!['weather-card']!.claude!.avgScore).toBe(90);
  });

  it('records runs count + successRate per cell', () => {
    const results = [
      mkResult(),
      mkResult({ generation: null, evaluation: null }),
    ];
    const matrix = buildGeneratorComparisonMatrix(results);
    const cell = matrix[DEFAULT_GENERATOR_SLUG]!['weather-card']!.claude!;
    expect(cell.runs).toBe(2);
    expect(cell.successRate).toBe(0.5);
  });

  it('buckets missing generator field under the default slug', () => {
    // Result lacking explicit `generator` (synthetic — the runner
    // always populates it, but older mock data might not).
    const result = mkResult();
    const withoutGenerator = { ...result, generator: '' } as BenchmarkRunResult;
    const matrix = buildGeneratorComparisonMatrix([withoutGenerator]);
    expect(matrix[DEFAULT_GENERATOR_SLUG]).toBeDefined();
  });
});

describe('buildGeneratorSummaries', () => {
  it('returns one summary per distinct generator slug', () => {
    const results = [
      mkResult({ generator: DEFAULT_GENERATOR_SLUG }),
      mkResult({ generator: ADVANCED_GENERATOR_SLUG }),
      mkResult({ generator: DEFAULT_GENERATOR_SLUG }),
    ];
    const summaries = buildGeneratorSummaries(results);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]!.generator).toBe(DEFAULT_GENERATOR_SLUG); // deterministic ordering
    expect(summaries[0]!.runs).toBe(2);
    expect(summaries[1]!.generator).toBe(ADVANCED_GENERATOR_SLUG);
    expect(summaries[1]!.runs).toBe(1);
  });
});

// =============================================================================
// 6. Personalization commits
// =============================================================================

describe('PERSONALIZATION_COMMITS', () => {
  it('exports two distinct commits with the same contract shape', () => {
    expect(PERSONALIZATION_COMMITS).toHaveLength(2);
    const [first, second] = PERSONALIZATION_COMMITS;
    expect(first!.contract).toBe(second!.contract); // shared reference
    expect(first!.id).not.toBe(second!.id);
  });

  it('tags each commit with a distinct persona', () => {
    const personas = PERSONALIZATION_COMMITS.map((c) => c.variance?.persona);
    expect(personas).toContain('minimalist');
    expect(personas).toContain('data-dense');
  });

  it('keeps PERSONALIZATION_COMMITS disjoint from BENCHMARK_COMMITS (separate corpora)', () => {
    // Defends the personalization corpus against being silently folded
    // into the main BENCHMARK_COMMITS list — the bench runner treats
    // them as distinct fixture sets.
    for (const c of PERSONALIZATION_COMMITS) {
      expect(BENCHMARK_COMMITS.some((b) => b.id === c.id)).toBe(false);
    }
  });
});

// =============================================================================
// 7. Integration — 2 commits × 2 generators = 4 cells
// =============================================================================

describe('Multi-generator integration', () => {
  it('runs 2 generators × 2 commits = 4 cells; all produce results', async () => {
    const runner = new BenchmarkRunner();
    runner.registerAdapter(new MockAdapter({}));
    const variants = getGeneratorVariants();
    const commits = PERSONALIZATION_COMMITS;
    const report = await runner.run({ variants, commits });

    expect(report.results).toHaveLength(4);
    // Each variant × each commit produced a row; no row was dropped.
    const seen = new Set<string>();
    for (const r of report.results) {
      seen.add(`${r.variant.id}|${r.commit.id}`);
    }
    expect(seen.size).toBe(4);
  });

  it('report.byGenerator has cells under both generator slugs after a multi-generator run', async () => {
    const runner = new BenchmarkRunner();
    runner.registerAdapter(new MockAdapter({}));
    const variants = getGeneratorVariants();
    const commits = PERSONALIZATION_COMMITS;
    const report = await runner.run({ variants, commits });

    expect(Object.keys(report.byGenerator)).toContain(DEFAULT_GENERATOR_SLUG);
    expect(Object.keys(report.byGenerator)).toContain(ADVANCED_GENERATOR_SLUG);
  });

  it('report.generatorSummaries lists both generators when present', () => {
    const results = [
      mkResult({ generator: DEFAULT_GENERATOR_SLUG }),
      mkResult({ generator: ADVANCED_GENERATOR_SLUG }),
    ];
    const report = generateReport(results, 1000);
    const slugs = report.generatorSummaries.map((s) => s.generator);
    expect(slugs).toContain(DEFAULT_GENERATOR_SLUG);
    expect(slugs).toContain(ADVANCED_GENERATOR_SLUG);
  });

  it('renderReportMarkdown emits the multi-generator section when >1 generator ran', () => {
    const results = [
      mkResult({ generator: DEFAULT_GENERATOR_SLUG }),
      mkResult({ generator: ADVANCED_GENERATOR_SLUG }),
    ];
    const report = generateReport(results, 1000);
    const md = renderReportMarkdown(report);
    expect(md).toContain('## Multi-generator Comparison');
    expect(md).toContain(DEFAULT_GENERATOR_SLUG);
    expect(md).toContain(ADVANCED_GENERATOR_SLUG);
  });

  it('renderReportMarkdown omits the multi-generator section for single-generator reports', () => {
    const report = generateReport([mkResult()], 1000);
    const md = renderReportMarkdown(report);
    expect(md).not.toContain('## Multi-generator Comparison');
  });
});
