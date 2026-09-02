/**
 * LLM PRICING + MODEL REGISTRY (LiteLLM-keyed).
 *
 * Scope split (locked 2026-05-25, slice #43 close-out):
 *
 *   - `MODEL_REGISTRY` here = LiteLLM-keyed pricing + capability
 *     metadata. Keys are LiteLLM strings (`"gemini/gemini-3.5-flash"`,
 *     `"openai/gpt-5.4-mini"`, …). Read by:
 *       - `cloud/ggui-protocol-pod` pricing-drift test (vendored
 *         LiteLLM JSON pricing table)
 *       - `oss/misc/benchmark` runner (bench harness; picks model
 *         configs by LiteLLM key)
 *       - `scripts/check-litellm-pricing-drift.ts` (CI guard)
 *     This registry's keys MUST stay in LiteLLM format because the
 *     vendored pricing JSON they cross-reference is LiteLLM-shaped.
 *
 *   - LLM routing lives in {@link ./llm-route} — typed `LlmRoute`
 *     discriminated union (`provider:model` canonical or
 *     `provider/model` LiteLLM-compat). Every LLM call site threads
 *     `LlmRoute`; the registry KEY equals the wire-canonical id the
 *     provider's API expects. See
 *     `docs/principles/model-string-convention.md`.
 *
 * The old routing helpers (`getProviderForModel`, `isValidLiteLLMFormat`,
 * `LLMProvider` (capital)) were deleted in the slice #43 close-out —
 * routing went through `parseAnyLlmRoute` + typed dispatch.
 *
 * Pricing last verified: 2026-08-04 (all three providers re-checked
 * against the vendored LiteLLM snapshot + vendor announcements).
 * Sources:
 *   https://docs.anthropic.com/en/docs/about-claude/pricing
 *   https://developers.openai.com/api/docs/pricing/
 *   https://ai.google.dev/gemini-api/docs/pricing
 *
 * KEEPING THIS HONEST: `costs` here is what the benchmark harness and
 * every cost read price against, and until 2026-07-31 nothing compared
 * it to anything — the vendored-snapshot test only asserted a row
 * EXISTS, and `scripts/check-litellm-pricing-drift.ts` compares the
 * snapshot against upstream, never the registry. That gap let this
 * table sit four months stale while production routed to models it did
 * not even list. The pod's `pricing-tables.test.ts` now asserts every
 * entry's `costs` match the vendored rate (with an explicit, dated
 * PENDING_UPSTREAM allowlist for prices we learn before LiteLLM does).
 * Add a model here and you MUST re-vendor the snapshot in the same
 * slice.
 */

import type { LlmProvider } from "./llm-route.js";

// =============================================================================
// Model Types (LiteLLM format: provider/model-name)
// =============================================================================

export type ModelId =
  // Anthropic Claude models
  | "anthropic/claude-fable-5"
  | "anthropic/claude-opus-5"
  | "anthropic/claude-sonnet-5"
  | "anthropic/claude-haiku-4-5"
  | "anthropic/claude-opus-4-7"
  | "anthropic/claude-sonnet-4-6"
  | "anthropic/claude-opus-4-6"
  // Google Gemini models (preview suffix required by API for *-preview ids)
  | "gemini/gemini-3.7-flash"
  | "gemini/gemini-3.6-flash"
  | "gemini/gemini-3.5-flash"
  | "gemini/gemini-3.5-flash-lite"
  | "gemini/gemini-3.1-flash-lite"
  | "gemini/gemini-3-flash-preview"
  | "gemini/gemini-3.1-pro-preview"
  // OpenAI models
  | "openai/gpt-5.6-sol"
  | "openai/gpt-5.6-terra"
  | "openai/gpt-5.6-luna"
  | "openai/gpt-5.3-codex"
  | "openai/gpt-5.4"
  | "openai/gpt-5.4-mini"
  | "openai/gpt-5.4-nano";

export type ModelTier = "fast" | "balanced" | "premium";

export interface ModelConfig {
  id: ModelId;
  provider: LlmProvider;
  displayName: string;
  tier: ModelTier;
  costs: {
    inputPer1M: number;
    outputPer1M: number;
    /**
     * Cache-write token rate (Anthropic prices a cache WRITE at ~1.25×
     * the input rate). Omit if the provider doesn't bill prompt caching
     * separately — consumers fall back to {@link inputPer1M}.
     */
    cacheWritePer1M?: number;
    /**
     * Cache-read token rate (Anthropic prices a cache READ at ~0.1× the
     * input rate). Omit if the provider doesn't bill prompt caching
     * separately — consumers fall back to {@link inputPer1M}.
     */
    cacheReadPer1M?: number;
  };
  maxTokens: number;
  supportsTools: boolean;
  supportsCaching?: boolean;
  supportsThinking?: boolean;
}

// =============================================================================
// Model Registry — verified pricing March 2026
// =============================================================================

