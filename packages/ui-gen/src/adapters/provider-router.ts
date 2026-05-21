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

export type RoutingMode = 'bedrock' | 'anthropic-direct' | 'anthropic-byok';

export interface RoutingDecision {
  readonly mode: RoutingMode;
  readonly model: string;
  readonly env: Record<string, string | undefined>;
  readonly isByok: boolean;
  readonly keySource: 'byok' | 'platform';
}

export interface RoutingInput {
  readonly model: string;
  readonly apiKey?: string;
  readonly env: Record<string, string | undefined>;
}

/**
 * Determine the routing strategy for a generation request.
 *
 * Priority chain:
 * 1. BYOK with customer API key → direct Anthropic API (anthropic-byok)
 * 2. Explicit Bedrock flag → Bedrock IAM (bedrock)
 * 3. Platform API key available → direct Anthropic API (anthropic-direct)
 * 4. No API key → Bedrock IAM (bedrock)
 */
export function resolveRoute(input: RoutingInput): RoutingDecision {
  const { model, apiKey, env } = input;
  const provider = getProviderForModel(model);

  if (provider !== 'anthropic') {
    throw new Error(
      `Provider "${provider}" (model "${model}") is not yet supported for direct BYOK generation. `
      + `Currently only Anthropic models are supported. `
      + `Supported models: anthropic/claude-haiku-4-5, anthropic/claude-sonnet-4-6, anthropic/claude-opus-4-6.`,
    );
  }

  if (apiKey) {
    const upstreamModel = getUpstreamModelId(model);
    return {
      mode: 'anthropic-byok',
      model: upstreamModel,
      env: {
        ANTHROPIC_API_KEY: apiKey,
        ANTHROPIC_BASE_URL: undefined,
        CLAUDE_CODE_USE_BEDROCK: undefined,
      },
      isByok: true,
      keySource: 'byok',
    };
  }

  const explicitBedrock = env.CLAUDE_CODE_USE_BEDROCK === '1';
  const noApiKey = !env.ANTHROPIC_API_KEY;
  if (explicitBedrock || noApiKey) {
    return {
      mode: 'bedrock',
      model: getBedrockModelId(model),
      env: {
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_BASE_URL: undefined,
        CLAUDE_CODE_USE_BEDROCK: '1',
      },
      isByok: false,
      keySource: 'platform',
    };
  }

  const upstreamModel = getUpstreamModelId(model);
  return {
    mode: 'anthropic-direct',
    model: upstreamModel,
    env: {
      ANTHROPIC_BASE_URL: undefined,
      CLAUDE_CODE_USE_BEDROCK: undefined,
    },
    isByok: false,
    keySource: 'platform',
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
