// packages/ui-gen/src/adapters/provider-router.ts
//
// Provider router for multi-provider BYOK support. Determines how to
// route LLM requests based on model ID and API key availability.

import { getProviderForModel } from '@ggui-ai/protocol';

/**
 * Map a LiteLLM model alias (e.g. "anthropic/claude-haiku-4-5") to the
 * upstream model ID that the provider's API expects.
 */
export function getUpstreamModelId(model: string): string {
  const UPSTREAM_MAP: Record<string, string> = {
    'anthropic/claude-haiku-4-5': 'claude-haiku-4-5-20251001',
    'anthropic/claude-sonnet-4-6': 'claude-sonnet-4-6',
    'anthropic/claude-opus-4-6': 'claude-opus-4-6-20260201',
  };
  if (UPSTREAM_MAP[model]) return UPSTREAM_MAP[model];
  if (model.startsWith('gemini/')) return model;
  if (model.startsWith('openai/')) return model.replace(/^openai\//, '');
  return model;
}

/**
 * Map model IDs to Bedrock-compatible US cross-region inference profile IDs.
 */
export function getBedrockModelId(model: string): string {
  const BEDROCK_MAP: Record<string, string> = {
    'anthropic/claude-haiku-4-5': 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    'anthropic/claude-sonnet-4-6': 'us.anthropic.claude-sonnet-4-6',
    'anthropic/claude-opus-4-6': 'us.anthropic.claude-opus-4-6-v1:0',
  };
  if (BEDROCK_MAP[model]) return BEDROCK_MAP[model];
  if (model.startsWith('us.anthropic.') || model.startsWith('arn:')) return model;
  const stripped = model.replace(/^anthropic\//, '');
  return `us.anthropic.${stripped}`;
}

export interface RoutingDecision {
  /**
   * Upstream model id the dispatch adapter will pass to the provider
   * SDK — already transformed for the chosen route (e.g.
   * `getBedrockModelId` upcasts an `anthropic/...` alias to a
   * `us.anthropic.*` inference profile when routing through Bedrock).
   */
  readonly model: string;
  /**
   * Env-var mutations the caller MUST apply to `process.env` before
   * invoking the dispatch adapter. `undefined` values are deletions
   * (the wrong provider's stale key must be cleared so the dispatch
   * doesn't accidentally fire against it). See {@link applyRouteToEnv}.
   */
  readonly env: Record<string, string | undefined>;
}

export interface RoutingInput {
  readonly model: string;
  readonly apiKey?: string;
  readonly env: Record<string, string | undefined>;
}

/**
 * Determine the routing strategy for a generation request.
 *
 * Anthropic priority chain (unchanged):
 *   1. BYOK with customer API key → direct Anthropic API (anthropic-byok)
 *   2. Explicit Bedrock flag → Bedrock IAM (bedrock)
 *   3. Platform API key available → direct Anthropic API (anthropic-direct)
 *   4. No API key → Bedrock IAM (bedrock)
 *
 * Multi-provider extension (2026-05-24):
 *   - `openai/*` → `openai-direct` (sets `OPENAI_API_KEY`)
 *   - `gemini/*` → `gemini-direct` (sets `GEMINI_API_KEY`)
 *   - `openrouter/*` → `openrouter-direct` (sets `OPENROUTER_API_KEY`)
 *
 * For non-Anthropic providers, an `apiKey` is REQUIRED — there's no
 * IAM-style fallback (Bedrock-IAM is Anthropic-only). Callers that
 * lack a key MUST surface a `NO_PLATFORM_KEY` envelope upstream
 * before reaching the dispatch path.
 */
export function resolveRoute(input: RoutingInput): RoutingDecision {
  const { model, apiKey, env } = input;
  const provider = getProviderForModel(model);

  // ── Non-Anthropic providers: API key required ───────────────────
  // Each provider gets its own env var (read by the matching adapter
  // in `harness/llm-router.ts`). The other providers' env vars are
  // cleared so a previous call's keys can't leak into this one.
  if (provider === 'openai') {
    if (!apiKey) {
      throw new Error(
        `Model "${model}" requires an OpenAI API key. ` +
          `Platform-pool callers MUST resolve the key from the pool ` +
          `cache before dispatch; BYOK callers MUST supply their own.`,
      );
    }
    return {
      // OpenAI SDK accepts the bare model id (e.g. `'gpt-5.4'`); the
      // upstream id helper strips the `openai/` LiteLLM prefix.
      model: getUpstreamModelId(model),
      env: {
        OPENAI_API_KEY: apiKey,
        // Clear sibling-provider env so the wrong adapter can't fire.
        ANTHROPIC_API_KEY: undefined,
        GEMINI_API_KEY: undefined,
        GOOGLE_API_KEY: undefined,
        OPENROUTER_API_KEY: undefined,
        CLAUDE_CODE_USE_BEDROCK: undefined,
      },
    };
  }

  if (provider === 'google') {
    if (!apiKey) {
      throw new Error(
        `Model "${model}" requires a Google (Gemini) API key. ` +
          `Platform-pool callers MUST resolve the key from the pool ` +
          `cache before dispatch; BYOK callers MUST supply their own.`,
      );
    }
    return {
      model: getUpstreamModelId(model),
      env: {
        // `harness/llm-router.ts`'s GoogleAgent reads `GEMINI_API_KEY ||
        // GOOGLE_API_KEY`. We set both to the same value so either
        // adapter slot picks the platform key up; clearing one would
        // leave a stale value behind on the next call.
        GEMINI_API_KEY: apiKey,
        GOOGLE_API_KEY: apiKey,
        ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        OPENROUTER_API_KEY: undefined,
        CLAUDE_CODE_USE_BEDROCK: undefined,
      },
    };
  }

  if (provider === 'openrouter') {
    if (!apiKey) {
      throw new Error(
        `Model "${model}" requires an OpenRouter API key. ` +
          `Platform-pool callers MUST resolve the key from the pool ` +
          `cache before dispatch; BYOK callers MUST supply their own.`,
      );
    }
    return {
      // OpenRouter accepts the full `openrouter/<provider>/<model>`
      // path verbatim — no prefix-strip.
      model,
      env: {
        OPENROUTER_API_KEY: apiKey,
        ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        GEMINI_API_KEY: undefined,
        GOOGLE_API_KEY: undefined,
        CLAUDE_CODE_USE_BEDROCK: undefined,
      },
    };
  }

  // ── Anthropic priority chain (existing path) ────────────────────
  if (apiKey) {
    const upstreamModel = getUpstreamModelId(model);
    return {
      model: upstreamModel,
      env: {
        ANTHROPIC_API_KEY: apiKey,
        ANTHROPIC_BASE_URL: undefined,
        CLAUDE_CODE_USE_BEDROCK: undefined,
        // Clear sibling-provider keys for symmetry with the new
        // routes; an Anthropic-direct call must not inherit a stale
        // OPENAI_API_KEY from the previous render.
        OPENAI_API_KEY: undefined,
        GEMINI_API_KEY: undefined,
        GOOGLE_API_KEY: undefined,
        OPENROUTER_API_KEY: undefined,
      },
    };
  }

  const explicitBedrock = env.CLAUDE_CODE_USE_BEDROCK === '1';
  const noApiKey = !env.ANTHROPIC_API_KEY;
  if (explicitBedrock || noApiKey) {
    return {
      model: getBedrockModelId(model),
      env: {
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_BASE_URL: undefined,
        CLAUDE_CODE_USE_BEDROCK: '1',
        OPENAI_API_KEY: undefined,
        GEMINI_API_KEY: undefined,
        GOOGLE_API_KEY: undefined,
        OPENROUTER_API_KEY: undefined,
      },
    };
  }

  const upstreamModel = getUpstreamModelId(model);
  return {
    model: upstreamModel,
    env: {
      ANTHROPIC_BASE_URL: undefined,
      CLAUDE_CODE_USE_BEDROCK: undefined,
      OPENAI_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      GOOGLE_API_KEY: undefined,
      OPENROUTER_API_KEY: undefined,
    },
  };
}

/**
 * Apply routing decision to an environment object.
 */
export function applyRouteToEnv(
  baseEnv: Record<string, string>,
  route: RoutingDecision,
): Record<string, string> {
  const result = { ...baseEnv };
  for (const [key, value] of Object.entries(route.env)) {
    if (value === undefined) {
      delete result[key];
    } else {
      result[key] = value;
    }
  }
  return result;
}