export const MODEL_REGISTRY: Record<ModelId, ModelConfig> = {
  // ── Anthropic Claude ──────────────────────────────────────────────
  "anthropic/claude-fable-5": {
    id: "anthropic/claude-fable-5",
    provider: "anthropic",
    displayName: "Claude Fable 5",
    tier: "premium",
    costs: {
      inputPer1M: 10.0,
      outputPer1M: 50.0,
      cacheWritePer1M: 12.5,
      cacheReadPer1M: 1.0,
    },
    maxTokens: 1000000,
    supportsTools: true,
  },
  "anthropic/claude-opus-5": {
    id: "anthropic/claude-opus-5",
    provider: "anthropic",
    displayName: "Claude Opus 5",
    tier: "premium",
    costs: {
      inputPer1M: 5.0,
      outputPer1M: 25.0,
      cacheWritePer1M: 6.25,
      cacheReadPer1M: 0.5,
    },
    maxTokens: 1000000,
    supportsTools: true,
  },
  // NOTE(pricing): $2/$10 launched as an introductory rate but is now
  // the PERMANENT standard price — Anthropic's pricing docs state the
  // scheduled 2026-09-01 increase to $3/$15 will not occur (verified
  // platform.claude.com/docs/en/about-claude/pricing, 2026-08-19).
  "anthropic/claude-sonnet-5": {
    id: "anthropic/claude-sonnet-5",
    provider: "anthropic",
    displayName: "Claude Sonnet 5",
    tier: "balanced",
    costs: {
      inputPer1M: 2.0,
      outputPer1M: 10.0,
      cacheWritePer1M: 2.5,
      cacheReadPer1M: 0.2,
    },
    maxTokens: 1000000,
    supportsTools: true,
  },
  // Default generation model (ui-gen's default engine; see
  // DEFAULT_MODEL below). Hosted pools default here too.
  "anthropic/claude-haiku-4-5": {
    id: "anthropic/claude-haiku-4-5",
    provider: "anthropic",
    displayName: "Claude Haiku 4.5",
    tier: "fast",
    costs: {
      inputPer1M: 1.0,
      outputPer1M: 5.0,
      cacheWritePer1M: 1.25,
      cacheReadPer1M: 0.1,
    },
    maxTokens: 200000,
    supportsTools: true,
  },
  "anthropic/claude-sonnet-4-6": {
    id: "anthropic/claude-sonnet-4-6",
    provider: "anthropic",
    displayName: "Claude Sonnet 4.6",
    tier: "balanced",
    costs: {
      inputPer1M: 3.0,
      outputPer1M: 15.0,
      cacheWritePer1M: 3.75,
      cacheReadPer1M: 0.3,
    },
    maxTokens: 200000,
    supportsTools: true,
  },
  "anthropic/claude-opus-4-7": {
    id: "anthropic/claude-opus-4-7",
    provider: "anthropic",
    displayName: "Claude Opus 4.7",
    tier: "premium",
    costs: {
      inputPer1M: 5.0,
      outputPer1M: 25.0,
      cacheWritePer1M: 6.25,
      cacheReadPer1M: 0.5,
    },
    maxTokens: 1000000,
    supportsTools: true,
  },
  "anthropic/claude-opus-4-6": {
    id: "anthropic/claude-opus-4-6",
    provider: "anthropic",
    displayName: "Claude Opus 4.6",
    tier: "premium",
    costs: {
      inputPer1M: 5.0,
      outputPer1M: 25.0,
      cacheWritePer1M: 6.25,
      cacheReadPer1M: 0.5,
    },
    maxTokens: 1000000,
    supportsTools: true,
  },

  // ── Google Gemini (API requires "-preview" suffix for previews) ──
  // Pricing values mirror LiteLLM upstream
  // (https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json);
  // host-side consumers may apply a more authoritative price table
  // if they ship one.
  // NOTE(pricing): 3.7-flash and 3.6-flash are on Google's INTRODUCTORY
  // rate ($0.75/$3.75) through 2026-12-31; both double to $1.50/$7.50 on
  // 2027-01-01 (ai.google.dev/gemini-api/docs/pricing, 2026-08-19). The
  // vendored snapshot carries the intro rate too, so the drift guard
  // will not flag the increase for us — re-check these entries then.
  "gemini/gemini-3.7-flash": {
    id: "gemini/gemini-3.7-flash",
    provider: "google",
    displayName: "Gemini 3.7 Flash",
    tier: "balanced",
    costs: { inputPer1M: 0.75, outputPer1M: 3.75, cacheReadPer1M: 0.075 },
    maxTokens: 1048576,
    supportsTools: true,
    supportsCaching: true,
  },
  "gemini/gemini-3.6-flash": {
    id: "gemini/gemini-3.6-flash",
    provider: "google",
    displayName: "Gemini 3.6 Flash",
    tier: "fast",
    // 2026-08-19 re-vendor: cut from $1.5/$7.5 to the 3.7-launch intro
    // rate (see NOTE above 3.7-flash).
    costs: { inputPer1M: 0.75, outputPer1M: 3.75, cacheReadPer1M: 0.075 },
    maxTokens: 1048576,
    supportsTools: true,
    supportsCaching: true,
  },
  "gemini/gemini-3.5-flash": {
    id: "gemini/gemini-3.5-flash",
    provider: "google",
    displayName: "Gemini 3.5 Flash",
    tier: "fast",
    costs: { inputPer1M: 1.5, outputPer1M: 9.0 },
    maxTokens: 1048576,
    supportsTools: true,
    supportsCaching: true,
  },
  // Google-lane generation default (`evaluator.ts`, `generation-probe.ts`).
  "gemini/gemini-3.5-flash-lite": {
    id: "gemini/gemini-3.5-flash-lite",
    provider: "google",
    displayName: "Gemini 3.5 Flash Lite",
    tier: "fast",
    costs: { inputPer1M: 0.3, outputPer1M: 2.5, cacheReadPer1M: 0.03 },
    maxTokens: 1048576,
    supportsTools: true,
    supportsCaching: true,
  },
  // Google-lane reference model (cost-per-token floor).
  "gemini/gemini-3.1-flash-lite": {
    id: "gemini/gemini-3.1-flash-lite",
    provider: "google",
    displayName: "Gemini 3.1 Flash Lite",
    tier: "fast",
    costs: { inputPer1M: 0.25, outputPer1M: 1.5 },
    maxTokens: 1000000,
    supportsTools: true,
  },
  "gemini/gemini-3-flash-preview": {
    id: "gemini/gemini-3-flash-preview",
    provider: "google",
    displayName: "Gemini 3 Flash",
    tier: "fast",
    costs: { inputPer1M: 0.5, outputPer1M: 3.0 },
    maxTokens: 1000000,
    supportsTools: true,
  },
  "gemini/gemini-3.1-pro-preview": {
    id: "gemini/gemini-3.1-pro-preview",
    provider: "google",
    displayName: "Gemini 3.1 Pro",
    tier: "balanced",
    costs: { inputPer1M: 2.0, outputPer1M: 12.0 },
    maxTokens: 1000000,
    supportsTools: true,
  },

  // ── OpenAI ────────────────────────────────────────────────────────
  // GPT-5.6 family (2026-07). OpenAI cut Luna 80% and Terra 20% on
  // 2026-07-30; Sol was left unchanged. The 2026-08-04 re-vendor
  // confirmed upstream LiteLLM has ingested both cuts, so these costs
  // now agree with the vendored snapshot (no PENDING_UPSTREAM
  // exemption needed).
  "openai/gpt-5.6-sol": {
    id: "openai/gpt-5.6-sol",
    provider: "openai",
    displayName: "GPT-5.6 Sol",
    tier: "premium",
    costs: {
      inputPer1M: 4.0,
      outputPer1M: 20.0,
      cacheWritePer1M: 5.0,
      cacheReadPer1M: 0.4,
    },
    maxTokens: 1050000,
    supportsTools: true,
  },
  "openai/gpt-5.6-terra": {
    id: "openai/gpt-5.6-terra",
    provider: "openai",
    displayName: "GPT-5.6 Terra",
    tier: "balanced",
    costs: { inputPer1M: 2.0, outputPer1M: 12.0, cacheReadPer1M: 0.2 },
    maxTokens: 1050000,
    supportsTools: true,
  },
  // OpenAI-lane generation default (`evaluator.ts`, `generation-probe.ts`).
  "openai/gpt-5.6-luna": {
    id: "openai/gpt-5.6-luna",
    provider: "openai",
    displayName: "GPT-5.6 Luna",
    tier: "fast",
    costs: { inputPer1M: 0.2, outputPer1M: 1.2, cacheReadPer1M: 0.02 },
    maxTokens: 1050000,
    supportsTools: true,
  },
  "openai/gpt-5.3-codex": {
    id: "openai/gpt-5.3-codex",
    provider: "openai",
    displayName: "GPT-5.3 Codex",
    tier: "balanced",
    costs: { inputPer1M: 1.75, outputPer1M: 14.0 },
    maxTokens: 200000,
    supportsTools: true,
  },
  "openai/gpt-5.4": {
    id: "openai/gpt-5.4",
    provider: "openai",
    displayName: "GPT-5.4",
    tier: "premium",
    costs: { inputPer1M: 2.5, outputPer1M: 15.0 },
    maxTokens: 1050000,
    supportsTools: true,
  },
  "openai/gpt-5.4-mini": {
    id: "openai/gpt-5.4-mini",
    provider: "openai",
    displayName: "GPT-5.4 Mini",
    tier: "fast",
    costs: { inputPer1M: 0.75, outputPer1M: 4.5 },
    maxTokens: 400000,
    supportsTools: true,
  },
  "openai/gpt-5.4-nano": {
    id: "openai/gpt-5.4-nano",
    provider: "openai",
    displayName: "GPT-5.4 Nano",
    tier: "fast",
    costs: { inputPer1M: 0.20, outputPer1M: 1.25 },
    maxTokens: 400000,
    supportsTools: true,
  },
} as const;

/**
 * Default model for generation
 */
export const DEFAULT_MODEL: ModelId = "anthropic/claude-haiku-4-5";
