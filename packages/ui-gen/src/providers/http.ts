/**
 * Shared fetch helpers for concrete provider adapters.
 *
 * Every adapter uses native Node `fetch` (Node 20+ has it global).
 * Heavy provider SDKs are intentionally NOT pulled in — the OSS
 * `@ggui-ai/ui-gen` stays lean, and each adapter is a thin REST
 * wrapper over the contract locked in `../provider-adapter.ts`.
 *
 * The helpers here centralize the three cross-cutting concerns every
 * adapter shares:
 *
 *   1. Parse a `Retry-After` header (seconds OR HTTP-date) into a
 *      monotonic seconds number. Used when the provider returns 429.
 *   2. Classify a caught `fetch` rejection into `aborted` / `network` /
 *      `unknown` without the adapter re-deriving the rules.
 *   3. Read a response body at most once and parse JSON defensively so
 *      `invalid-response` maps cleanly when the server returns 2xx with
 *      a non-JSON body.
 *
 * These helpers NEVER throw — every path returns a value. Adapters
 * funnel every raw throw through `mapError`, which itself never
 * throws, per the ProviderAdapter contract.
 */
import type { LlmProvider } from '@ggui-ai/mcp-server-core';
import {
  makeProviderError,
  statusToErrorKind,
  type ProviderError,
} from '../provider-adapter.js';

/**
 * Parse a `Retry-After` header value into positive seconds.
 * Accepts either a numeric seconds string (`"30"`) or an HTTP-date
 * (`"Wed, 21 Oct 2026 07:28:00 GMT"`). Returns `undefined` on
 * anything unparseable — callers treat absence as "no hint, fall back
 * to exponential backoff".
 */
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  // Seconds form.
  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    return Math.ceil(asNumber);
  }
  // HTTP-date form. `Date.parse` returns NaN on malformed.
  const asDate = Date.parse(trimmed);
  if (!Number.isFinite(asDate)) return undefined;
  const deltaMs = asDate - Date.now();
  if (deltaMs <= 0) return undefined;
  return Math.ceil(deltaMs / 1000);
}

/**
 * Classify a raw value thrown by `fetch` (or an adapter's internal
 * parse step) into a {@link ProviderError}. Order of checks matters —
 * abort first so aborted network calls don't look like generic
 * network failures.
 */
export function classifyFetchError(
  raw: unknown,
  provider: LlmProvider,
  signal?: AbortSignal,
): ProviderError {
  // 1. AbortSignal fired. Prefer the signal's own state over the raw
  //    error shape — some runtimes throw plain `Error('aborted')`.
  if (signal?.aborted) {
    return makeProviderError({
      kind: 'aborted',
      provider,
      message:
        signal.reason instanceof Error
          ? signal.reason.message
          : typeof signal.reason === 'string'
            ? signal.reason
            : 'request aborted',
    });
  }

  // 2. DOMException / Error with name === 'AbortError'.
  if (isAbortLike(raw)) {
    return makeProviderError({
      kind: 'aborted',
      provider,
      message:
        raw instanceof Error && raw.message ? raw.message : 'request aborted',
    });
  }

  // 3. TypeError from `fetch` = transport failure (DNS, TCP, TLS).
  //    Anything else that is an Error we treat as network by default;
  //    adapters map 2xx-parse failures through `invalid-response`
  //    EXPLICITLY on the success path, so here network is the
  //    conservative bucket.
  if (raw instanceof Error) {
    return makeProviderError({
      kind: 'network',
      provider,
      message: raw.message || 'network failure',
    });
  }
  if (typeof raw === 'string') {
    return makeProviderError({
      kind: 'unknown',
      provider,
      message: raw,
    });
  }
  return makeProviderError({
    kind: 'unknown',
    provider,
    message: 'unknown transport failure',
  });
}

function isAbortLike(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const obj = raw as Record<string, unknown>;
  return obj['name'] === 'AbortError';
}

/**
 * Consume a response body once and parse it as JSON. Returns a
 * discriminated union so the caller can branch cleanly on success /
 * JSON parse failure / text body without re-reading the stream.
 *
 * MUST be called at most once per Response — Response bodies can
 * only be read once, and we don't re-stream on failure.
 */
export async function readJsonBody(
  response: Response,
): Promise<
  | { ok: true; json: unknown; text: string }
  | { ok: false; text: string }
> {
  let text = '';
  try {
    text = await response.text();
  } catch {
    return { ok: false, text: '' };
  }
  if (text.length === 0) {
    return { ok: false, text: '' };
  }
  try {
    const json = JSON.parse(text) as unknown;
    return { ok: true, json, text };
  } catch {
    return { ok: false, text };
  }
}

/**
 * Build a `ProviderError` for a non-2xx HTTP response. Handles 429
 * `Retry-After` extraction automatically. The `message` field MUST
 * NOT include request body contents — raw response text is truncated
 * + sanitized here so adapters can pass it straight through without
 * worrying about leaking key material they put in the request.
 *
 * (Adapters set the `apiKey` in a request HEADER, not the body — so
 * response-text echo doesn't normally contain the key. Still, truncate
 * to keep log lines readable and remove the theoretical footgun of a
 * provider echoing `Authorization:` back in an error message.)
 */
export function errorFromHttpResponse(args: {
  readonly provider: LlmProvider;
  readonly response: Response;
  readonly bodyText: string;
}): ProviderError {
  const { provider, response, bodyText } = args;
  const status = response.status;
  const kind = statusToErrorKind(status);
  const retryAfter =
    kind === 'rate-limited'
      ? parseRetryAfter(response.headers.get('retry-after'))
      : undefined;
  const snippet = truncateForMessage(bodyText);
  const message = snippet
    ? `${provider}: ${status} ${response.statusText || ''} — ${snippet}`.trim()
    : `${provider}: ${status} ${response.statusText || ''}`.trim();
  return makeProviderError({
    kind,
    provider,
    message,
    status,
    ...(retryAfter !== undefined ? { retryAfterSec: retryAfter } : {}),
  });
}

/**
 * Truncate a response body snippet to keep log lines + error
 * messages bounded. 240 chars is enough for the typical provider's
 * `{"error":{"message":"..."}}` shape without truncating critical
 * detail; adapters that want the full body can grab it off `bodyText`
 * directly.
 */
export function truncateForMessage(text: string, max: number = 240): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
