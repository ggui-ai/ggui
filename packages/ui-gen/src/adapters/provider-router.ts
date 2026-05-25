// packages/ui-gen/src/adapters/provider-router.ts
//
// Provider router for multi-provider BYOK support. Determines how to
// route LLM requests based on the typed `LlmRoute` discriminator and
// API-key availability.
//
// The previous `getUpstreamModelId` strip + `UPSTREAM_MAP` are gone:
// the typed `LlmRoute` (slice #43) guarantees `route.model` is
// wire-canonical at construction time, so there is no LiteLLM prefix
// to strip at this boundary. `getBedrockModelId` stays — the
// "anthropic route + bedrock IAM" mixed-mode escape hatch (cloud-pod
// legacy) still needs the wire-canonical anthropic id → cross-region
// profile id upcast.

import type { LlmRoute } from '@ggui-ai/protocol';

/**
 * Map a wire-canonical Anthropic model id (or already-bedrock id) to
 * the AWS Bedrock cross-region inference profile id. Used by the
 * mixed-mode `anthropic` route + bedrock-IAM fallback path in
 * {@link resolveRoute} (cloud-pod legacy) and the analogous branch in
 * `harness/llm-router.ts::AnthropicAgent.resolveModel`.
 *
 * Operators picking the bedrock route explicitly (slice #43 Phase 4)
 * pass the cross-region id directly — this helper is purely the
 * fallback escape hatch.
 */
export function getBedrockModelId(model: string): string {
  const BEDROCK_MAP: Record<string, string> = {
    'anthropic/claude-haiku-4-5': 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    'anthropic/claude-sonnet-4-6': 'us.anthropic.claude-sonnet-4-6',
    'anthropic/claude-opus-4-6': 'us.anthropic.claude-opus-4-6-v1:0',
  };
  // Normalize the Bedrock dot-form opt-in (e.g. `anthropic.claude-haiku-4-5`,
  // produced when cloud-pod's `resolvePoolRoute` strips a `bedrock/` opt-in
  // prefix) to the Anthropic slash form. Both spellings should resolve to
  // the same cross-region inference profile id — without this, the dot
  // form would skip the BEDROCK_MAP hit, fall through the `^anthropic\/`
  // strip (which is a no-op for the dot form), and re-prepend
  // `us.anthropic.` to produce a double-`anthropic.` id that Bedrock
  // rejects with 400 (cloud e2e regression 2026-05-25, bedrock-iam.spec).
  const normalized = model.replace(/^anthropic\./, 'anthropic/');
  if (BEDROCK_MAP[normalized]) return BEDROCK_MAP[normalized];
  if (normalized.startsWith('us.anthropic.') || normalized.startsWith('arn:')) {
    return normalized;
  }
  const stripped = normalized.replace(/^anthropic\//, '');
  return `us.anthropic.${stripped}`;
}

export interface RoutingDecision {
  /**
   * Upstream model id the dispatch adapter will pass to the provider
   * SDK. For most routes this is `route.model` verbatim — the typed
   * `LlmRoute` (slice #43) carries the wire-canonical id, so no
   * transformation is needed. The exception is the mixed-mode
   * "anthropic route + bedrock IAM fallback" branch, which upcasts
   * the wire-canonical Anthropic id to the corresponding Bedrock
   * cross-region inference profile id via {@link getBedrockModelId}.
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
  /** Typed `(provider, model)` route — model is wire-canonical. */
  readonly route: LlmRoute;
  /** API key for byok-capable providers; ignored for `bedrock`. */
  readonly apiKey?: string;
  /** Current env snapshot — feeds the anthropic mixed-mode branch. */
  readonly env: Record<string, string | undefined>;
}

/**
 * Sibling-provider env vars that MUST be cleared for every non-self
 * route. Centralized so the per-provider branches below stay
 * symmetric — a single missing entry would let a stale key leak into
 * the next render (e.g. an OpenRouter route inheriting a previous
 * call's `OPENAI_API_KEY` and firing the wrong adapter).
 */
const SIBLING_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'OPENROUTER_API_KEY',
] as const;

function clearSiblings(
  keep: ReadonlySet<(typeof SIBLING_ENV_KEYS)[number]>,
): Record<string, undefined> {
  const out: Record<string, undefined> = {};
  for (const k of SIBLING_ENV_KEYS) {
    if (!keep.has(k)) out[k] = undefined;
  }
  return out;
}

