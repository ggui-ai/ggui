/**
 * LLM Provider and Model Types for BYOK (Bring Your Own Key)
 *
 * Model IDs use LiteLLM format: "provider/model-name"
 * This allows direct passthrough to LiteLLM proxy without transformation.
 *
 * Pricing last verified: March 2026
 * Sources:
 *   https://docs.anthropic.com/en/docs/about-claude/pricing
 *   https://developers.openai.com/api/docs/pricing/
 *   https://ai.google.dev/gemini-api/docs/pricing
 */

// =============================================================================
// Provider Types
// =============================================================================

export type LLMProvider = "anthropic" | "google" | "openai" | "openrouter";

export const PROVIDER_INFO: Record<LLMProvider, { displayName: string; keyPrefix: string }> = {
  anthropic: { displayName: "Anthropic", keyPrefix: "sk-ant-" },
  google: { displayName: "Google AI", keyPrefix: "AIza" },
  openai: { displayName: "OpenAI", keyPrefix: "sk-" },
  openrouter: { displayName: "OpenRouter", keyPrefix: "sk-or-" },
};

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
  | "gemini/gemini-3.1-flash-lite-preview"
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
  provider: LLMProvider;
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
  // Default generation model.
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
  "gemini/gemini-3.1-flash-lite-preview": {
    id: "gemini/gemini-3.1-flash-lite-preview",
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

// =============================================================================
// Helper Functions
// =============================================================================

export function isValidModelId(id: string): id is ModelId {
  return id in MODEL_REGISTRY;
}

/**
 * Get provider name from a LiteLLM-format model ID.
 * Returns 'anthropic' as default for unrecognized formats.
 */
export function getProviderForModel(modelId: string): LLMProvider {
  const slash = modelId.indexOf("/");
  if (slash < 0) {
    console.warn(`Unrecognized model format (no slash): "${modelId}" — defaulting to anthropic`);
    return "anthropic";
  }

  const prefix = modelId.substring(0, slash);
  const providerMap: Record<string, LLMProvider> = {
    anthropic: "anthropic",
    gemini: "google",
    openai: "openai",
    openrouter: "openrouter",
  };

  const provider = providerMap[prefix];
  if (!provider) {
    console.warn(`Unrecognized model format: "${modelId}" — defaulting to anthropic`);
    return "anthropic";
  }

  return provider;
}

/**
 * Validate LiteLLM format: "provider/model-name"
 */
export function isValidLiteLLMFormat(modelId: string): boolean {
  const slash = modelId.indexOf("/");
  if (slash <= 0) return false;
  const prefix = modelId.substring(0, slash);
  return ["anthropic", "gemini", "openai", "openrouter"].includes(prefix)
    && modelId.length > slash + 1;
}

/**
 * Get all model IDs for a given provider.
 */
export function getModelsForProvider(provider: LLMProvider): ModelId[] {
  return (Object.values(MODEL_REGISTRY) as ModelConfig[])
    .filter((m) => m.provider === provider)
    .map((m) => m.id);
}

/**
 * Get all model IDs for a given tier.
 */
export function getModelsForTier(tier: ModelTier): ModelId[] {
  return (Object.values(MODEL_REGISTRY) as ModelConfig[])
    .filter((m) => m.tier === tier)
    .map((m) => m.id);
}

/**
 * Select the default model for a given tier.
 */
export function selectModelByTier(tier: ModelTier): ModelId {
  const models = getModelsForTier(tier);
  // Prefer Anthropic models as default
  const anthropic = models.find((m) => m.startsWith("anthropic/"));
  return anthropic ?? models[0] ?? DEFAULT_MODEL;
}
