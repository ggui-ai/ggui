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
 * Pricing last verified: March 2026
 * Sources:
 *   https://docs.anthropic.com/en/docs/about-claude/pricing
 *   https://developers.openai.com/api/docs/pricing/
 *   https://ai.google.dev/gemini-api/docs/pricing
 */

import type { LlmProvider } from "./llm-route.js";

// =============================================================================
// Model Types (LiteLLM format: provider/model-name)
// =============================================================================

export type ModelId =
  // Anthropic Claude models
  | "anthropic/claude-haiku-4-5"
  | "anthropic/claude-sonnet-4-6"
  | "anthropic/claude-opus-4-6"
  // Google Gemini models (preview suffix required by API for *-preview ids)
  | "gemini/gemini-3.5-flash"
  | "gemini/gemini-3.1-flash-lite"
  | "gemini/gemini-3-flash-preview"
  | "gemini/gemini-3.1-pro-preview"
  // OpenAI models
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
  // Default generation model (ui-gen's default engine; see
  // DEFAULT_MODEL below). Hosted pools default here too.
  "anthropic/claude-haiku-4-5": {
    id: "anthropic/claude-haiku-4-5",
    provider: "anthropic",
    displayName: "Claude Haiku 4.5",
    tier: "fast",
    costs: { inputPer1M: 1.0, outputPer1M: 5.0 },
    maxTokens: 200000,
    supportsTools: true,
  },
  "anthropic/claude-sonnet-4-6": {
    id: "anthropic/claude-sonnet-4-6",
    provider: "anthropic",
    displayName: "Claude Sonnet 4.6",
    tier: "balanced",
    costs: { inputPer1M: 3.0, outputPer1M: 15.0 },
    maxTokens: 200000,
    supportsTools: true,
  },
  "anthropic/claude-opus-4-6": {
    id: "anthropic/claude-opus-4-6",
    provider: "anthropic",
    displayName: "Claude Opus 4.6",
    tier: "premium",
    costs: { inputPer1M: 5.0, outputPer1M: 25.0 },
    maxTokens: 1000000,
    supportsTools: true,
  },

  // ── Google Gemini (API requires "-preview" suffix for previews) ──
  // Pricing values mirror LiteLLM upstream
  // (https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json);
  // host-side consumers may apply a more authoritative price table
  // if they ship one.
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