/**
 * Determine the routing strategy for a generation request. Pure
 * function over `(route, apiKey, env)` — returns the upstream model
 * id (usually `route.model` verbatim) and the env-var mutations the
 * caller must apply before dispatch.
 *
 * Dispatch is on `route.provider`:
 *
 *   - `openai`     — direct OpenAI API (sets `OPENAI_API_KEY`).
 *   - `google`     — direct Gemini API (sets `GEMINI_API_KEY` + `GOOGLE_API_KEY`).
 *   - `openrouter` — direct OpenRouter API (sets `OPENROUTER_API_KEY`).
 *   - `bedrock`    — AWS Bedrock via host IAM (sets `CLAUDE_CODE_USE_BEDROCK=1`,
 *                    no API key in flight; model passes verbatim).
 *   - `anthropic`  — three-way fallback chain:
 *       1. With `apiKey` → direct Anthropic API.
 *       2. Without `apiKey` AND explicit `env.CLAUDE_CODE_USE_BEDROCK === '1'`
 *          (or no `env.ANTHROPIC_API_KEY`) → mixed-mode bedrock fallback
 *          (model upcast to cross-region profile via `getBedrockModelId`).
 *          Cloud-pod legacy escape hatch; the OSS Phase 4 strict-fail
 *          prevents end-users from reaching this branch implicitly.
 *       3. Otherwise → direct Anthropic API with whatever
 *          `ANTHROPIC_API_KEY` is already in `env`.
 *
 * For non-Anthropic non-Bedrock providers, an `apiKey` is REQUIRED —
 * there's no IAM-style fallback. Callers that don't have a key MUST
 * surface a "no API key" envelope to their agent before reaching the
 * dispatch path; throwing here is defense in depth.
 */
export function resolveRoute(input: RoutingInput): RoutingDecision {
  const { route, apiKey, env } = input;

  switch (route.provider) {
    case 'openai': {
      if (!apiKey) {
        throw new Error(
          `openai:${route.model} requires an API key. ` +
            `Set 'apiKey' on the RoutingInput (BYOK) or supply your key ` +
            `via your dispatch layer.`,
        );
      }
      return {
        model: route.model,
        env: {
          OPENAI_API_KEY: apiKey,
          ...clearSiblings(new Set(['OPENAI_API_KEY'])),
        },
      };
    }

    case 'google': {
      if (!apiKey) {
        throw new Error(
          `google:${route.model} requires an API key. ` +
            `Set 'apiKey' on the RoutingInput (BYOK) or supply your key ` +
            `via your dispatch layer.`,
        );
      }
      return {
        model: route.model,
        env: {
          // `harness/llm-router.ts`'s GoogleAgent reads `GEMINI_API_KEY
          // || GOOGLE_API_KEY`. Set both so either slot wins;
          // unsetting one would leave a stale value behind.
          GEMINI_API_KEY: apiKey,
          GOOGLE_API_KEY: apiKey,
          ...clearSiblings(new Set(['GEMINI_API_KEY', 'GOOGLE_API_KEY'])),
        },
      };
    }

    case 'openrouter': {
      if (!apiKey) {
        throw new Error(
          `openrouter:${route.model} requires an API key. ` +
            `Set 'apiKey' on the RoutingInput (BYOK) or supply your key ` +
            `via your dispatch layer.`,
        );
      }
      return {
        model: route.model,
        env: {
          OPENROUTER_API_KEY: apiKey,
          ...clearSiblings(new Set(['OPENROUTER_API_KEY'])),
        },
      };
    }

    case 'bedrock': {
      // IAM auth — no apiKey in flight. The model is already a
      // cross-region profile id (e.g.
      // `us.anthropic.claude-haiku-4-5-20251001-v1:0`); pass it
      // verbatim.
      return {
        model: route.model,
        env: {
          CLAUDE_CODE_USE_BEDROCK: '1',
          ...clearSiblings(new Set(['CLAUDE_CODE_USE_BEDROCK'])),
        },
      };
    }

    case 'anthropic': {
      if (apiKey) {
        return {
          model: route.model,
          env: {
            ANTHROPIC_API_KEY: apiKey,
            ...clearSiblings(new Set(['ANTHROPIC_API_KEY'])),
          },
        };
      }
      // Mixed-mode legacy: anthropic route + bedrock IAM fallback.
      // Cloud-pod escape hatch when `ANTHROPIC_API_KEY` isn't seeded.
      const explicitBedrock = env.CLAUDE_CODE_USE_BEDROCK === '1';
      const noApiKey = !env.ANTHROPIC_API_KEY;
      if (explicitBedrock || noApiKey) {
        return {
          model: getBedrockModelId(route.model),
          env: {
            CLAUDE_CODE_USE_BEDROCK: '1',
            ...clearSiblings(new Set(['CLAUDE_CODE_USE_BEDROCK'])),
          },
        };
      }
      // Anthropic via process.env.ANTHROPIC_API_KEY (no in-call key).
      return {
        model: route.model,
        env: clearSiblings(new Set(['ANTHROPIC_API_KEY'])),
      };
    }
  }
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
