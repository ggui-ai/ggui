/**
 * Concrete Anthropic `ProviderAdapter`.
 *
 * Hits `POST https://api.anthropic.com/v1/messages` directly with
 * native `fetch`. No `@anthropic-ai/sdk` dep — keeping
 * `@ggui-ai/ui-gen` lean is load-bearing; every consumer of the
 * generator contract (OSS + hosted) downloads this package at
 * install time.
 *
 * Wire shape (as of `anthropic-version: 2023-06-01`, stable):
 *
 *   Request:
 *     POST /v1/messages
 *     x-api-key: <apiKey>
 *     anthropic-version: 2023-06-01
 *     content-type: application/json
 *     {
 *       model, max_tokens, system, messages: [{role:'user', content}]
 *     }
 *
 *   Response (200):
 *     {
 *       content: [{type:'text', text:'...'}],
 *       stop_reason: 'end_turn'|'max_tokens'|'stop_sequence'|'tool_use',
 *       usage: { input_tokens, output_tokens }
 *     }
 *
 * `stop_reason` → `finishReason` normalization:
 *
 *   - `end_turn` / `stop_sequence`  → `'stop'`
 *   - `max_tokens`                  → `'length'`
 *   - everything else               → `'other'`
 *
 * (Anthropic does not surface a distinct `content-filter` stop reason
 * on v1/messages today; filtering shows up as a 400 error with a
 * `permission_error` / `invalid_request_error` body instead. That
 * path maps to `client-error` through `statusToErrorKind`.)
 */
import type { LlmProvider } from '@ggui-ai/mcp-server-core';
import {
  defaultValidateConfig,
  makeProviderError,
  type ProviderAdapter,
  type ProviderError,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderResult,
  type ProviderValidation,
} from '../provider-adapter.js';
import {
  classifyFetchError,
  errorFromHttpResponse,
  readJsonBody,
} from './http.js';

const PROVIDER: LlmProvider = 'anthropic';
const DEFAULT_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const DEFAULT_API_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicAdapterOptions {
  /** Override for tests + self-hosted proxies. */
  readonly endpoint?: string;
  /** Override `anthropic-version` header. */
  readonly apiVersion?: string;
  /** Optional fetch override for tests / instrumentation. */
  readonly fetch?: typeof globalThis.fetch;
}

export function createAnthropicAdapter(
  options: AnthropicAdapterOptions = {},
): ProviderAdapter {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  function mapError(raw: unknown): ProviderError {
    return classifyFetchError(raw, PROVIDER);
  }

  return {
    provider: PROVIDER,
    validateConfig(
      request: Pick<ProviderRequest, 'apiKey' | 'route'>,
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
            'x-api-key': request.apiKey,
            'anthropic-version': apiVersion,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: request.route.model,
            max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
            system: request.systemPrompt,
            messages: [{ role: 'user', content: request.userPrompt }],
          }),
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
            message: 'anthropic: 2xx response was not JSON',
          }),
        };
      }

      const parsed = parseAnthropicResponse(body.json);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      return { ok: true, response: parsed.response };
    },
  };
}

function parseAnthropicResponse(
  raw: unknown,
):
  | { ok: true; response: ProviderResponse }
  | { ok: false; error: ProviderError } {
  if (!raw || typeof raw !== 'object') {
    return {
      ok: false,
      error: makeProviderError({
        kind: 'invalid-response',
        provider: PROVIDER,
        message: 'anthropic: response body was not an object',
      }),
    };
  }
  const obj = raw as Record<string, unknown>;
  const content = obj['content'];
  if (!Array.isArray(content)) {
    return {
      ok: false,
      error: makeProviderError({
        kind: 'invalid-response',
        provider: PROVIDER,
        message: 'anthropic: response missing `content` array',
      }),
    };
  }

  // Concatenate every text block. Anthropic sometimes splits a
  // response across multiple text blocks (tool_use blocks are
  // filtered out — this adapter does not support tool use).
  const text = content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const b = block as Record<string, unknown>;
      if (b['type'] === 'text' && typeof b['text'] === 'string') {
        return b['text'] as string;
      }
      return '';
    })
    .join('');

  const usage = obj['usage'] as Record<string, unknown> | undefined;
  const inputTokens =
    usage && typeof usage['input_tokens'] === 'number'
      ? (usage['input_tokens'] as number)
      : 0;
  const outputTokens =
    usage && typeof usage['output_tokens'] === 'number'
      ? (usage['output_tokens'] as number)
      : 0;

  const stopReason = obj['stop_reason'];
  let finishReason: ProviderResponse['finishReason'];
  if (stopReason === 'end_turn' || stopReason === 'stop_sequence') {
    finishReason = 'stop';
  } else if (stopReason === 'max_tokens') {
    finishReason = 'length';
  } else {
    finishReason = 'other';
  }

  return {
    ok: true,
    response: {
      text,
      usage: { inputTokens, outputTokens },
      finishReason,
    },
  };
}
