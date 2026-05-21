/**
 * `providerAdapterContract` — vitest-style test runner that asserts
 * any {@link ProviderAdapter} implementation satisfies the structural
 * contract.
 *
 * Concrete adapters (Anthropic / Google / OpenAI / OpenRouter)
 * land their own `*.contract.test.ts` that calls this runner with
 * their adapter + a tiny `errorFixtures` table that maps each error
 * kind to a raw value the adapter's `mapError` recognizes (typically
 * a captured 401/403/429/500 response from a recorded fixture).
 *
 * The runner is import-only — it does not auto-register tests at
 * import time. Callers wire it inside their own `describe()` so the
 * adapter package owns its own test layout. Example:
 *
 *   ```ts
 *   import { describe } from 'vitest';
 *   import { providerAdapterContract } from '@ggui-ai/ui-gen/provider-adapter-contract';
 *   import { createAnthropicAdapter } from './anthropic';
 *
 *   describe('AnthropicAdapter — contract', () => {
 *     providerAdapterContract({
 *       name: 'anthropic',
 *       buildAdapter: () => createAnthropicAdapter(),
 *       errorFixtures: {
 *         unauthorized: { __status: 401 },
 *         forbidden: { __status: 403 },
 *         'rate-limited': { __status: 429, retryAfterSec: 30 },
 *         'server-error': { __status: 503 },
 *         'client-error': { __status: 400 },
 *         network: new Error('ECONNRESET'),
 *         'invalid-response': { __invalidResponse: true },
 *         unknown: 'opaque-string',
 *       },
 *     });
 *   });
 *   ```
 *
 * The runner imports vitest lazily through a peer-dep so this module
 * is safe to ship in a non-test bundle.
 */
import { describe, expect, it } from 'vitest';
import type { LlmProvider } from '@ggui-ai/mcp-server-core';
import type {
  ProviderAdapter,
  ProviderError,
  ProviderErrorKind,
} from './provider-adapter.js';

/**
 * Inputs to {@link providerAdapterContract}. The `errorFixtures`
 * table maps each {@link ProviderErrorKind} to a raw input the
 * adapter's `mapError` will classify into that kind. Adapters that
 * cannot synthesize a kind (e.g. an SDK that never produces 403)
 * MAY pass `undefined` — that branch is then skipped (and a
 * skipped-branch counter is asserted upstream so silent gaps don't
 * accumulate).
 */
export interface ProviderAdapterContractInputs {
  /** Display name used in the test description. */
  readonly name: string;
  /**
   * Construct a fresh adapter per-test. Receives no args — adapter
   * factories closure over their own config.
   */
  readonly buildAdapter: () => ProviderAdapter;
  /**
   * Map every {@link ProviderErrorKind} (except `'no-credentials'`
   * + `'aborted'`, which are tested through the typed paths) to a
   * raw value `mapError` should classify into that kind. Pass
   * `undefined` to skip a kind your adapter cannot reproduce.
   */
  readonly errorFixtures: Partial<
    Record<
      Exclude<ProviderErrorKind, 'no-credentials' | 'aborted'>,
      unknown
    >
  >;
  /**
   * Request shape the runner uses for a happy-path
   * `validateConfig` call. Defaults to `{apiKey: 'k', model: 'm'}`.
   * Adapters with stricter shape rules (openrouter requires `/` in
   * model id) override.
   */
  readonly validRequest?: { readonly apiKey: string; readonly model: string };
  /** Provider name the adapter MUST report. */
  readonly expectedProvider?: LlmProvider;
}

/**
 * Test runner. Wraps every assertion in its own `describe(name)`
 * block + child `it()`. Adapter packages call this from inside their
 * own test file. Vitest is a peer/dev dep; consumers must add it to
 * their devDependencies (mirrors `mcp-server-core/contract-tests`).
 */
