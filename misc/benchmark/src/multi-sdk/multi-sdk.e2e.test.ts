/**
 * Multi-SDK Benchmark E2E Tests
 *
 * Makes REAL API calls to LLM providers. Excluded from normal CI runs.
 * Run manually or via nightly CI (Tier 3).
 *
 * Run all:
 *   pnpm vitest run src/benchmarks/multi-sdk/multi-sdk.e2e.test.ts
 *
 * Run single provider:
 *   pnpm vitest run -- -t "Claude"
 *
 * Run full suite only:
 *   pnpm vitest run -- -t "Full benchmark"
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY     — required for Claude adapters
 *   OPENAI_API_KEY        — required for OpenAI adapters
 *   GEMINI_API_KEY        — required for Google adapters
 *   BENCHMARK_TIMEOUT     — per-prompt timeout in ms (default: 300000 = 5 min)
 *   BENCHMARK_CONCURRENCY — max parallel runs (default: 6)
 */
import { config } from 'dotenv';
import { resolve } from 'path';

// Load env from workspace root (packages/benchmark/src/multi-sdk → ../../../.. = workspace root)
config({ path: resolve(__dirname, '../../../../.env') });
config({ path: resolve(__dirname, '../../../../.env.local') });

import { describe, it, expect, beforeAll } from 'vitest';
import {
  ClaudeRawAdapter,
  ClaudeSdkAdapter,
  OpenAiRawAdapter,
  OpenAiSdkAdapter,
  GoogleRawAdapter,
  GoogleSdkAdapter,
  GeneratorAdapter,
  createGeneratorTools,
} from '@ggui-ai/ui-gen/adapters';
import { BenchmarkRunner, calculateCost } from './runner';
import { getBenchmarkCommit, BENCHMARK_COMMITS } from './commits';
import { buildSystemPrompt } from '@ggui-ai/ui-gen/harness/runtime';
import { renderReportMarkdown } from './reporter';
import { writeFileSync, mkdirSync } from 'fs';
import type { AdapterResult, BenchmarkVariant } from './types';

const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
const hasOpenAiKey = !!process.env.OPENAI_API_KEY;
const hasGeminiKey = !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
const TIMEOUT = parseInt(process.env.BENCHMARK_TIMEOUT ?? '300000', 10);
const ALL_COMMIT_IDS = BENCHMARK_COMMITS.map((p) => p.id);

// =============================================================================
// Claude — Raw vs SDK
// =============================================================================

describe.skipIf(!hasAnthropicKey)('Claude adapter', { timeout: TIMEOUT * 2 }, () => {
  let rawAdapter: ClaudeRawAdapter;
  let sdkAdapter: ClaudeSdkAdapter;

  beforeAll(() => {
    rawAdapter = new ClaudeRawAdapter({ apiKey: process.env.ANTHROPIC_API_KEY });
    sdkAdapter = new ClaudeSdkAdapter({ apiKey: process.env.ANTHROPIC_API_KEY });
  });

  describe('Raw API — Haiku × all prompts', { timeout: TIMEOUT * 2, concurrent: true }, () => {
    for (const commitId of ALL_COMMIT_IDS) {
      it.concurrent(`raw: ${commitId}`, async () => {
        const result = await generateSingle(rawAdapter, 'claude-haiku-4-5', commitId, 'anthropic');
        assertValidGeneration(result);
      });
    }
  });

  describe('Agent SDK — Haiku × all prompts', { timeout: TIMEOUT * 2, concurrent: true }, () => {
    for (const commitId of ALL_COMMIT_IDS) {
      it.concurrent(`sdk: ${commitId}`, async () => {
        const result = await generateSingle(sdkAdapter, 'claude-haiku-4-5', commitId, 'anthropic');
        assertValidGeneration(result);
      });
    }
  });
});

// =============================================================================
// OpenAI — Raw vs SDK
// =============================================================================

