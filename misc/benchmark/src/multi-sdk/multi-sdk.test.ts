// oss/misc/benchmark/src/multi-sdk/multi-sdk.test.ts
//
// Unit tests for the multi-SDK benchmark infrastructure.
// No API calls — tests tool definitions, cost calculation, reporting, etc.

import { describe, it, expect } from 'vitest';
import { MODEL_REGISTRY } from '@ggui-ai/protocol';
import {
  createGeneratorTools,
  zodToJsonSchema,
  getAdapter,
  listAdapters,
  ClaudeRawAdapter,
  ClaudeSdkAdapter,
  OpenAiRawAdapter,
  OpenAiSdkAdapter,
  GoogleRawAdapter,
  GoogleSdkAdapter,
} from '@ggui-ai/ui-gen/adapters';
import { BENCHMARK_COMMITS, getBenchmarkCommit } from './commits';
import { generateReport, renderReportMarkdown } from './reporter';
import { calculateCost, resolveCostModelId } from './runner';
import { getDefaultVariants, getSpeedVariants, getHybridVariants, getRawVsSdkVariants } from './variants';
import type { BenchmarkRunResult, PostEvalResult } from './types';
import { AESTHETIC_JUDGE_MODEL, AESTHETIC_PROMPT_VERSION } from './post-eval';

/** Build a PostEvalResult-shaped fixture matching the runner's real output. */
function mkEval(
  score: number,
  dimensions: PostEvalResult['dimensions'],
): PostEvalResult {
  return {
    passed: score >= 70,
    score,
    dimensions,
    judge: { model: AESTHETIC_JUDGE_MODEL, promptVersion: AESTHETIC_PROMPT_VERSION },
    issues: [],
    critique: 'fixture critique',
    evalTimeMs: 1200,
  };
}

// =============================================================================
// Tool Definitions
// =============================================================================

