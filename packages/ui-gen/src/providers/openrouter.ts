/**
 * Concrete OpenRouter `ProviderAdapter`.
 *
 * OpenRouter exposes an OpenAI-compatible chat-completions API at
 * `https://openrouter.ai/api/v1/chat/completions`. Request + response
 * shapes match OpenAI's — so this adapter reuses
 * `buildOpenAiBody` / `parseOpenAiResponse` and just swaps endpoint +
 * recommended headers.
 *
 * OpenRouter-specific:
 *   - Model IDs are namespaced: `'anthropic/claude-opus-4'`,
 *     `'openai/gpt-4o'`, etc. The OSS generator surface accepts an
 *     opaque string — OpenRouter model IDs pass through verbatim.
 *   - `HTTP-Referer` + `X-Title` headers are OPTIONAL per OpenRouter's
 *     docs but strongly recommended for usage analytics. They DO NOT
 *     carry auth — safe to expose publicly. Adapters accept overrides
 *     via options; OSS default is `'https://ggui.ai'` / `'ggui'`.
 *   - 401 / 402 (insufficient credit) / 429 (rate limit) come back in
 *     the same shape as OpenAI — `statusToErrorKind` handles them.
 *     402 maps to `'client-error'` by default; OpenRouter's own
 *     `type: 'payment_required'` is surfaced in the message string.
 */
import type { LlmProvider } from '@ggui-ai/mcp-server-core';
import {
  defaultValidateConfig,
  makeProviderError,
  type ProviderAdapter,
  type ProviderError,
  type ProviderRequest,
  type ProviderResult,
  type ProviderValidation,
} from '../provider-adapter.js';
import {
  classifyFetchError,
  errorFromHttpResponse,
  readJsonBody,
} from './http.js';
import { buildOpenAiBody, parseOpenAiResponse } from './openai.js';

const PROVIDER: LlmProvider = 'openrouter';
const DEFAULT_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_REFERRER = 'https://ggui.ai';
const DEFAULT_TITLE = 'ggui';

export interface OpenRouterAdapterOptions {
  readonly endpoint?: string;
  readonly referer?: string;
  readonly title?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export function createOpenRouterAdapter(
  options: OpenRouterAdapterOptions = {},
): ProviderAdapter {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const referer = options.referer ?? DEFAULT_REFERRER;
  const title = options.title ?? DEFAULT_TITLE;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  function mapError(raw: unknown): ProviderError {
    return classifyFetchError(raw, PROVIDER);
  }

  return {
    provider: PROVIDER,
    validateConfig(
      request: Pick<ProviderRequest, 'apiKey' | 'model'>,
    ): ProviderValidation {
      return defaultValidateConfig(PROVIDER, request);
    },
    mapError,
    async complete(request: ProviderRequest): Promise<ProviderResult> {
      const pre = defaultValidateConfig(PROVIDER, request);
      if (!pre.ok) return { ok: false, error: pre.error };
      if (request.signal?.aborted) {
        return { ok: false, error: classifyFetchError(null, PROVIDER, request.signal) };
      }

      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${request.apiKey}`,
            'content-type': 'application/json',
            'HTTP-Referer': referer,
            'X-Title': title,
          },
          body: JSON.stringify(buildOpenAiBody(request)),
          ...(request.signal ? { signal: request.signal } : {}),
        });
      } catch (err) {
        return { ok: false, error: classifyFetchError(err, PROVIDER, request.signal) };
      }

      const body = await readJsonBody(response);

      if (!response.ok) {
        return {
          ok: false,
          error: errorFromHttpResponse({
            provider: PROVIDER,
            response,
            bodyText: body.ok ? body.text : body.text,
          }),
        };
      }

      if (!body.ok) {
        return {
          ok: false,
          error: makeProviderError({
            kind: 'invalid-response',
            provider: PROVIDER,
            message: 'openrouter: 2xx response was not JSON',
          }),
        };
      }

      const parsed = parseOpenAiResponse(body.json, PROVIDER);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      return { ok: true, response: parsed.response };
    },
  };
}
