/**
 * Focused adapter-level tests for the four concrete providers.
 * Three layers per adapter:
 *
 *   1. `providerAdapterContract` run — proves the adapter satisfies
 *      every structural requirement the provider-adapter contract locks in.
 *   2. Happy-path fetch test — seeds a fake `fetch` with the
 *      provider's real response shape, asserts the adapter parses
 *      text + usage + finishReason correctly.
 *   3. Error-mapping test — verifies HTTP status → ProviderErrorKind
 *      against live `fetch` responses, including `Retry-After`
 *      parsing for 429.
 *
 * Shared `http.ts` helpers (`parseRetryAfter`,
 * `classifyFetchError`, `errorFromHttpResponse`) are exercised
 * through every adapter — no separate unit suite needed.
 */
import { describe, expect, it } from 'vitest';
import { providerAdapterContract } from '../provider-adapter-contract.js';
import {
  parseRetryAfter,
  classifyFetchError,
} from './http.js';
import { createAnthropicAdapter } from './anthropic.js';
import { createBedrockAdapter } from './bedrock.js';
import { createGoogleAdapter } from './google.js';
import { createOpenAiAdapter, selectMaxTokensField } from './openai.js';
import { createOpenRouterAdapter } from './openrouter.js';
import { selectAdapter } from './index.js';

// ─── http.ts helpers ──────────────────────────────────────────

describe('parseRetryAfter', () => {
  it('parses numeric seconds', () => {
    expect(parseRetryAfter('30')).toBe(30);
    expect(parseRetryAfter('  10  ')).toBe(10);
    expect(parseRetryAfter('0.5')).toBe(1); // ceil
  });

  it('parses HTTP-date (future) to seconds from now', () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const result = parseRetryAfter(future);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(61);
  });

  it('returns undefined for past dates', () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfter(past)).toBeUndefined();
  });

  it('returns undefined for null / empty / garbage', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('   ')).toBeUndefined();
    expect(parseRetryAfter('not-a-date')).toBeUndefined();
    expect(parseRetryAfter('-5')).toBeUndefined();
  });
});

describe('classifyFetchError', () => {
  it('prefers already-aborted signal over Error shape', () => {
    const controller = new AbortController();
    controller.abort('gave up');
    const err = classifyFetchError(new Error('TCP'), 'anthropic', controller.signal);
    expect(err.kind).toBe('aborted');
    expect(err.message).toBe('gave up');
  });

  it('classifies AbortError by name', () => {
    const raw = Object.assign(new Error('canceled'), { name: 'AbortError' });
    expect(classifyFetchError(raw, 'openai').kind).toBe('aborted');
  });

  it('maps generic Error to network', () => {
    const err = classifyFetchError(new TypeError('fetch failed'), 'google');
    expect(err.kind).toBe('network');
    expect(err.message).toBe('fetch failed');
  });

  it('maps string payload to unknown', () => {
    expect(classifyFetchError('opaque', 'openai').kind).toBe('unknown');
  });
});

// ─── Helper: build a fake fetch that returns one response ──────

function fakeFetch(args: {
  readonly status?: number;
  readonly statusText?: string;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
  /** Called with the request init so tests can assert body + headers. */
  readonly spy?: (url: string, init: RequestInit | undefined) => void;
}): typeof globalThis.fetch {
  const status = args.status ?? 200;
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    args.spy?.(typeof input === 'string' ? input : String(input), init);
    const body =
      typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
    return new Response(body, {
      status,
      statusText: args.statusText ?? (status === 200 ? 'OK' : ''),
      headers: {
        'content-type': 'application/json',
        ...args.headers,
      },
    });
  }) as typeof globalThis.fetch;
}

// ─── Anthropic adapter ───────────────────────────────────────

describe('AnthropicAdapter — contract', () => {
  providerAdapterContract({
    name: 'anthropic',
    expectedProvider: 'anthropic',
    buildAdapter: () =>
      createAnthropicAdapter({
        fetch: fakeFetch({
          status: 401,
          body: { error: { message: 'x' } },
        }),
      }),
    errorFixtures: {
      network: new TypeError('ECONNRESET'),
      // `invalid-response` is produced inside `complete()` on an
      // unparseable 2xx body, not through `mapError`. The happy-path
      // tests below cover that case with a non-JSON response body.
      unknown: 'opaque',
    },
  });
});

