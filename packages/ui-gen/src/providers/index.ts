/**
 * Public barrel for `@ggui-ai/ui-gen/providers`.
 *
 * Concrete {@link ProviderAdapter} implementations for the LLM
 * providers ggui supports today: Anthropic (direct API), Google,
 * OpenAI, OpenRouter, and AWS Bedrock (Anthropic models via IAM).
 *
 * Every adapter satisfies the structural
 * {@link import('../provider-adapter.js').ProviderAdapter} contract.
 * The four direct-API adapters compose
 * `defaultValidateConfig` + `makeProviderError` + `statusToErrorKind`
 * + the shared helpers in `./http.ts` and pull NO vendor SDK (~10MB
 * savings). Bedrock is the exception — it pulls
 * `@anthropic-ai/bedrock-sdk` (a zero-dep package over native fetch)
 * because rolling our own AWS SigV4 signer for one provider isn't a
 * reasonable trade.
 *
 * Typical usage from the CLI:
 *
 *   ```ts
 *   import { createAnthropicAdapter } from '@ggui-ai/ui-gen/providers';
 *   import { createUiGenerator } from '@ggui-ai/ui-gen';
 *
 *   const adapter = createAnthropicAdapter();
 *   const generator = createUiGenerator({ adapter });
 *   const result = await generator.generate({ request, llm, providerKey, blueprints });
 *   ```
 *
 * Bedrock pool path (no API key — IAM at process boot):
 *
 *   ```ts
 *   import { createBedrockAdapter } from '@ggui-ai/ui-gen/providers';
 *   const adapter = createBedrockAdapter({ region: 'us-east-1' });
 *   // pass `providerKey: { provider: 'bedrock', key: 'bedrock-iam' }`
 *   // (sentinel — adapter ignores; satisfies the non-empty contract).
 *   ```
 */
export { createAnthropicAdapter } from './anthropic.js';
export type { AnthropicAdapterOptions } from './anthropic.js';

export { createGoogleAdapter } from './google.js';
export type { GoogleAdapterOptions } from './google.js';

export { createOpenAiAdapter } from './openai.js';
export type { OpenAiAdapterOptions } from './openai.js';

export { createOpenRouterAdapter } from './openrouter.js';
export type { OpenRouterAdapterOptions } from './openrouter.js';

export { createBedrockAdapter } from './bedrock.js';
export type { BedrockAdapterOptions } from './bedrock.js';

import type { LlmProvider } from '@ggui-ai/mcp-server-core';
import type { ProviderAdapter } from '../provider-adapter.js';
import { createAnthropicAdapter } from './anthropic.js';
import { createGoogleAdapter } from './google.js';
import { createOpenAiAdapter } from './openai.js';
import { createOpenRouterAdapter } from './openrouter.js';
import { createBedrockAdapter } from './bedrock.js';

/**
 * Construct the default adapter for a given provider. Every entry in
 * the `LlmProvider` union now has a concrete adapter — Bedrock joined
 * the open surface because it's the cleanest pool-path
 * (`mcp.ggui.ai` free-credit) story (IAM auth, no API key in flight,
 * AWS-managed cost reporting).
 *
 * Callers that want custom options (test fetch, proxy endpoint,
 * OpenRouter referer, Bedrock region) should construct the concrete
 * adapter directly — this helper is a sensible default for the
 * common case.
 */
export function selectAdapter(provider: LlmProvider): ProviderAdapter {
  switch (provider) {
    case 'anthropic':
      return createAnthropicAdapter();
    case 'google':
      return createGoogleAdapter();
    case 'openai':
      return createOpenAiAdapter();
    case 'openrouter':
      return createOpenRouterAdapter();
    case 'bedrock':
      return createBedrockAdapter();
  }
}