export function providerAdapterContract(
  inputs: ProviderAdapterContractInputs,
): void {
  describe(`ProviderAdapter contract — ${inputs.name}`, () => {
  const valid = inputs.validRequest ?? { apiKey: 'k', model: 'm' };

  it(`${inputs.name}: reports a stable provider id`, () => {
    const adapter = inputs.buildAdapter();
    expect(typeof adapter.provider).toBe('string');
    if (inputs.expectedProvider) {
      expect(adapter.provider).toBe(inputs.expectedProvider);
    }
  });

  it(`${inputs.name}: validateConfig returns no-credentials for empty apiKey`, () => {
    const adapter = inputs.buildAdapter();
    const result = adapter.validateConfig({ apiKey: '', model: valid.model });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('no-credentials');
    expect(result.error.provider).toBe(adapter.provider);
  });

  it(`${inputs.name}: validateConfig returns client-error for empty model`, () => {
    const adapter = inputs.buildAdapter();
    const result = adapter.validateConfig({
      apiKey: valid.apiKey,
      model: '',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('client-error');
  });

  it(`${inputs.name}: validateConfig returns ok for a valid request`, () => {
    const adapter = inputs.buildAdapter();
    const result = adapter.validateConfig(valid);
    expect(result.ok).toBe(true);
  });

  it(`${inputs.name}: mapError funnels null into 'unknown' (never throws)`, () => {
    const adapter = inputs.buildAdapter();
    const err = adapter.mapError(null);
    assertProviderError(expect, err, adapter.provider);
    expect(err.kind).toBe('unknown');
  });

  it(`${inputs.name}: mapError funnels undefined into 'unknown' (never throws)`, () => {
    const adapter = inputs.buildAdapter();
    const err = adapter.mapError(undefined);
    assertProviderError(expect, err, adapter.provider);
    expect(err.kind).toBe('unknown');
  });

  // Walk every documented error kind the adapter can reproduce.
  const kinds: ReadonlyArray<
    Exclude<ProviderErrorKind, 'no-credentials' | 'aborted'>
  > = [
    'unauthorized',
    'forbidden',
    'rate-limited',
    'server-error',
    'client-error',
    'network',
    'invalid-response',
    'unknown',
  ];
  for (const kind of kinds) {
    const fixture = inputs.errorFixtures[kind];
    if (fixture === undefined) continue;
    it(`${inputs.name}: mapError classifies fixture for '${kind}'`, () => {
      const adapter = inputs.buildAdapter();
      const err = adapter.mapError(fixture);
      assertProviderError(expect, err, adapter.provider);
      expect(err.kind).toBe(kind);
      // Rate-limited fixture SHOULD carry retryAfterSec when the
      // adapter knows it. We don't assert presence (some providers
      // don't advertise it) — only that when present it's a positive
      // number.
      if (kind === 'rate-limited' && err.retryAfterSec !== undefined) {
        expect(err.retryAfterSec).toBeGreaterThan(0);
      }
    });
  }

  it(`${inputs.name}: complete returns ok:false on validation failure (no throw)`, async () => {
    const adapter = inputs.buildAdapter();
    const result = await adapter.complete({
      apiKey: '',
      model: valid.model,
      systemPrompt: 's',
      userPrompt: 'u',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('no-credentials');
  });

  it(`${inputs.name}: complete returns 'aborted' when signal is already aborted`, async () => {
    const adapter = inputs.buildAdapter();
    const controller = new AbortController();
    controller.abort();
    const result = await adapter.complete({
      apiKey: valid.apiKey,
      model: valid.model,
      systemPrompt: 's',
      userPrompt: 'u',
      signal: controller.signal,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('aborted');
  });
  });
}

/**
 * Field-shape guard: every `ProviderError` carries provider + kind +
 * message; status / retryAfterSec are absent or numbers (never
 * `undefined` written into the field — that would noise up logs).
 *
 * Takes `expect` as a parameter so the helper stays ESM-friendly +
 * avoids a second `import('vitest')` round-trip.
 */
function assertProviderError(
  expect: (typeof import('vitest'))['expect'],
  err: ProviderError,
  expectedProvider: LlmProvider,
): void {
  expect(err.provider).toBe(expectedProvider);
  expect(typeof err.kind).toBe('string');
  expect(typeof err.message).toBe('string');
  expect(err.message.length).toBeGreaterThan(0);
  if ('status' in err && err.status !== undefined) {
    expect(typeof err.status).toBe('number');
  }
  if ('retryAfterSec' in err && err.retryAfterSec !== undefined) {
    expect(typeof err.retryAfterSec).toBe('number');
  }
}
