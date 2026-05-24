// core/src/benchmarks/multi-sdk/variants.ts

import type { BenchmarkFloor, BenchmarkVariant } from './types';
import { ADVANCED_GENERATOR_SLUG, DEFAULT_GENERATOR_SLUG } from './types';
import type { AdapterMode, ProviderName } from '@ggui-ai/ui-gen/adapters/types';

/**
 * Return a copy of the given variants tagged with a floor. When the
 * floor is omitted, variants pass through unchanged — which preserves
 * the pre-floor default (OSS semantics, no id suffix). When a floor is
 * provided, each variant's `floor` field is set and its `id` is suffixed
 * with the floor so multi-floor runs produce unambiguously-named rows.
 *
 * Idempotent on the id: if a variant's id already ends with the floor
 * suffix (e.g., re-applying the same floor), the suffix is not doubled.
 *
 * This is the single choke-point for "add a floor dimension." Variants
 * built by {@link getDefaultVariants} etc. stay floor-unaware; the
 * bench entry script calls `applyFloor` once per configured floor and
 * concatenates. Keeping the decision in one place is what lets us
 * later extract to `@ggui-ai/benchmarks` without chasing scattered
 * `variant.id + '-' + floor` string-concats.
 */
export function applyFloor(
  variants: readonly BenchmarkVariant[],
  floor: BenchmarkFloor | undefined,
): BenchmarkVariant[] {
  if (floor === undefined) {
    return variants.map((v) => ({ ...v }));
  }
  const suffix = `-${floor}`;
  return variants.map((v) => ({
    ...v,
    floor,
    id: v.id.endsWith(suffix) ? v.id : v.id + suffix,
  }));
}

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
      modelId: 'google/gemini-3-flash-preview',
    },
    {
      id: 'google-balanced',
      sdkName: 'google',
      tier: 'balanced',
      modelId: 'google/gemini-3.1-pro-preview',
    },
    {
      id: 'google-premium',
      sdkName: 'google',
      tier: 'premium',
      modelId: 'google/gemini-3.1-pro-preview', // No ultra available yet — use pro
    },

    // --- OpenRouter ---
    {
      id: 'openrouter-fast',
      sdkName: 'openrouter',
      tier: 'fast',
      modelId: 'openrouter/anthropic/claude-haiku-4-5',
    },
    {
      id: 'openrouter-balanced',
      sdkName: 'openrouter',
      tier: 'balanced',
      modelId: 'openrouter/anthropic/claude-sonnet-4-6',
    },
    {
      id: 'openrouter-premium',
      sdkName: 'openrouter',
      tier: 'premium',
      modelId: 'openrouter/anthropic/claude-opus-4-6',
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
      modelId: 'google/gemini-3-flash-preview',
    },
    {
      id: 'gemini-3.1-flash-lite-preview',
      sdkName: 'google',
      tier: 'fast',
      modelId: 'google/gemini-3.1-flash-lite-preview',
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
        draftModel: 'google/gemini-3-flash-preview',
        reviewModel: 'google/gemini-3.1-pro-preview',
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
    { sdkName: 'google', modelId: 'google/gemini-3.1-pro-preview' },
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
 * OpenRouter-exclusive models not available via direct provider APIs.
 */
export function getOpenRouterExclusiveVariants(): BenchmarkVariant[] {
  return [
    { id: 'or-deepseek-v3', sdkName: 'openrouter', tier: 'balanced', modelId: 'openrouter/deepseek/deepseek-chat-v3' },
    { id: 'or-llama-4-maverick', sdkName: 'openrouter', tier: 'balanced', modelId: 'openrouter/meta-llama/llama-4-maverick' },
    { id: 'or-mistral-large', sdkName: 'openrouter', tier: 'premium', modelId: 'openrouter/mistralai/mistral-large' },
  ];
}

/**
 * Direct API vs OpenRouter comparison — same model, different route.
 */
export function getDirectVsOpenRouterVariants(): BenchmarkVariant[] {
  return [
    { id: 'claude-sonnet-direct', sdkName: 'claude', tier: 'balanced', modelId: 'anthropic/claude-sonnet-4-6' },
    { id: 'claude-sonnet-openrouter', sdkName: 'openrouter', tier: 'balanced', modelId: 'openrouter/anthropic/claude-sonnet-4-6' },
  ];
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
 * Use this with the `getDefaultCommits()` corpus (or a 1-2 commit
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
