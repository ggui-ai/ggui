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
    // Matrix refresh 2026-08-19 (#557 follow-up): balanced/premium moved to
    // the current standard lineup per platform.claude.com model overview —
    // sonnet-4-6/opus-4-6 are now filed under "Legacy models". Fable 5 was
    // deliberately NOT the premium slot: premium = the provider's flagship
    // STANDARD tier ($5/$25 Opus 5), not the above-standard capability SKU.
    //
    // 2026-09-02 (#713, Fable 5.1 sweep #706): the frontier SKU now rides as
    // its OWN arm, `claude-frontier` (below), alongside claude-premium — a
    // 10th default variant, announced in the methodology changelog. Both
    // carry tier 'premium' only because ModelTier has no 4th value; they are
    // separate arms with separate rows. Consequence for bench.mjs selection:
    // `-p claude --tier premium` runs both. History (published rows) is
    // untouched.
    {
      id: 'claude-fast',
      sdkName: 'claude',
      tier: 'fast',
      modelId: 'anthropic/claude-haiku-4-5', // still the current Haiku (no 5)
    },
    {
      id: 'claude-balanced',
      sdkName: 'claude',
      tier: 'balanced',
      modelId: 'anthropic/claude-sonnet-5',
    },
    {
      id: 'claude-premium',
      sdkName: 'claude',
      tier: 'premium',
      modelId: 'anthropic/claude-opus-5',
    },
    {
      // Frontier SKU (Claude Fable 5.1, $10/$50 per MTok, registry row
      // landed ggui#707). Adaptive thinking is always on and the model
      // rejects sampling params; the router handles both (ggui#710).
      id: 'claude-frontier',
      sdkName: 'claude',
      tier: 'premium',
      modelId: 'anthropic/claude-fable-5-1',
    },

    // --- OpenAI ---
    // Matrix refresh 2026-08-19: balanced/premium moved to the GPT-5.6
    // frontier family (developers.openai.com/api/docs/models) — terra/sol
    // supersede 5.4-mini/5.4, which remain GA but off the frontier page.
    {
      id: 'openai-fast',
      sdkName: 'openai',
      tier: 'fast',
      // Fast-tier refresh (Exp 52a follow-up, 2026-08-08): luna replaces
      // the retired-from-rotation 5.4-nano as the openai fast SKU. Still
      // current 2026-08-19 (cheapest 5.6-family SKU after the Jul 30 cut).
      modelId: 'openai/gpt-5.6-luna',
    },
    {
      id: 'openai-balanced',
      sdkName: 'openai',
      tier: 'balanced',
      modelId: 'openai/gpt-5.6-terra',
    },
    {
      id: 'openai-premium',
      sdkName: 'openai',
      tier: 'premium',
      modelId: 'openai/gpt-5.6-sol',
    },

    // --- Google (Gemini) ---
    {
      id: 'google-fast',
      sdkName: 'google',
      tier: 'fast',
      // Canonical google fast floor — priced in MODEL_REGISTRY, cheaper
      // than gemini-3.5-flash. Fast-tier refresh (2026-08-08):
      // 3.5-flash-lite replaces 3.1. Still current 2026-08-19.
      modelId: 'gemini/gemini-3.5-flash-lite',
    },
    {
      id: 'google-balanced',
      sdkName: 'google',
      tier: 'balanced',
      // Matrix refresh 2026-08-19: 3.7-flash (GA 2026-08-13, Google's
      // "workhorse model for coding and agents") replaces 3.1-pro-preview
      // in the balanced slot — newer and ~60% cheaper.
      modelId: 'gemini/gemini-3.7-flash',
    },
    {
      id: 'google-premium',
      sdkName: 'google',
      tier: 'premium',
      // Still no Ultra/above-Pro tier and no newer Pro as of 2026-08-19
      // (3.1-pro-preview remains Google's designated top reasoning tier;
      // the only GA Pro is the older 2.5). Keep pro-preview.
      modelId: 'gemini/gemini-3.1-pro-preview',
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
    // 2026-08-19: gemini-3-flash-preview + gemini-3.1-flash-lite-preview
    // dropped — both preview ids are absent from the current Gemini model
    // docs (3.1-flash-lite-preview is confirmed shut down; its GA id
    // lives on). Replaced with the GA generation.
    {
      id: 'gemini-3.5-flash',
      sdkName: 'google',
      tier: 'fast',
      modelId: 'gemini/gemini-3.5-flash',
    },
    {
      id: 'gemini-3.1-flash-lite',
      sdkName: 'google',
      tier: 'fast',
      modelId: 'gemini/gemini-3.1-flash-lite',
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
        reviewModel: 'anthropic/claude-sonnet-5', // 2026-08-19: 4-6 → 5
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
        draftModel: 'gemini/gemini-3.5-flash', // 2026-08-19: 3-preview gone
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
    // 2026-08-19: claude legs moved sonnet-4-6 → sonnet-5 (current balanced).
    // gpt-5.3-codex stays — still OpenAI's latest codex model (no 5.4/5.6
    // codex exists as of 2026-08-19).
    { sdkName: 'claude', modelId: 'anthropic/claude-sonnet-5' },
    { sdkName: 'openai', modelId: 'openai/gpt-5.3-codex' },
    { sdkName: 'google', modelId: 'gemini/gemini-3.1-pro-preview' },
    { sdkName: 'openrouter', modelId: 'openrouter/anthropic/claude-sonnet-5' },
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
