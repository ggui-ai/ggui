import { describe, expect, it } from 'vitest';
import {
  defaultValidateConfig,
  makeProviderError,
  statusToErrorKind,
  type ProviderErrorKind,
} from './provider-adapter';
import { createMockProviderAdapter } from './provider-adapter-mock';
import { providerAdapterContract } from './provider-adapter-contract';

// ─── 1. Sanity unit tests on the helpers ───────────────────────────

describe('statusToErrorKind — locked HTTP-status → ProviderErrorKind mapping', () => {
  const cases: ReadonlyArray<[number, ProviderErrorKind]> = [
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [429, 'rate-limited'],
    [500, 'server-error'],
    [502, 'server-error'],
    [503, 'server-error'],
    [504, 'server-error'],
    [400, 'client-error'],
    [404, 'client-error'],
    [422, 'client-error'],
    [301, 'unknown'], // 3xx — no canonical bucket; most providers don't redirect
    [200, 'unknown'], // 2xx — should never reach here, but classify safely
    [0, 'unknown'],
  ];
  for (const [status, expected] of cases) {
    it(`maps ${status} → '${expected}'`, () => {
      expect(statusToErrorKind(status)).toBe(expected);
    });
  }
});

describe('defaultValidateConfig — universal pre-flight failures', () => {
  it('rejects empty apiKey with no-credentials', () => {
    const result = defaultValidateConfig('anthropic', { apiKey: '', model: 'm' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('no-credentials');
    expect(result.error.provider).toBe('anthropic');
    // Message scrubs key material — there's nothing to scrub when
    // empty, but the contract is "no key material in messages".
    expect(result.error.message).not.toMatch(/sk-/);
  });

  it('rejects empty model with client-error', () => {
    const result = defaultValidateConfig('openai', { apiKey: 'k', model: '' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('client-error');
  });

  it('passes when both fields are non-empty', () => {
    expect(
      defaultValidateConfig('google', { apiKey: 'k', model: 'gemini-pro' }),
    ).toEqual({ ok: true });
  });
});

describe('makeProviderError — field-shape discipline', () => {
  it('omits status when not supplied (no `status: undefined` in the object)', () => {
    const err = makeProviderError({
      kind: 'network',
      provider: 'openai',
      message: 'ECONNRESET',
    });
    expect('status' in err).toBe(false);
    expect('retryAfterSec' in err).toBe(false);
  });

  it('omits retryAfterSec when not supplied', () => {
    const err = makeProviderError({
      kind: 'rate-limited',
      provider: 'anthropic',
      message: '429',
      status: 429,
    });
    expect(err.status).toBe(429);
    expect('retryAfterSec' in err).toBe(false);
  });

  it('includes retryAfterSec when supplied', () => {
    const err = makeProviderError({
      kind: 'rate-limited',
      provider: 'anthropic',
      message: '429',
      status: 429,
      retryAfterSec: 30,
    });
    expect(err.retryAfterSec).toBe(30);
  });
});

// ─── 2. Direct behavioral tests on MockProviderAdapter ─────────────

describe('MockProviderAdapter — direct behavior', () => {
  it('returns a successful response when no error is queued', async () => {
    const adapter = createMockProviderAdapter({
      scriptedResponse: 'hello',
      scriptedUsage: { inputTokens: 10, outputTokens: 5 },
    });
    const result = await adapter.complete({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.text).toBe('hello');
    expect(result.response.usage.inputTokens).toBe(10);
    expect(result.response.usage.outputTokens).toBe(5);
    expect(result.response.finishReason).toBe('stop');
    expect(adapter.callCount()).toBe(1);
  });

  it('drains errors FIFO across multiple calls', async () => {
    const adapter = createMockProviderAdapter();
    adapter.enqueueError({ __status: 401 });
    adapter.enqueueError({ __status: 429, retryAfterSec: 7 });

    const r1 = await adapter.complete({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
    });
    expect(r1.ok).toBe(false);
    if (r1.ok) throw new Error('expected r1 to be the error variant');
    expect(r1.error.kind).toBe('unauthorized');
    expect(r1.error.status).toBe(401);

    const r2 = await adapter.complete({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
    });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error.kind).toBe('rate-limited');
    expect(r2.error.retryAfterSec).toBe(7);

    // Queue drained — third call succeeds.
    const r3 = await adapter.complete({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
    });
    expect(r3.ok).toBe(true);
  });

  it('honors AbortSignal aborted-before-call and returns kind:"aborted" without burning queued errors', async () => {
    const adapter = createMockProviderAdapter();
    adapter.enqueueError({ __status: 401 }); // should NOT be consumed
    const controller = new AbortController();
    controller.abort();
    const result = await adapter.complete({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
      signal: controller.signal,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('aborted');
    // The queued 401 fixture is still there for the next call.
    const next = await adapter.complete({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
    });
    expect(next.ok).toBe(false);
    if (next.ok) return;
    expect(next.error.kind).toBe('unauthorized');
  });

  it('honors AbortSignal aborted-mid-call', async () => {
    const adapter = createMockProviderAdapter();
    const controller = new AbortController();
    const promise = adapter.complete({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
      signal: controller.signal,
    });
    controller.abort();
    const result = await promise;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('aborted');
  });

  it('mapError classifies Error instances as unknown with the message preserved', () => {
    const adapter = createMockProviderAdapter();
    const err = adapter.mapError(new Error('boom'));
    expect(err.kind).toBe('unknown');
    expect(err.message).toBe('boom');
  });

  it('mapError handles strings, null, undefined without throwing', () => {
    const adapter = createMockProviderAdapter();
    expect(adapter.mapError('opaque').kind).toBe('unknown');
    expect(adapter.mapError(null).kind).toBe('unknown');
    expect(adapter.mapError(undefined).kind).toBe('unknown');
  });

  it('every provider name is preserved through mapError', () => {
    const providers = (['anthropic', 'google', 'openai', 'openrouter'] as const);
    for (const p of providers) {
      const adapter = createMockProviderAdapter({ provider: p });
      expect(adapter.mapError(new Error('x')).provider).toBe(p);
      expect(adapter.mapError({ __status: 500 }).provider).toBe(p);
    }
  });
});

// ─── 3. Run the contract suite against MockProviderAdapter ─────────
//
// Proves the contract is satisfiable by an in-tree implementation
// AND exercises every assertion the runner makes. Concrete adapters
// paste a near-identical block with their own fixtures.

providerAdapterContract({
  name: 'MockProviderAdapter',
  buildAdapter: () => createMockProviderAdapter(),
  expectedProvider: 'anthropic',
  errorFixtures: {
    unauthorized: { __status: 401 },
    forbidden: { __status: 403 },
    'rate-limited': { __status: 429, retryAfterSec: 12 },
    'server-error': { __status: 502 },
    'client-error': { __status: 400 },
    network: { __network: true, message: 'EAI_AGAIN' },
    'invalid-response': { __invalidResponse: true },
    unknown: 'opaque',
  },
});
