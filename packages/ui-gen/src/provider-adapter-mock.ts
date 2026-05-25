/**
 * Reference / fixture {@link ProviderAdapter} for tests.
 *
 * Composes the helpers from `./provider-adapter.ts` so it satisfies
 * the {@link providerAdapterContract} test runner unmodified —
 * proving the contract is satisfiable AND giving consumers (concrete
 * provider adapters, downstream generator wiring) a reference to
 * compare against.
 *
 * Behavior is fully deterministic and configurable:
 *
 *   - Pre-flight: relies on {@link defaultValidateConfig}; no extra
 *     rules. (Concrete adapters compose extra rules on top.)
 *   - `complete`:
 *       - Returns `{ok: true, response: {text: scriptedResponse, …}}`
 *         when no scripted error is queued.
 *       - When a scripted error IS queued (via `enqueueError`), it
 *         drains the queue, funnels through `mapError`, and returns
 *         `{ok: false, error}`.
 *       - Forwards `request.signal`: if aborted before the
 *         microtask resolves, returns `kind:'aborted'`. Mirrors the
 *         contract requirement that adapters MUST honor abort.
 *   - `mapError`: classifies an injected pseudo-error:
 *       - `{__status: 401|403|429|500|400}` → maps via `statusToErrorKind`
 *       - `{__network: true}`                → 'network'
 *       - `{__abort: true}`                  → 'aborted'
 *       - `{__invalidResponse: true}`        → 'invalid-response'
 *       - `Error`                            → 'unknown' (message preserved)
 *       - anything else                      → 'unknown'
 */
import type { LlmProvider } from '@ggui-ai/mcp-server-core';
import {
  defaultValidateConfig,
  makeProviderError,
  statusToErrorKind,
  type ProviderAdapter,
  type ProviderError,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderResult,
  type ProviderValidation,
} from './provider-adapter.js';

export interface MockProviderAdapterOptions {
  readonly provider?: LlmProvider;
  /** Default text returned when no error is queued. */
  readonly scriptedResponse?: string;
  /** Default usage. Adapters that don't get usage from the provider
   *  return zeros; this honors the contract's "synthesize 0 if the
   *  provider didn't report it" rule. */
  readonly scriptedUsage?: ProviderResponse['usage'];
}

/**
 * Pseudo-error shapes the mock adapter knows how to classify. Tests
 * pass these into `enqueueError` to walk every `ProviderErrorKind`
 * branch through the same `mapError` path a real adapter would use.
 */
export type MockRawError =
  | { readonly __status: number; readonly retryAfterSec?: number; readonly message?: string }
  | { readonly __network: true; readonly message?: string }
  | { readonly __abort: true; readonly message?: string }
  | { readonly __invalidResponse: true; readonly message?: string }
  | Error
  | string
  | undefined;

export interface MockProviderAdapter extends ProviderAdapter {
  /** Queue an error to surface on the next `complete` call. FIFO. */
  enqueueError(raw: MockRawError): void;
  /** Inspection: how many `complete` calls were made. */
  readonly callCount: () => number;
}

export function createMockProviderAdapter(
  opts: MockProviderAdapterOptions = {},
): MockProviderAdapter {
  const provider: LlmProvider = opts.provider ?? 'anthropic';
  const scriptedResponse = opts.scriptedResponse ?? 'mock-response-text';
  const scriptedUsage: ProviderResponse['usage'] = opts.scriptedUsage ?? {
    inputTokens: 1,
    outputTokens: 1,
  };
  const errorQueue: MockRawError[] = [];
  let callCount = 0;

  function mapError(raw: unknown): ProviderError {
    if (raw === null || raw === undefined) {
      return makeProviderError({
        kind: 'unknown',
        provider,
        message: 'unknown error (null / undefined)',
      });
    }
    if (typeof raw === 'string') {
      return makeProviderError({
        kind: 'unknown',
        provider,
        message: raw,
      });
    }
    if (typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      if (typeof obj['__status'] === 'number') {
        const status = obj['__status'];
        const kind = statusToErrorKind(status);
        const message =
          typeof obj['message'] === 'string'
            ? obj['message']
            : `provider returned ${status}`;
        const retry =
          kind === 'rate-limited' && typeof obj['retryAfterSec'] === 'number'
            ? (obj['retryAfterSec'] as number)
            : undefined;
        return makeProviderError({
          kind,
          provider,
          message,
          status,
          ...(retry !== undefined ? { retryAfterSec: retry } : {}),
        });
      }
      if (obj['__network'] === true) {
        return makeProviderError({
          kind: 'network',
          provider,
          message:
            typeof obj['message'] === 'string'
              ? (obj['message'] as string)
              : 'network failure',
        });
      }
      if (obj['__abort'] === true) {
        return makeProviderError({
          kind: 'aborted',
          provider,
          message:
            typeof obj['message'] === 'string'
              ? (obj['message'] as string)
              : 'request aborted',
        });
      }
      if (obj['__invalidResponse'] === true) {
        return makeProviderError({
          kind: 'invalid-response',
          provider,
          message:
            typeof obj['message'] === 'string'
              ? (obj['message'] as string)
              : 'provider returned an unparseable body',
        });
      }
      if (raw instanceof Error) {
        return makeProviderError({
          kind: 'unknown',
          provider,
          message: raw.message,
        });
      }
    }
    return makeProviderError({
      kind: 'unknown',
      provider,
      message: 'unknown error',
    });
  }

  return {
    provider,
    validateConfig(
      request: Pick<ProviderRequest, 'apiKey' | 'route'>,
    ): ProviderValidation {
      return defaultValidateConfig(provider, request);
    },
    async complete(request: ProviderRequest): Promise<ProviderResult> {
      callCount += 1;

      // Pre-flight first. Real adapters validate before paying for a
      // network call; the mock mirrors that.
      const pre = defaultValidateConfig(provider, request);
      if (!pre.ok) return { ok: false, error: pre.error };

      // Honor abort BEFORE consuming the queue so an already-aborted
      // signal short-circuits without burning a scripted error.
      if (request.signal?.aborted) {
        return {
          ok: false,
          error: makeProviderError({
            kind: 'aborted',
            provider,
            message: 'request aborted before send',
          }),
        };
      }

      // Yield once so the test can fire `controller.abort()` and
      // observe the abort path. Real provider SDKs await an HTTP
      // round-trip — this `Promise.resolve()` is the cheapest
      // structural stand-in.
      await Promise.resolve();
      if (request.signal?.aborted) {
        return { ok: false, error: mapError({ __abort: true }) };
      }

      if (errorQueue.length > 0) {
        const raw = errorQueue.shift();
        return { ok: false, error: mapError(raw) };
      }

      return {
        ok: true,
        response: {
          text: scriptedResponse,
          usage: scriptedUsage,
          finishReason: 'stop',
        },
      };
    },
    mapError,
    enqueueError(raw: MockRawError): void {
      errorQueue.push(raw);
    },
    callCount: () => callCount,
  };
}
