/**
 * Concrete Google (Gemini) `ProviderAdapter`.
 *
 * Uses the Gemini v1beta `generateContent` REST endpoint. No
 * `@google/genai` SDK dep — keeping ui-gen lean.
 *
 * Wire shape:
 *
 *   Request:
 *     POST /v1beta/models/{model}:generateContent?key={apiKey}
 *     content-type: application/json
 *     {
 *       systemInstruction: { parts: [{ text: systemPrompt }] },
 *       contents: [
 *         { role: 'user', parts: [{ text: userPrompt }] },
 *       ],
 *       generationConfig: { maxOutputTokens?: maxTokens },
 *     }
 *
 *   Response (200):
 *     {
 *       candidates: [{
 *         content: { parts: [{ text: '...' }], role: 'model' },
 *         finishReason: 'STOP'|'MAX_TOKENS'|'SAFETY'|'RECITATION'|'OTHER',
 *       }],
 *       usageMetadata: {
 *         promptTokenCount, candidatesTokenCount, totalTokenCount,
 *       }
 *     }
 *
 * Gemini caveats the harness treats honestly:
 *
 *   - 401 on a missing/malformed API key; 403 on quota / model
 *     access denied. `statusToErrorKind` handles both.
 *   - `?key=` goes in the URL query string per Google's API key
 *     convention. The adapter URL-encodes the key defensively — even
 *     though keys are typically URL-safe, a paste accident MUST NOT
 *     produce a malformed URL that `fetch` would 400 on.
 *   - `finishReason` may be `'OTHER'` or absent entirely; we default
 *     to `'other'`.
 *   - Safety blocks surface as `finishReason: 'SAFETY'` → maps to
 *     `'content-filter'`.
 *   - Version is `v1beta` because `v1` lacks `systemInstruction`
 *     support at time of writing.
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

const PROVIDER: LlmProvider = 'google';
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export interface GoogleAdapterOptions {
  /** Override the API base URL. Test harnesses point at a local mock. */
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export function createGoogleAdapter(
  options: GoogleAdapterOptions = {},
): ProviderAdapter {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
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

      const url = `${baseUrl}/models/${encodeURIComponent(request.route.model)}:generateContent?key=${encodeURIComponent(request.apiKey)}`;

      const body: Record<string, unknown> = {
        systemInstruction: {
          parts: [{ text: request.systemPrompt }],
        },
        contents: [
          { role: 'user', parts: [{ text: request.userPrompt }] },
        ],
      };
      if (request.maxTokens !== undefined) {
        body['generationConfig'] = { maxOutputTokens: request.maxTokens };
      }

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          ...(request.signal ? { signal: request.signal } : {}),
        });
      } catch (err) {
        return { ok: false, error: classifyFetchError(err, PROVIDER, request.signal) };
      }

      const parsedBody = await readJsonBody(response);

      if (!response.ok) {
        return {
          ok: false,
          error: errorFromHttpResponse({
            provider: PROVIDER,
            response,
            bodyText: parsedBody.ok ? parsedBody.text : parsedBody.text,
          }),
        };
      }

      if (!parsedBody.ok) {
        return {
          ok: false,
          error: makeProviderError({
            kind: 'invalid-response',
            provider: PROVIDER,
            message: 'google: 2xx response was not JSON',
          }),
        };
      }

      const parsed = parseGoogleResponse(parsedBody.json);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      return { ok: true, response: parsed.response };
    },
  };
}

function parseGoogleResponse(
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
        message: 'google: response body was not an object',
      }),
    };
  }
  const obj = raw as Record<string, unknown>;
  const candidates = obj['candidates'];
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return {
      ok: false,
      error: makeProviderError({
        kind: 'invalid-response',
        provider: PROVIDER,
        message: 'google: response missing candidates[]',
      }),
    };
  }
  const first = candidates[0] as Record<string, unknown> | undefined;
  if (!first || typeof first !== 'object') {
    return {
      ok: false,
      error: makeProviderError({
        kind: 'invalid-response',
        provider: PROVIDER,
        message: 'google: candidates[0] was not an object',
      }),
    };
  }

  const content = first['content'] as Record<string, unknown> | undefined;
  const parts = content && Array.isArray(content['parts']) ? (content['parts'] as unknown[]) : [];
  const text = parts
    .map((p) => {
      if (!p || typeof p !== 'object') return '';
      const part = p as Record<string, unknown>;
      return typeof part['text'] === 'string' ? (part['text'] as string) : '';
    })
    .join('');

  const finishRaw = first['finishReason'];
  let finishReason: ProviderResponse['finishReason'];
  if (finishRaw === 'STOP') {
    finishReason = 'stop';
  } else if (finishRaw === 'MAX_TOKENS') {
    finishReason = 'length';
  } else if (finishRaw === 'SAFETY' || finishRaw === 'RECITATION') {
    finishReason = 'content-filter';
  } else {
    finishReason = 'other';
  }

  const usage = obj['usageMetadata'] as Record<string, unknown> | undefined;
  const inputTokens =
    usage && typeof usage['promptTokenCount'] === 'number'
      ? (usage['promptTokenCount'] as number)
      : 0;
  const outputTokens =
    usage && typeof usage['candidatesTokenCount'] === 'number'
      ? (usage['candidatesTokenCount'] as number)
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
