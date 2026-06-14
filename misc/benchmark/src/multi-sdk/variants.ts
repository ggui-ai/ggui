// oss/misc/benchmark/src/multi-sdk/variants.ts

import type { BenchmarkVariant } from './types';
import { ADVANCED_GENERATOR_SLUG, DEFAULT_GENERATOR_SLUG } from './types';
import type { AdapterMode, ProviderName } from '@ggui-ai/ui-gen/adapters/types';

/**
 * Default benchmark variants: 9 combinations (3 SDKs x 3 tiers).
 * Uses raw API mode by default for direct comparison.
 */
export function getDefaultVariants(): BenchmarkVariant[] {
  return [
    // --- Claude (Anthropic) ---
    {
      id: 'claude-fast',
      sdkName: 'claude',
      tier: 'fast',
      modelId: 'anthropic/claude-haiku-4-5',
    },
    {
      id: 'claude-balanced',
      sdkName: 'claude',
      tier: 'balanced',
      modelId: 'anthropic/claude-sonnet-4-6',
    },
    {
      id: 'claude-premium',
      sdkName: 'claude',
      tier: 'premium',
      modelId: 'anthropic/claude-opus-4-6',
    },

    // --- OpenAI ---
    {
      id: 'openai-fast',
      sdkName: 'openai',
      tier: 'fast',
      modelId: 'openai/gpt-5.4-nano',
    },
    {
      id: 'openai-balanced',
      sdkName: 'openai',
      tier: 'balanced',
      modelId: 'openai/gpt-5.4-mini',
    },
    {
      id: 'openai-premium',
      sdkName: 'openai',
      tier: 'premium',
      modelId: 'openai/gpt-5.4',
    },

    // --- Google (Gemini) ---
    {
      id: 'google-fast',
      sdkName: 'google',
      tier: 'fast',
      // Canonical google fast floor — priced in MODEL_REGISTRY, cheaper
      // than gemini-3-flash-preview.
      modelId: 'gemini/gemini-3.1-flash-lite',
    },
    {
      id: 'google-balanced',
      sdkName: 'google',
      tier: 'balanced',
      modelId: 'gemini/gemini-3.1-pro-preview',
    },
    {
      id: 'google-premium',
      sdkName: 'google',
      tier: 'premium',
      modelId: 'gemini/gemini-3.1-pro-preview', // No ultra available yet — use pro
    },
  ];
}

/**
 * Speed-focused variants for targeted benchmarking.
 */
export function getSpeedVariants(): BenchmarkVariant[] {
  return [
    {
      id: 'gpt-5.4-nano',
      sdkName: 'openai',
      tier: 'fast',
      modelId: 'openai/gpt-5.4-nano',
    },
    {
      id: 'gpt-5.4-mini',
      sdkName: 'openai',
      tier: 'fast',
      modelId: 'openai/gpt-5.4-mini',
    },
    {
      id: 'gemini-3-flash-preview',
      sdkName: 'google',
      tier: 'fast',
      modelId: 'gemini/gemini-3-flash-preview',
    },
    {
      id: 'gemini-3.1-flash-lite-preview',
      sdkName: 'google',
      tier: 'fast',
      modelId: 'gemini/gemini-3.1-flash-lite-preview',
    },
    {
      id: 'claude-haiku',
      sdkName: 'claude',
      tier: 'fast',
      modelId: 'anthropic/claude-haiku-4-5',
    },
  ];
}

/**
 * Hybrid variants that use fast model for draft + premium for review.
 */
export function getHybridVariants(): BenchmarkVariant[] {
  return [
    {
      id: 'claude-hybrid-haiku-sonnet',
      sdkName: 'claude',
      tier: 'balanced',
      hybrid: {
        draftModel: 'anthropic/claude-haiku-4-5',
        reviewModel: 'anthropic/claude-sonnet-4-6',
      },
    },
    {
      id: 'openai-hybrid-codex-codex',
      sdkName: 'openai',
      tier: 'balanced',
      hybrid: {
        draftModel: 'openai/gpt-5.3-codex',
        reviewModel: 'openai/gpt-5.3-codex',
      },
    },
    {
      id: 'google-hybrid-flash-pro',
      sdkName: 'google',
      tier: 'balanced',
      hybrid: {
        draftModel: 'gemini/gemini-3-flash-preview',
        reviewModel: 'gemini/gemini-3.1-pro-preview',
      },
    },
  ];
}

/**
 * Raw vs SDK comparison variants.
 * Tests each provider with both raw API and agent SDK modes using the balanced tier.
 */
export function getRawVsSdkVariants(): BenchmarkVariant[] {
  const modes: AdapterMode[] = ['raw', 'sdk'];
  const providers: Array<{
    sdkName: ProviderName;
    modelId: string;
  }> = [
    { sdkName: 'claude', modelId: 'anthropic/claude-sonnet-4-6' },
    { sdkName: 'openai', modelId: 'openai/gpt-5.3-codex' },
    { sdkName: 'google', modelId: 'gemini/gemini-3.1-pro-preview' },
    { sdkName: 'openrouter', modelId: 'openrouter/anthropic/claude-sonnet-4-6' },
  ];

  return providers.flatMap(({ sdkName, modelId }) =>
    modes.map((mode) => ({
      id: `${sdkName}-${mode}-balanced`,
      sdkName,
      tier: 'balanced' as const,
      modelId,
      mode,
    }))
  );
}

/**
 * Multi-generator comparison variants. Pairs the two shipped
 * generator slugs on identical commits so a reader can see
 * `default-haiku vs advanced-opus` side-by-side on the same fixture.
 *
 *   - `gen-default-haiku` → {@link DEFAULT_GENERATOR_SLUG} (`ui-gen-default-haiku-4-5`)
 *     on the Claude `fast` tier (haiku). The default seed; no extra deps.
 *   - `gen-advanced-opus` → {@link ADVANCED_GENERATOR_SLUG} (`ui-gen-advanced-opus-4-7`)
 *     on the Claude `balanced` tier (sonnet-default; the advanced loop
 *     re-uses the wrapped generator's identity for prompt routing).
 *     Requires Playwright in the bench env — the runner emits a clear
 *     log line + an error result when Playwright is missing.
 *
 * Use this with the `BENCHMARK_COMMITS` corpus (or a 1-2 commit
 * subset for fast iteration) to drive the comparison matrix in the
 * report. See `BenchmarkReport.byGenerator` for the report shape.
 */
export function getGeneratorVariants(): BenchmarkVariant[] {
  return [
    {
      id: 'gen-default-haiku',
      sdkName: 'claude',
      tier: 'fast',
      modelId: 'anthropic/claude-haiku-4-5',
      generator: DEFAULT_GENERATOR_SLUG,
    },
    {
      id: 'gen-advanced-opus',
      sdkName: 'claude',
      tier: 'balanced',
      modelId: 'anthropic/claude-sonnet-4-6',
      generator: ADVANCED_GENERATOR_SLUG,
    },
  ];
}