describe('Benchmark Tool Definitions', () => {
  it('creates 6 generator tools with correct names', () => {
    const tools = createGeneratorTools();
    expect(tools).toHaveLength(6);
    expect(tools.map((t) => t.name)).toEqual([
      'get_primitives',
      'get_design_system',
      'get_app_components',
      'validate_component',
      'self_check',
      'compile_component',
    ]);
  });

  it('get_primitives returns documentation string', async () => {
    const tools = createGeneratorTools();
    const primitivesTool = tools.find((t) => t.name === 'get_primitives')!;
    const result = await primitivesTool.handler({});
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain('ggui Primitives');
    expect(result.isError).toBeUndefined();
  });

  it('get_design_system returns CSS variables', async () => {
    const tools = createGeneratorTools();
    const designTool = tools.find((t) => t.name === 'get_design_system')!;
    const result = await designTool.handler({});
    expect(result.content[0].text).toContain('--ggui-');
    expect(result.isError).toBeUndefined();
  });

  it('validate_component catches security violations', async () => {
    const tools = createGeneratorTools();
    const validateTool = tools.find((t) => t.name === 'validate_component')!;
    const result = await validateTool.handler({
      code: `import React from 'react';\nexport default function Evil() { eval('alert(1)'); return <div/>; }`,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('eval');
  });

  it('compile_component compiles valid TSX', async () => {
    const tools = createGeneratorTools();
    const compileTool = tools.find((t) => t.name === 'compile_component')!;
    const result = await compileTool.handler({
      code: `import React from 'react';\ninterface Props { greeting?: string; }\nexport default function Hello({ greeting = "Hello" }: Props) { return <div>{greeting}</div>; }`,
      filename: 'Hello.tsx',
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.compiledCode).toBeTruthy();
    expect(parsed.compiledCode.length).toBeGreaterThan(10);
  });

  it('compile_component returns error for invalid code', async () => {
    const tools = createGeneratorTools();
    const compileTool = tools.find((t) => t.name === 'compile_component')!;
    const result = await compileTool.handler({
      code: `export default function Broken() { return <div`,
      filename: 'Broken.tsx',
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
  });
});

// =============================================================================
// Tool Bridge (Zod → JSON Schema)
// =============================================================================

describe('Tool Bridge', () => {
  it('converts tool input schemas to JSON Schema', () => {
    const tools = createGeneratorTools();
    const compileTool = tools.find((t) => t.name === 'compile_component')!;
    const jsonSchema = zodToJsonSchema(compileTool.inputSchema);

    expect(jsonSchema.type).toBe('object');
    expect(jsonSchema.properties).toBeDefined();
    const props = jsonSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.code).toEqual({ type: 'string', description: expect.any(String) });
    expect(props.filename).toBeDefined();
    expect(jsonSchema.required).toContain('code');
  });

  it('handles empty schemas (get_primitives)', () => {
    const tools = createGeneratorTools();
    const primitivesTool = tools.find((t) => t.name === 'get_primitives')!;
    const jsonSchema = zodToJsonSchema(primitivesTool.inputSchema);
    expect(jsonSchema.type).toBe('object');
    expect(jsonSchema.properties).toEqual({});
  });
});

// =============================================================================
// Benchmark Commits
// =============================================================================

describe('Benchmark Commits', () => {
  it('has 10 benchmark commits (8 core + 2 component-gadget probes)', () => {
    expect(BENCHMARK_COMMITS).toHaveLength(10);
  });

  it('covers all complexity levels', () => {
    const complexities = BENCHMARK_COMMITS.map((p) => p.complexity);
    expect(complexities).toContain('simple');
    expect(complexities).toContain('medium');
    expect(complexities).toContain('complex');
  });

  it('has unique IDs', () => {
    const ids = BENCHMARK_COMMITS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('each commit has required fields and meaningful length', () => {
    for (const commit of BENCHMARK_COMMITS) {
      expect(commit.id).toBeTruthy();
      expect(commit.name).toBeTruthy();
      expect(commit.prompt).toBeTruthy();
      expect(commit.prompt.length).toBeGreaterThan(100);
      expect(commit.props).toBeDefined();
    }
  });

  it('includes all expected commit IDs', () => {
    const ids = BENCHMARK_COMMITS.map((p) => p.id);
    expect(ids).toContain('weather-card');
    expect(ids).toContain('survey-form');
    expect(ids).toContain('kanban-board');
    expect(ids).toContain('periodic-table');
    expect(ids).toContain('product-page');
    expect(ids).toContain('chat-interface');
    expect(ids).toContain('leaflet-map');
    expect(ids).toContain('revenue-chart');
  });

  it('getBenchmarkCommit finds by ID', () => {
    expect(getBenchmarkCommit('weather-card')).toBeDefined();
    expect(getBenchmarkCommit('chat-interface')).toBeDefined();
    expect(getBenchmarkCommit('nonexistent')).toBeUndefined();
  });
});

// =============================================================================
// Cost Calculator
// =============================================================================

describe('Cost Calculator', () => {
  it('calculates cost for Claude Haiku', () => {
    const cost = calculateCost('anthropic/claude-haiku-4-5', {
      input: 10000,
      output: 5000,
    });
    // input: 10K tokens × $1/1M = $0.01
    // output: 5K tokens × $5/1M = $0.025
    expect(cost).toBeCloseTo(0.035, 4);
  });

  it('calculates cost for GPT-5.3 Codex', () => {
    const cost = calculateCost('openai/gpt-5.3-codex', {
      input: 10000,
      output: 5000,
    });
    // input: 10K × $1.75/1M = $0.0175
    // output: 5K × $14.0/1M = $0.07
    expect(cost).toBeCloseTo(0.0875, 4);
  });

  it('calculates cost for Gemini 3 Flash Preview', () => {
    const cost = calculateCost('gemini/gemini-3-flash-preview', {
      input: 10000,
      output: 5000,
    });
    // input: 10K × $0.50/1M = $0.005
    // output: 5K × $3.0/1M = $0.015
    expect(cost).toBeCloseTo(0.02, 4);
  });

  it('calculates cost for Gemini 3.1 Flash Lite Preview (cheapest)', () => {
    const cost = calculateCost('gemini/gemini-3.1-flash-lite', {
      input: 10000,
      output: 5000,
    });
    // input: 10K × $0.25/1M = $0.0025
    // output: 5K × $1.5/1M = $0.0075
    expect(cost).toBeCloseTo(0.01, 4);
  });

  it('returns 0 for unknown models', () => {
    expect(calculateCost('unknown/model', { input: 1000, output: 500 })).toBe(0);
  });
});

// =============================================================================
// Cost attribution — coding-role override (Exp 45 mis-pricing regression)
// =============================================================================

describe('resolveCostModelId', () => {
  it('returns the base model when no roles are set', () => {
    expect(resolveCostModelId(undefined, 'gemini/gemini-3.1-flash-lite')).toBe(
      'gemini/gemini-3.1-flash-lite',
    );
    expect(resolveCostModelId({}, 'anthropic/claude-haiku-4-5')).toBe(
      'anthropic/claude-haiku-4-5',
    );
  });

  it('coding override wins over the variant base model (bare CLI form normalized to the registry key)', () => {
    // `pnpm bench --model gemini-3.5-flash` stores the BARE id on
    // modelRoles.coding; MODEL_REGISTRY is LiteLLM-keyed.
    expect(
      resolveCostModelId({ coding: 'gemini-3.5-flash' }, 'gemini/gemini-3.1-flash-lite'),
    ).toBe('gemini/gemini-3.5-flash');
  });

  it('LiteLLM-prefixed coding override passes through unchanged', () => {
    expect(
      resolveCostModelId(
        { coding: 'anthropic/claude-sonnet-4-6' },
        'anthropic/claude-haiku-4-5',
      ),
    ).toBe('anthropic/claude-sonnet-4-6');
  });

  it('falls back to the default role when coding is absent', () => {
    expect(
      resolveCostModelId({ default: 'gemini-3.5-flash' }, 'gemini/gemini-3.1-flash-lite'),
    ).toBe('gemini/gemini-3.5-flash');
  });

  it('passes unknown ids through so calculateCost flags them loudly', () => {
    expect(
      resolveCostModelId({ coding: 'totally-unknown-model' }, 'gemini/gemini-3.1-flash-lite'),
    ).toBe('totally-unknown-model');
  });

  it('Exp-45 regression: an overridden run is priced at the OVERRIDE rate, not the base rate', () => {
    const tokens = { input: 100_000, output: 200_000 };
    const overridden = calculateCost(
      resolveCostModelId({ coding: 'gemini-3.5-flash' }, 'gemini/gemini-3.1-flash-lite'),
      tokens,
    );
    // flash: 0.1M × $1.5 + 0.2M × $9.0 = $1.95
    expect(overridden).toBeCloseTo(
      calculateCost('gemini/gemini-3.5-flash', tokens),
      10,
    );
    // The base (flash-lite) rate would be $0.325 — the Exp 45 bug shape.
    expect(overridden).toBeGreaterThan(
      calculateCost('gemini/gemini-3.1-flash-lite', tokens) * 5,
    );
  });
});

// =============================================================================
// MODEL_REGISTRY Additions
// =============================================================================

describe('MODEL_REGISTRY', () => {
  it('includes Google and OpenAI models', () => {
    expect(MODEL_REGISTRY['gemini/gemini-3-flash-preview']).toBeDefined();
    expect(MODEL_REGISTRY['gemini/gemini-3.1-flash-lite']).toBeDefined();
    expect(MODEL_REGISTRY['gemini/gemini-3.1-pro-preview']).toBeDefined();
    expect(MODEL_REGISTRY['openai/gpt-5.3-codex']).toBeDefined();
    expect(MODEL_REGISTRY['openai/gpt-5.4']).toBeDefined();
    expect(MODEL_REGISTRY['openai/gpt-5.4-mini']).toBeDefined();
    expect(MODEL_REGISTRY['openai/gpt-5.4-nano']).toBeDefined();
  });

  it('models have correct tiers', () => {
    expect(MODEL_REGISTRY['gemini/gemini-3-flash-preview'].tier).toBe('fast');
    expect(MODEL_REGISTRY['gemini/gemini-3.1-flash-lite'].tier).toBe('fast');
    expect(MODEL_REGISTRY['gemini/gemini-3.1-pro-preview'].tier).toBe('balanced');
    expect(MODEL_REGISTRY['openai/gpt-5.3-codex'].tier).toBe('balanced');
    expect(MODEL_REGISTRY['openai/gpt-5.4'].tier).toBe('premium');
    expect(MODEL_REGISTRY['openai/gpt-5.4-mini'].tier).toBe('fast');
    expect(MODEL_REGISTRY['openai/gpt-5.4-nano'].tier).toBe('fast');
  });

  it('models have correct provider', () => {
    expect(MODEL_REGISTRY['gemini/gemini-3-flash-preview'].provider).toBe('google');
    expect(MODEL_REGISTRY['openai/gpt-5.3-codex'].provider).toBe('openai');
  });

  it('all models support tools', () => {
    for (const config of Object.values(MODEL_REGISTRY)) {
      expect(config.supportsTools).toBe(true);
    }
  });
});

// =============================================================================
// Variants
// =============================================================================

describe('Benchmark Variants', () => {
  it('default variants cover all 9 SDK × tier combos', () => {
    const variants = getDefaultVariants();
    expect(variants).toHaveLength(9);

    const combos = variants.map((v) => `${v.sdkName}-${v.tier}`);
    for (const sdk of ['claude', 'openai', 'google'] as const) {
      for (const tier of ['fast', 'balanced', 'premium'] as const) {
        expect(combos).toContain(`${sdk}-${tier}`);
      }
    }
  });

  it('speed variants focus on fast models', () => {
    const variants = getSpeedVariants();
    expect(variants.length).toBeGreaterThan(0);
    // All should be fast or balanced tier
    for (const v of variants) {
      expect(['fast', 'balanced']).toContain(v.tier);
    }
  });

  it('hybrid variants have draft and review models', () => {
    const variants = getHybridVariants();
    for (const v of variants) {
      expect(v.hybrid).toBeDefined();
      expect(v.hybrid!.draftModel).toBeTruthy();
      expect(v.hybrid!.reviewModel).toBeTruthy();
    }
  });
});

// =============================================================================
// Adapters (unit-level: no API calls)
// =============================================================================

describe('SDK Adapters', () => {
  describe('ClaudeRawAdapter', () => {
    it('resolves model IDs by stripping anthropic/ prefix', () => {
      const adapter = new ClaudeRawAdapter({});
      expect(adapter.resolveModelId('anthropic/claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
      expect(adapter.resolveModelId('claude-haiku-4-5')).toBe('claude-haiku-4-5');
    });

    it('reports unavailable without key', () => {
      const origKey = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      const adapter = new ClaudeRawAdapter({});
      expect(adapter.isAvailable()).toBe(false);
      if (origKey) process.env.ANTHROPIC_API_KEY = origKey;
    });

    it('reports available with config key', () => {
      const adapter = new ClaudeRawAdapter({ apiKey: 'test-key' });
      expect(adapter.isAvailable()).toBe(true);
    });
  });

  describe('OpenAiSdkAdapter', () => {
    it('resolves model IDs by stripping openai/ prefix', () => {
      const adapter = new OpenAiSdkAdapter({});
      expect(adapter.resolveModelId('openai/gpt-5.3-codex-spark')).toBe('gpt-5.3-codex-spark');
      expect(adapter.resolveModelId('gpt-5.2')).toBe('gpt-5.2');
    });

    it('reports unavailable without key', () => {
      const origKey = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      const adapter = new OpenAiSdkAdapter({});
      expect(adapter.isAvailable()).toBe(false);
      if (origKey) process.env.OPENAI_API_KEY = origKey;
    });

    it('reports available with config key', () => {
      const adapter = new OpenAiSdkAdapter({ apiKey: 'test-key' });
      expect(adapter.isAvailable()).toBe(true);
    });
  });

  describe('GoogleRawAdapter', () => {
    it('resolves model IDs by stripping gemini/ prefix', () => {
      const adapter = new GoogleRawAdapter({});
      expect(adapter.resolveModelId('gemini/gemini-3-flash-preview')).toBe('gemini-3-flash-preview');
      expect(adapter.resolveModelId('gemini-3.1-pro-preview')).toBe('gemini-3.1-pro-preview');
    });

    it('reports unavailable without key', () => {
      const origKey = process.env.GEMINI_API_KEY;
      const origGoogle = process.env.GOOGLE_API_KEY;
      delete process.env.GEMINI_API_KEY;
      delete process.env.GOOGLE_API_KEY;
      const adapter = new GoogleRawAdapter({});
      expect(adapter.isAvailable()).toBe(false);
      if (origKey) process.env.GEMINI_API_KEY = origKey;
      if (origGoogle) process.env.GOOGLE_API_KEY = origGoogle;
    });

    it('reports available with config key', () => {
      const adapter = new GoogleRawAdapter({ apiKey: 'test-key' });
      expect(adapter.isAvailable()).toBe(true);
    });
  });
});

// =============================================================================
// Report Generator
// =============================================================================

describe('Report Generator', () => {
  const mockResults: BenchmarkRunResult[] = [
    {
      variant: { id: 'claude-fast', sdkName: 'claude', tier: 'fast', modelId: 'anthropic/claude-haiku-4-5' },
      commit: { id: 'weather-card', name: 'Weather Card', description: '', prompt: '', complexity: 'simple', contract: {} },
      generation: {
        compiledCode: 'code1',
        tokens: { input: 5000, output: 2000, total: 7000 },
        generationTimeMs: 15000,
        turnsUsed: 8,
      },
      evaluation: mkEval(82, { layout: 85, designTokens: 80, hierarchy: 75, polish: 90, dataPresentation: 80 }),
      estimatedCostUsd: 0.015,
      timestamp: '2026-03-15T00:00:00Z',
      generator: 'ui-gen-default-haiku-4-5',
    },
    {
      variant: { id: 'openai-fast', sdkName: 'openai', tier: 'fast', modelId: 'openai/gpt-5.1-codex-mini' },
      commit: { id: 'weather-card', name: 'Weather Card', description: '', prompt: '', complexity: 'simple', contract: {} },
      generation: {
        compiledCode: 'code2',
        tokens: { input: 6000, output: 3000, total: 9000 },
        generationTimeMs: 12000,
        turnsUsed: 6,
      },
      evaluation: mkEval(78, { layout: 80, designTokens: 75, hierarchy: 70, polish: 85, dataPresentation: 80 }),
      estimatedCostUsd: 0.027,
      timestamp: '2026-03-15T00:00:00Z',
      generator: 'ui-gen-default-haiku-4-5',
    },
    {
      variant: { id: 'google-fast', sdkName: 'google', tier: 'fast', modelId: 'gemini/gemini-3-flash-preview' },
      commit: { id: 'weather-card', name: 'Weather Card', description: '', prompt: '', complexity: 'simple', contract: {} },
      generation: null,
      evaluation: null,
      estimatedCostUsd: 0,
      error: 'Timeout after 300000ms',
      timestamp: '2026-03-15T00:00:00Z',
      generator: 'ui-gen-default-haiku-4-5',
    },
  ];

  it('generates report with correct meta', () => {
    const report = generateReport(mockResults, 30000);
    expect(report.meta.totalRuns).toBe(3);
    expect(report.meta.successCount).toBe(2);
    expect(report.meta.failureCount).toBe(1);
    expect(report.meta.successRate).toBeCloseTo(2 / 3, 2);
    expect(report.meta.totalDurationMs).toBe(30000);
  });

  it('ranks variants by average score', () => {
    const report = generateReport(mockResults, 30000);
    expect(report.variantSummaries.length).toBe(3);
    // claude-fast (82) should rank above openai-fast (78)
    expect(report.variantSummaries[0].variantId).toBe('claude-fast');
    expect(report.variantSummaries[0].avgScore).toBe(82);
  });

  it('identifies best and worst variants per commit', () => {
    const report = generateReport(mockResults, 30000);
    const weatherSummary = report.commitSummaries.find((c: { commitId: string }) => c.commitId === 'weather-card');
    expect(weatherSummary).toBeDefined();
    expect(weatherSummary!.bestVariantId).toBe('claude-fast');
    expect(weatherSummary!.worstVariantId).toBe('openai-fast');
  });

  it('builds SDK comparison matrix', () => {
    const report = generateReport(mockResults, 30000);
    expect(report.sdkComparison['claude']).toBeDefined();
    expect(report.sdkComparison['claude']['fast']).toBeDefined();
    expect(report.sdkComparison['claude']['fast'].avgScore).toBe(82);
    expect(report.sdkComparison['google']['fast'].successRate).toBe(0);
    // Score is -1 when no evaluation data (not evaluated)
    expect(report.sdkComparison['google']['fast'].avgScore).toBe(-1);
  });

  it('renders markdown report', () => {
    const report = generateReport(mockResults, 30000);
    const markdown = renderReportMarkdown(report);
    expect(markdown).toContain('# Multi-SDK Benchmark Report');
    expect(markdown).toContain('claude-fast');
    expect(markdown).toContain('Timeout');
    expect(markdown).toContain('| Rank |');
  });
});

// =============================================================================
// Adapter Registry
// =============================================================================

describe('Adapter Registry', () => {
  it('getAdapter returns correct adapter for each provider/mode combo', async () => {
    const claudeRaw = await getAdapter('claude', 'raw', { apiKey: 'test' });
    expect(claudeRaw).toBeInstanceOf(ClaudeRawAdapter);
    expect(claudeRaw.provider).toBe('claude');
    expect(claudeRaw.mode).toBe('raw');

    const claudeSdk = await getAdapter('claude', 'sdk', { apiKey: 'test' });
    expect(claudeSdk).toBeInstanceOf(ClaudeSdkAdapter);
    expect(claudeSdk.provider).toBe('claude');
    expect(claudeSdk.mode).toBe('sdk');

    const openaiRaw = await getAdapter('openai', 'raw', { apiKey: 'test' });
    expect(openaiRaw).toBeInstanceOf(OpenAiRawAdapter);

    const openaiSdk = await getAdapter('openai', 'sdk', { apiKey: 'test' });
    expect(openaiSdk).toBeInstanceOf(OpenAiSdkAdapter);

    const googleRaw = await getAdapter('google', 'raw', { apiKey: 'test' });
    expect(googleRaw).toBeInstanceOf(GoogleRawAdapter);

    const googleSdk = await getAdapter('google', 'sdk', { apiKey: 'test' });
    expect(googleSdk).toBeInstanceOf(GoogleSdkAdapter);
  });

  it('getAdapter throws for unknown provider', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(getAdapter('unknown' as any, 'raw')).rejects.toThrow('Unknown provider');
  });

  it('listAdapters returns all 7 combinations', async () => {
    const adapters = await listAdapters();
    expect(adapters).toHaveLength(7);

    const keys = adapters.map((a) => `${a.provider}-${a.mode}`);
    expect(keys).toContain('claude-raw');
    expect(keys).toContain('claude-sdk');
    expect(keys).toContain('openai-raw');
    expect(keys).toContain('openai-sdk');
    expect(keys).toContain('google-raw');
    expect(keys).toContain('google-sdk');
    expect(keys).toContain('openrouter-raw');
  });

  it('listAdapters reports availability based on API keys', async () => {
    const adapters = await listAdapters({ apiKey: 'test-key' });
    // With a generic apiKey, Claude adapters should be available
    const claudeRaw = adapters.find((a) => a.provider === 'claude' && a.mode === 'raw');
    expect(claudeRaw?.available).toBe(true);
  });
});

// =============================================================================
// Raw vs SDK Variants
// =============================================================================

describe('Raw vs SDK Variants', () => {
  it('generates 8 variants (4 providers x 2 modes)', () => {
    const variants = getRawVsSdkVariants();
    expect(variants).toHaveLength(8);

    const ids = variants.map((v) => v.id);
    expect(ids).toContain('claude-raw-balanced');
    expect(ids).toContain('claude-sdk-balanced');
    expect(ids).toContain('openai-raw-balanced');
    expect(ids).toContain('openai-sdk-balanced');
    expect(ids).toContain('google-raw-balanced');
    expect(ids).toContain('google-sdk-balanced');
    expect(ids).toContain('openrouter-raw-balanced');
    expect(ids).toContain('openrouter-sdk-balanced');
  });

  it('each variant has the correct mode set', () => {
    const variants = getRawVsSdkVariants();
    for (const v of variants) {
      expect(v.mode).toBeDefined();
      expect(['raw', 'sdk']).toContain(v.mode);
    }
  });
});

