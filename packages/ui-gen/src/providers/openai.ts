/**
 * Concrete OpenAI `ProviderAdapter`.
 *
 * Hits `POST https://api.openai.com/v1/chat/completions` with native
 * `fetch`. No `openai` SDK dep — same leanness reason as the
 * Anthropic adapter.
 *
 * Wire shape (chat completions v1, stable):
 *
 *   Request:
 *     POST /v1/chat/completions
 *     authorization: Bearer <apiKey>
 *     content-type: application/json
 *     {
 *       model, max_tokens?, messages: [
 *         {role:'system', content: systemPrompt},
 *         {role:'user', content: userPrompt},
 *       ]
 *     }
 *
 *   Response (200):
 *     {
 *       choices: [{
 *         message: { role: 'assistant', content: '...' },
 *         finish_reason: 'stop'|'length'|'content_filter'|'tool_calls'|...,
 *       }],
 *       usage: { prompt_tokens, completion_tokens, total_tokens }
 *     }
 *
 * `finish_reason` → `finishReason` normalization:
 *
 *   - `'stop'`            → `'stop'`
 *   - `'length'`          → `'length'`
 *   - `'content_filter'`  → `'content-filter'`
 *   - everything else     → `'other'`
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

const PROVIDER: LlmProvider = 'openai';
const DEFAULT_ENDPOINT = 'https://api.openai.com/v1/chat/completions';

export interface OpenAiAdapterOptions {
  readonly endpoint?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export function createOpenAiAdapter(
  options: OpenAiAdapterOptions = {},
): ProviderAdapter {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
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
            message: 'openai: 2xx response was not JSON',
          }),
        };
      }

      const parsed = parseOpenAiResponse(body.json, PROVIDER);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      return { ok: true, response: parsed.response };
    },
  };
}

/**
 * Build the OpenAI request body. Exported (package-private) so the
 * OpenRouter adapter can reuse it — OpenRouter is wire-compatible
 * with OpenAI's chat-completions shape.
 *
 * Token-cap parameter selection:
 *
 *   - `gpt-5*`, `o1*`, `o3*`, `o4*` (reasoning + new-API models) →
 *     `max_completion_tokens`. The legacy `max_tokens` field returns
 *     400 `unsupported_parameter` on these models per the OpenAI 2024-09
 *     deprecation: "Unsupported parameter: 'max_tokens' is not supported
 *     with this model. Use 'max_completion_tokens' instead."
 *   - Everything else (`gpt-4*`, `gpt-3.5*`, etc.) → `max_tokens` for
 *     backwards-compat with the chat-completions field that's been
 *     stable since 2023.
 *
 * Heuristic chosen over a hard model-list because new gpt-5.x variants
 * ship continuously; the prefix is the contract OpenAI exposes. Same
 * heuristic applies to OpenRouter which wires to backing models — when
 * a caller picks `gpt-5.4-mini` through OpenRouter the same rule fires.
 */
export function buildOpenAiBody(request: ProviderRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: [
      { role: 'system', content: request.systemPrompt },
      { role: 'user', content: request.userPrompt },
    ],
  };
  if (request.maxTokens !== undefined) {
    body[selectMaxTokensField(request.model)] = request.maxTokens;
  }
  return body;
}

/**
 * Pick which token-cap field name to send. Bare-string match on the
 * leading model identifier — no SDK lookup, no async; runs once per
 * request body build.
 */
export function selectMaxTokensField(model: string): 'max_tokens' | 'max_completion_tokens' {
  const m = model.toLowerCase();
  if (m.startsWith('gpt-5') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')) {
    return 'max_completion_tokens';
  }
  return 'max_tokens';
}

/**
 * Parse an OpenAI-shape chat-completions response. Reused by the
 * OpenRouter adapter (wire-compatible).
 */
export function parseOpenAiResponse(
  raw: unknown,
  provider: LlmProvider,
):
  | { ok: true; response: ProviderResponse }
  | { ok: false; error: ProviderError } {
  if (!raw || typeof raw !== 'object') {
    return {
      ok: false,
      error: makeProviderError({
        kind: 'invalid-response',
        provider,
        message: `${provider}: response body was not an object`,
      }),
    };
  }
  const obj = raw as Record<string, unknown>;
  const choices = obj['choices'];
  if (!Array.isArray(choices) || choices.length === 0) {
    return {
      ok: false,
      error: makeProviderError({
        kind: 'invalid-response',
        provider,
        message: `${provider}: response missing choices[]`,
      }),
    };
  }
  const first = choices[0] as Record<string, unknown> | undefined;
  if (!first || typeof first !== 'object') {
    return {
      ok: false,
      error: makeProviderError({
        kind: 'invalid-response',
        provider,
        message: `${provider}: choices[0] was not an object`,
      }),
    };
  }

  const message = first['message'] as Record<string, unknown> | undefined;
  const text =
    message && typeof message['content'] === 'string'
      ? (message['content'] as string)
      : '';

  const finishRaw = first['finish_reason'];
  let finishReason: ProviderResponse['finishReason'];
  if (finishRaw === 'stop') {
    finishReason = 'stop';
  } else if (finishRaw === 'length') {
    finishReason = 'length';
  } else if (finishRaw === 'content_filter') {
    finishReason = 'content-filter';
  } else {
    finishReason = 'other';
  }

  const usage = obj['usage'] as Record<string, unknown> | undefined;
  const inputTokens =
    usage && typeof usage['prompt_tokens'] === 'number'
      ? (usage['prompt_tokens'] as number)
      : 0;
  const outputTokens =
    usage && typeof usage['completion_tokens'] === 'number'
      ? (usage['completion_tokens'] as number)
      : 0;

  return {
    ok: true,
    response: {
      text,
      usage: { inputTokens, outputTokens },
      finishReason,
    },
  };
}