describe.skipIf(!hasOpenAiKey)('OpenAI adapter', { timeout: TIMEOUT * 2 }, () => {
  let rawAdapter: OpenAiRawAdapter;
  let sdkAdapter: OpenAiSdkAdapter;

  beforeAll(() => {
    rawAdapter = new OpenAiRawAdapter({ apiKey: process.env.OPENAI_API_KEY });
    sdkAdapter = new OpenAiSdkAdapter({ apiKey: process.env.OPENAI_API_KEY });
  });

  describe('Raw API — GPT-5.4 × all prompts', { timeout: TIMEOUT * 2, concurrent: true }, () => {
    for (const commitId of ALL_COMMIT_IDS) {
      it.concurrent(`raw: ${commitId}`, async () => {
        const result = await generateSingle(rawAdapter, 'gpt-5.4', commitId, 'openai');
        assertValidGeneration(result);
      });
    }
  });

  describe('Agents SDK — GPT-5.3-Codex × all prompts', { timeout: TIMEOUT * 2, concurrent: true }, () => {
    for (const commitId of ALL_COMMIT_IDS) {
      it.concurrent(`sdk: ${commitId}`, async () => {
        const result = await generateSingle(sdkAdapter, 'gpt-5.3-codex', commitId, 'openai');
        assertValidGeneration(result);
      });
    }
  });
});

// =============================================================================
// Google — Raw (ADK not available)
// =============================================================================

describe.skipIf(!hasGeminiKey)('Google adapter', { timeout: TIMEOUT * 2 }, () => {
  let rawAdapter: GoogleRawAdapter;
  let sdkAdapter: GoogleSdkAdapter;

  beforeAll(() => {
    const googleConfig = { apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY };
    rawAdapter = new GoogleRawAdapter(googleConfig);
    sdkAdapter = new GoogleSdkAdapter(googleConfig);
  });

  describe('Raw API — Gemini 3 Flash × all prompts', { timeout: TIMEOUT * 2, concurrent: true }, () => {
    for (const commitId of ALL_COMMIT_IDS) {
      it.concurrent(`raw: ${commitId}`, async () => {
        const result = await generateSingle(rawAdapter, 'gemini-3-flash-preview', commitId, 'gemini');
        assertValidGeneration(result);
      });
    }
  });

  describe('ADK SDK — Gemini 3 Flash × all prompts', { timeout: TIMEOUT * 2, concurrent: true }, () => {
    for (const commitId of ALL_COMMIT_IDS) {
      it.concurrent(`sdk: ${commitId}`, async () => {
        const result = await generateSingle(sdkAdapter, 'gemini-3-flash-preview', commitId, 'gemini');
        assertValidGeneration(result);
      });
    }
  });
});

// =============================================================================
// Full Benchmark Suite — All providers × modes × models × prompts
// =============================================================================

const hasAnyKey = hasAnthropicKey || hasOpenAiKey || hasGeminiKey;