describe('AnthropicAdapter — happy path', () => {
  it('parses content[] + usage + stop_reason', async () => {
    let capturedInit: RequestInit | undefined;
    const adapter = createAnthropicAdapter({
      fetch: fakeFetch({
        status: 200,
        body: {
          content: [
            { type: 'text', text: 'part 1 ' },
            { type: 'text', text: 'part 2' },
          ],
          stop_reason: 'end_turn',
          usage: { input_tokens: 11, output_tokens: 22 },
        },
        spy: (_url, init) => {
          capturedInit = init;
        },
      }),
    });
    const result = await adapter.complete({
      apiKey: 'k',
      model: 'claude-opus-4-7',
      systemPrompt: 'sys',
      userPrompt: 'u',
      maxTokens: 256,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.text).toBe('part 1 part 2');
    expect(result.response.finishReason).toBe('stop');
    expect(result.response.usage).toEqual({
      inputTokens: 11,
      outputTokens: 22,
    });

    expect(capturedInit?.method).toBe('POST');
    const headers = capturedInit?.headers as Record<string, string> | undefined;
    expect(headers?.['x-api-key']).toBe('k');
    expect(headers?.['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(capturedInit?.body as string) as Record<string, unknown>;
    expect(body['model']).toBe('claude-opus-4-7');
    expect(body['max_tokens']).toBe(256);
    expect(body['system']).toBe('sys');
  });

  it('maps max_tokens stop_reason → length', async () => {
    const adapter = createAnthropicAdapter({
      fetch: fakeFetch({
        status: 200,
        body: {
          content: [{ type: 'text', text: 'truncated' }],
          stop_reason: 'max_tokens',
          usage: { input_tokens: 5, output_tokens: 5 },
        },
      }),
    });
    const result = await adapter.complete({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.finishReason).toBe('length');
  });

  it('extracts retry-after on 429', async () => {
    const adapter = createAnthropicAdapter({
      fetch: fakeFetch({
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'retry-after': '45' },
        body: { error: { message: 'slow down' } },
      }),
    });
    const result = await adapter.complete({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('rate-limited');
    expect(result.error.retryAfterSec).toBe(45);
    expect(result.error.status).toBe(429);
  });

  it('maps 2xx non-JSON body to invalid-response', async () => {
    const adapter = createAnthropicAdapter({
      fetch: fakeFetch({ status: 200, body: 'not json', headers: { 'content-type': 'text/plain' } }),
    });
    const result = await adapter.complete({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-response');
  });
});

// ─── OpenAI adapter ──────────────────────────────────────────

describe('selectMaxTokensField', () => {
  it('picks max_completion_tokens for gpt-5.x / o1 / o3 / o4', () => {
    expect(selectMaxTokensField('gpt-5.4-mini')).toBe('max_completion_tokens');
    expect(selectMaxTokensField('gpt-5')).toBe('max_completion_tokens');
    expect(selectMaxTokensField('o1-preview')).toBe('max_completion_tokens');
    expect(selectMaxTokensField('o3-mini')).toBe('max_completion_tokens');
    expect(selectMaxTokensField('o4-experimental')).toBe('max_completion_tokens');
  });

  it('picks max_tokens for legacy chat-completions models', () => {
    expect(selectMaxTokensField('gpt-4o')).toBe('max_tokens');
    expect(selectMaxTokensField('gpt-4-turbo')).toBe('max_tokens');
    expect(selectMaxTokensField('gpt-3.5-turbo')).toBe('max_tokens');
  });

  it('is case-insensitive', () => {
    expect(selectMaxTokensField('GPT-5.4-mini')).toBe('max_completion_tokens');
    expect(selectMaxTokensField('O1-preview')).toBe('max_completion_tokens');
  });
});

describe('OpenAiAdapter — contract', () => {
  providerAdapterContract({
    name: 'openai',
    expectedProvider: 'openai',
    buildAdapter: () =>
      createOpenAiAdapter({
        fetch: fakeFetch({ status: 403, body: { error: { message: 'x' } } }),
      }),
    errorFixtures: {
      network: new TypeError('DNS failure'),
      unknown: 'opaque',
    },
  });
});

describe('OpenAiAdapter — happy path', () => {
  it('parses choices[0].message.content + usage + finish_reason', async () => {
    let capturedInit: RequestInit | undefined;
    const adapter = createOpenAiAdapter({
      fetch: fakeFetch({
        status: 200,
        body: {
          choices: [
            {
              message: { role: 'assistant', content: 'hi there' },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 7,
            completion_tokens: 13,
            total_tokens: 20,
          },
        },
        spy: (_u, init) => {
          capturedInit = init;
        },
      }),
    });
    const result = await adapter.complete({
      apiKey: 'sk-test',
      model: 'gpt-4o',
      systemPrompt: 'sys',
      userPrompt: 'u',
      maxTokens: 128,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.text).toBe('hi there');
    expect(result.response.finishReason).toBe('stop');
    expect(result.response.usage).toEqual({
      inputTokens: 7,
      outputTokens: 13,
    });

    const headers = capturedInit?.headers as Record<string, string> | undefined;
    expect(headers?.['authorization']).toBe('Bearer sk-test');
    const body = JSON.parse(capturedInit?.body as string) as Record<string, unknown>;
    expect(body['model']).toBe('gpt-4o');
    expect(body['max_tokens']).toBe(128);
    const messages = body['messages'] as Array<{ role: string; content: string }>;
    expect(messages[0]?.role).toBe('system');
    expect(messages[1]?.role).toBe('user');
  });

  it('maps content_filter → content-filter', async () => {
    const adapter = createOpenAiAdapter({
      fetch: fakeFetch({
        status: 200,
        body: {
          choices: [
            { message: { content: '...' }, finish_reason: 'content_filter' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
      }),
    });
    const result = await adapter.complete({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.finishReason).toBe('content-filter');
  });

  it('maps 401 → unauthorized', async () => {
    const adapter = createOpenAiAdapter({
      fetch: fakeFetch({ status: 401, body: { error: { message: 'invalid' } } }),
    });
    const result = await adapter.complete({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('unauthorized');
    expect(result.error.status).toBe(401);
  });
});

// ─── OpenRouter adapter ──────────────────────────────────────

describe('OpenRouterAdapter — contract', () => {
  providerAdapterContract({
    name: 'openrouter',
    expectedProvider: 'openrouter',
    buildAdapter: () =>
      createOpenRouterAdapter({
        fetch: fakeFetch({ status: 500, body: { error: { message: 'x' } } }),
      }),
    errorFixtures: {
      network: new TypeError('reset'),
      unknown: 42,
    },
  });
});

describe('OpenRouterAdapter — happy path', () => {
  it('reuses OpenAI wire shape + sends HTTP-Referer + X-Title', async () => {
    let capturedInit: RequestInit | undefined;
    const adapter = createOpenRouterAdapter({
      referer: 'https://example.test',
      title: 'test-app',
      fetch: fakeFetch({
        status: 200,
        body: {
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 4 },
        },
        spy: (_u, init) => {
          capturedInit = init;
        },
      }),
    });
    const result = await adapter.complete({
      apiKey: 'or-key',
      model: 'anthropic/claude-opus-4',
      systemPrompt: 's',
      userPrompt: 'u',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.text).toBe('ok');

    const headers = capturedInit?.headers as Record<string, string> | undefined;
    expect(headers?.['authorization']).toBe('Bearer or-key');
    expect(headers?.['HTTP-Referer']).toBe('https://example.test');
    expect(headers?.['X-Title']).toBe('test-app');
  });
});

// ─── Google adapter ──────────────────────────────────────────

describe('GoogleAdapter — contract', () => {
  providerAdapterContract({
    name: 'google',
    expectedProvider: 'google',
    buildAdapter: () =>
      createGoogleAdapter({
        fetch: fakeFetch({ status: 429, headers: { 'retry-after': '10' }, body: { error: { message: 'x' } } }),
      }),
    errorFixtures: {
      network: new TypeError('reset'),
      unknown: null,
    },
  });
});

describe('GoogleAdapter — happy path', () => {
  it('parses candidates[0].content.parts + usageMetadata + finishReason', async () => {
    let capturedUrl = '';
    const adapter = createGoogleAdapter({
      baseUrl: 'https://example.test/v1beta',
      fetch: fakeFetch({
        status: 200,
        body: {
          candidates: [
            {
              content: {
                parts: [{ text: 'g1 ' }, { text: 'g2' }],
                role: 'model',
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 2,
            candidatesTokenCount: 8,
            totalTokenCount: 10,
          },
        },
        spy: (url) => {
          capturedUrl = url;
        },
      }),
    });
    const result = await adapter.complete({
      apiKey: 'gkey&',
      model: 'gemini-2.0-flash',
      systemPrompt: 's',
      userPrompt: 'u',
      maxTokens: 512,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.text).toBe('g1 g2');
    expect(result.response.finishReason).toBe('stop');
    expect(result.response.usage).toEqual({
      inputTokens: 2,
      outputTokens: 8,
    });

    // Ensure URL-encoding for API key + model.
    expect(capturedUrl).toContain('/models/gemini-2.0-flash:generateContent');
    expect(capturedUrl).toContain('key=gkey%26');
  });

  it('maps SAFETY finishReason → content-filter', async () => {
    const adapter = createGoogleAdapter({
      fetch: fakeFetch({
        status: 200,
        body: {
          candidates: [
            { content: { parts: [{ text: '' }] }, finishReason: 'SAFETY' },
          ],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 0 },
        },
      }),
    });
    const result = await adapter.complete({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.finishReason).toBe('content-filter');
  });

  it('maps 429 with retry-after header', async () => {
    const adapter = createGoogleAdapter({
      fetch: fakeFetch({
        status: 429,
        headers: { 'retry-after': '15' },
        body: { error: { message: 'rate' } },
      }),
    });
    const result = await adapter.complete({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('rate-limited');
    expect(result.error.retryAfterSec).toBe(15);
  });
});

// ─── Bedrock adapter ─────────────────────────────────────────
//
// Bedrock differs from the four direct-API adapters in two ways that
// affect testing:
//
//   1. No request-level API key — IAM at process boot is the auth
//      boundary. `validateConfig` accepts (and ignores) any apiKey
//      value, including empty. This breaks the `providerAdapterContract`
//      runner's no-credentials-on-empty assertion, so we test
//      structural shape inline instead.
//   2. Wraps `@anthropic-ai/bedrock-sdk` not native `fetch` — the test
//      injects a mock client via `clientFactory` rather than a fake
//      fetch. The mock returns a minimal Anthropic.Messages.Message
//      shape; the adapter's parser is the unit under test.

describe('BedrockAdapter — construction + identity', () => {
  it('constructs with no options + reports `bedrock` provider', () => {
    const adapter = createBedrockAdapter();
    expect(adapter.provider).toBe('bedrock');
  });

  it('reports `bedrock` provider with explicit region', () => {
    const adapter = createBedrockAdapter({ region: 'us-west-2' });
    expect(adapter.provider).toBe('bedrock');
  });

  it('does NOT throw on construction (lazy SDK client)', () => {
    // Adapter must be constructible in the absence of AWS credentials —
    // the SDK client is built lazily on first `complete(...)` call.
    expect(() => createBedrockAdapter({ region: 'us-east-1' })).not.toThrow();
  });
});

describe('BedrockAdapter — validateConfig', () => {
  it('accepts requests WITHOUT an apiKey (IAM-only auth)', () => {
    const adapter = createBedrockAdapter();
    // Empty apiKey is valid for Bedrock — the four other adapters
    // would return `no-credentials` here. The pod-generator passes a
    // sentinel like `'bedrock-iam'` so the wire envelope stays
    // non-empty, but the adapter itself MUST tolerate either.
    expect(adapter.validateConfig({ apiKey: '', model: 'anthropic.claude-haiku-4-5' }).ok).toBe(true);
    expect(adapter.validateConfig({ apiKey: 'bedrock-iam', model: 'anthropic.claude-haiku-4-5' }).ok).toBe(true);
  });

  it('rejects requests with an empty model id', () => {
    const adapter = createBedrockAdapter();
    const result = adapter.validateConfig({ apiKey: 'bedrock-iam', model: '' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('client-error');
    expect(result.error.provider).toBe('bedrock');
  });

  it('accepts cross-region inference profile model ids', () => {
    const adapter = createBedrockAdapter();
    // `us.anthropic.*` / `eu.anthropic.*` / `apac.anthropic.*` are
    // valid Bedrock model ids — pass-through preserved.
    expect(
      adapter.validateConfig({
        apiKey: 'bedrock-iam',
        model: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
      }).ok,
    ).toBe(true);
  });
});

describe('BedrockAdapter — mapError', () => {
  it('funnels null / undefined into `unknown` (never throws)', () => {
    const adapter = createBedrockAdapter();
    expect(adapter.mapError(null).kind).toBe('unknown');
    expect(adapter.mapError(undefined).kind).toBe('unknown');
  });

  it('classifies generic Error as `network`', () => {
    const adapter = createBedrockAdapter();
    const err = adapter.mapError(new TypeError('ECONNRESET'));
    expect(err.kind).toBe('network');
    expect(err.provider).toBe('bedrock');
  });

  it('classifies AbortError as `aborted`', () => {
    const adapter = createBedrockAdapter();
    const raw = Object.assign(new Error('canceled'), { name: 'AbortError' });
    expect(adapter.mapError(raw).kind).toBe('aborted');
  });
});

// ─── selectAdapter registry ───────────────────────────────────

describe('selectAdapter', () => {
  it('returns concrete adapters for every LlmProvider entry', () => {
    expect(selectAdapter('anthropic').provider).toBe('anthropic');
    expect(selectAdapter('google').provider).toBe('google');
    expect(selectAdapter('openai').provider).toBe('openai');
    expect(selectAdapter('openrouter').provider).toBe('openrouter');
    // Bedrock joined the open surface in the
    // bedrock-adapter-and-retire-secrets-pool slice (2026-04-27) —
    // IAM-based auth means OSS users on AWS-credentialed hosts can
    // target Bedrock without managing API keys.
    expect(selectAdapter('bedrock').provider).toBe('bedrock');
  });
});