describe.skipIf(!hasAnyKey)('Full benchmark suite', { timeout: TIMEOUT * 10 }, () => {
  it('runs all adapters × modes × models × prompts', async () => {
    const variants: BenchmarkVariant[] = [];
    // Run ALL tasks in parallel — each generation takes ~1 min, so all finish in ~1-2 min
    const concurrency = parseInt(process.env.BENCHMARK_CONCURRENCY ?? '100', 10);

    const runner = new BenchmarkRunner({
      concurrency,
      timeoutMs: TIMEOUT,
      skipEvaluation: true,
      variants, // Will be populated below
    });

    // Claude: raw × haiku (single-pass recipe impl)
    if (hasAnthropicKey) {
      const claudeConfig = { apiKey: process.env.ANTHROPIC_API_KEY };
      variants.push(
        { id: 'claude-raw-haiku-sp', sdkName: 'claude', tier: 'fast', modelId: 'anthropic/claude-haiku-4-5', mode: 'raw' },
        { id: 'claude-raw-sonnet-sp', sdkName: 'claude', tier: 'balanced', modelId: 'anthropic/claude-sonnet-4-6', mode: 'raw' },
      );
      runner.registerAdapter(new ClaudeRawAdapter(claudeConfig), claudeConfig);
    }

    // OpenAI: raw × gpt-5.4 (single-pass recipe impl)
    if (hasOpenAiKey) {
      const openaiConfig = { apiKey: process.env.OPENAI_API_KEY };
      variants.push(
        { id: 'openai-raw-gpt54-sp', sdkName: 'openai', tier: 'premium', modelId: 'openai/gpt-5.4', mode: 'raw' },
        { id: 'openai-sdk-codex-sp', sdkName: 'openai', tier: 'balanced', modelId: 'openai/gpt-5.3-codex', mode: 'sdk' },
      );
      runner.registerAdapter(new OpenAiRawAdapter(openaiConfig), openaiConfig);
      runner.registerAdapter(new OpenAiSdkAdapter(openaiConfig), openaiConfig);
    }

    // Google: raw × flash (single-pass recipe impl)
    if (hasGeminiKey) {
      const googleConfig = { apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY };
      variants.push(
        { id: 'google-raw-flash-sp', sdkName: 'google', tier: 'fast', modelId: 'gemini/gemini-3-flash-preview', mode: 'raw' },
        { id: 'google-raw-flash-lite-sp', sdkName: 'google', tier: 'fast', modelId: 'gemini/gemini-3.1-flash-lite-preview', mode: 'raw' },
      );
      runner.registerAdapter(new GoogleRawAdapter(googleConfig), googleConfig);
    }

    const report = await runner.run();

    // Verify
    const expectedRuns = variants.length * BENCHMARK_COMMITS.length;
    expect(report.meta.totalRuns).toBe(expectedRuns);
    expect(report.meta.successCount).toBeGreaterThanOrEqual(1);

    // Save report
    const reportsDir = resolve(__dirname, 'reports');
    mkdirSync(reportsDir, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    writeFileSync(resolve(reportsDir, `benchmark-${ts}.json`), JSON.stringify(report, null, 2));
    writeFileSync(resolve(reportsDir, `benchmark-${ts}.md`), renderReportMarkdown(report));

    console.log(`\nReport: ${resolve(reportsDir, `benchmark-${ts}.md`)}`);
    console.log('\n' + renderReportMarkdown(report));
  });
});

// =============================================================================
// Weather Card × All Variants (quick full-matrix test)
// =============================================================================

describe.skipIf(!hasAnyKey)('Weather card × all variants', { timeout: TIMEOUT * 3 }, () => {
  it('tests all provider × mode × recipe combos on weather-card', async () => {
    const variants: BenchmarkVariant[] = [];
    const concurrency = 100;
    const weatherOnly = [getBenchmarkCommit('weather-card')!];

    const runner = new BenchmarkRunner({
      concurrency,
      timeoutMs: TIMEOUT,
      skipEvaluation: true,
      variants,
      commits: weatherOnly,
    });

    // Claude: raw × single-pass, raw × iterative, sdk × single-pass
    if (hasAnthropicKey) {
      const cfg = { apiKey: process.env.ANTHROPIC_API_KEY };
      variants.push(
        { id: 'claude-raw-haiku-sp', sdkName: 'claude', tier: 'fast', modelId: 'anthropic/claude-haiku-4-5', mode: 'raw' },
        { id: 'claude-raw-haiku-iter', sdkName: 'claude', tier: 'fast', modelId: 'anthropic/claude-haiku-4-5', mode: 'raw' },
        { id: 'claude-sdk-haiku-sp', sdkName: 'claude', tier: 'fast', modelId: 'anthropic/claude-haiku-4-5', mode: 'sdk' },
      );

      // Viewport × Shell variants (Claude Haiku only — cheapest reliable provider)
      const devices = ['mobile', 'tablet', 'desktop'] as const;
      const shells = ['chat', 'fullscreen'] as const;
      const viewports: Record<string, { width: number; height: number }> = {
        mobile: { width: 390, height: 844 },
        tablet: { width: 768, height: 1024 },
        desktop: { width: 1440, height: 900 },
      };

      for (const device of devices) {
        for (const shell of shells) {
          variants.push({
            id: `claude-haiku-${device}-${shell}`,
            sdkName: 'claude',
            tier: 'fast',
            modelId: 'anthropic/claude-haiku-4-5',
            mode: 'raw',
            rendering: { device, shell, viewport: viewports[device] },
          });
        }
      }

      runner.registerAdapter(new ClaudeRawAdapter(cfg), cfg);
      runner.registerAdapter(new ClaudeSdkAdapter(cfg), cfg);
    }

    // OpenAI: raw × sp, sdk × sp, sdk × iterative
    if (hasOpenAiKey) {
      const cfg = { apiKey: process.env.OPENAI_API_KEY };
      variants.push(
        { id: 'openai-raw-gpt54-sp', sdkName: 'openai', tier: 'premium', modelId: 'openai/gpt-5.4', mode: 'raw' },
        { id: 'openai-sdk-codex-sp', sdkName: 'openai', tier: 'balanced', modelId: 'openai/gpt-5.3-codex', mode: 'sdk' },
        { id: 'openai-sdk-codex-iter', sdkName: 'openai', tier: 'balanced', modelId: 'openai/gpt-5.3-codex', mode: 'sdk' },
      );
      runner.registerAdapter(new OpenAiRawAdapter(cfg), cfg);
      runner.registerAdapter(new OpenAiSdkAdapter(cfg), cfg);
    }

    // Google: raw × sp, raw × iterative, sdk × sp
    if (hasGeminiKey) {
      const cfg = { apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY };
      variants.push(
        { id: 'google-raw-flash-sp', sdkName: 'google', tier: 'fast', modelId: 'gemini/gemini-3-flash-preview', mode: 'raw' },
        { id: 'google-raw-flash-iter', sdkName: 'google', tier: 'fast', modelId: 'gemini/gemini-3-flash-preview', mode: 'raw' },
        { id: 'google-sdk-flash-sp', sdkName: 'google', tier: 'fast', modelId: 'gemini/gemini-3-flash-preview', mode: 'sdk' },
      );
      runner.registerAdapter(new GoogleRawAdapter(cfg), cfg);
      runner.registerAdapter(new GoogleSdkAdapter(cfg), cfg);
    }

    const report = await runner.run();

    expect(report.meta.totalRuns).toBe(variants.length);
    expect(report.meta.successCount).toBeGreaterThanOrEqual(1);

    // Save report
    const reportsDir = resolve(__dirname, 'reports');
    mkdirSync(reportsDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    writeFileSync(resolve(reportsDir, `weather-matrix-${ts}.json`), JSON.stringify(report, null, 2));
    writeFileSync(resolve(reportsDir, `weather-matrix-${ts}.md`), renderReportMarkdown(report));
    console.log('\n' + renderReportMarkdown(report));
  });
});

// =============================================================================
// Helpers
// =============================================================================

async function generateSingle(
  adapter: GeneratorAdapter,
  model: string,
  commitId: string,
  providerPrefix?: string,
): Promise<AdapterResult> {
  const commit = getBenchmarkCommit(commitId);
  if (!commit) throw new Error(`Unknown commit: ${commitId}`);

  const tools = createGeneratorTools({ enablePredefinedComponents: false });
  const systemPrompt = buildSystemPrompt(commit.prompt);

  console.log(`\n[benchmark] ${adapter.displayName} | ${model} × ${commitId} — starting...`);

  const result = await adapter.generate({
    systemPrompt,
    userPrompt: commit.prompt,
    model,
    tools,
    maxTurns: 45,
  });

  const prefix = providerPrefix ?? 'anthropic';
  const litellmId = model.includes('/') ? model : `${prefix}/${model}`;
  const cost = calculateCost(litellmId, result.tokens);

  console.log(
    `[benchmark] ${adapter.displayName} | ${model} × ${commitId} — ` +
      `${result.generationTimeMs}ms, ${result.turnsUsed} turns, ` +
      `${result.tokens.total} tokens, $${cost.toFixed(4)}`,
  );

  return result;
}

function assertValidGeneration(result: AdapterResult): void {
  expect(result.compiledCode).toBeTruthy();
  expect(result.compiledCode.length).toBeGreaterThan(50);
  expect(result.compiledCode).toContain('export');
  expect(result.sourceCode).toBeTruthy();
  expect(result.tokens.input).toBeGreaterThan(0);
  expect(result.tokens.output).toBeGreaterThan(0);
  expect(result.generationTimeMs).toBeGreaterThan(0);
  expect(result.generationTimeMs).toBeLessThan(300_000);
  expect(result.turnsUsed).toBeGreaterThanOrEqual(2);

  console.log(
    `  ${result.sourceCode?.length ?? 0}B src | ${result.compiledCode.length}B compiled` +
      ` | stream: ${result.stream ? 'yes' : 'no'}` +
      ` | meta: ${result.generatorMeta ? result.generatorMeta.category : 'none'}`,
  );
}
