/**
 * Thin fetch helpers for the self-hosted `@ggui-ai/mcp-server`
 * persistent-thread HTTP surface
 * (`packages/mcp-server/src/thread-transport.ts`).
 *
 * Deliberately small. No retries, no queuing, no offline handling —
 * the SDK's outbox (`@ggui-ai/react-native/chat-thread/outbox.ts`)
 * owns those concerns at a higher layer. This file only translates
 * HTTP response shapes into typed results + errors.
 */
import { ThreadTransportError } from './errors.js';

export interface TransportConfig {
  /** Base URL of the paired server — e.g. `http://192.168.1.5:4567`.
   *  No trailing slash; the caller is responsible for normalizing it. */
  readonly baseUrl: string;
  /** Pairing bearer token minted via the server's `/pair` route.
   *  Required: self-hosted thread routes reject unauthenticated
   *  requests. */
  readonly pairingToken: string;
  /** Override fetch for tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
}

const DEFAULT_THREADS_PATH = '/threads';

function authHeaders(cfg: TransportConfig): Record<string, string> {
  return {
    authorization: `Bearer ${cfg.pairingToken}`,
    accept: 'application/json',
    'content-type': 'application/json',
  };
}

function resolveFetch(cfg: TransportConfig): typeof fetch {
  return cfg.fetch ?? globalThis.fetch;
}

/**
 * Send an HTTP request and parse the response.
 *
 * Non-2xx responses are mapped to {@link ThreadTransportError} —
 * reading the server's `{error: {code, message, details?}}` envelope
 * when present, falling back to a generic shape when the body isn't
 * JSON (e.g. an upstream proxy's HTML error page).
 */
export interface HttpRequestInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
}

export async function httpRequest<T>(
  cfg: TransportConfig,
  path: string,
  init: HttpRequestInit = {},
): Promise<T> {
  const fetchFn = resolveFetch(cfg);
  let resp: Response;
  try {
    resp = await fetchFn(cfg.baseUrl + path, {
      method: init.method ?? 'GET',
      headers: { ...authHeaders(cfg), ...(init.headers ?? {}) },
      body:
        init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch (err) {
    throw new ThreadTransportError({
      message:
        'Self-hosted server unreachable: ' +
        (err instanceof Error ? err.message : String(err)),
      status: 0,
      code: 'network',
    });
  }

  const text = await resp.text();
  const maybeJson = text.length > 0 ? tryJson(text) : null;

  if (!resp.ok) {
    const envelope = extractErrorEnvelope(maybeJson);
    throw new ThreadTransportError({
      message:
        envelope?.message ??
        `Self-hosted thread request failed (${resp.status})`,
      status: resp.status,
      ...(envelope?.code ? { code: envelope.code } : {}),
      details: envelope?.details ?? maybeJson ?? text,
    });
  }

  // 204 / empty body paths — callers that expect `void` should type
  // `T` as `void` or `null` and ignore the value.
  return (maybeJson ?? (null as unknown)) as T;
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function extractErrorEnvelope(
  body: unknown,
): { message?: string; code?: string; details?: unknown } | null {
  if (typeof body !== 'object' || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return null;
  const e = error as Record<string, unknown>;
  const message = typeof e['message'] === 'string' ? e['message'] : undefined;
  const code = typeof e['code'] === 'string' ? e['code'] : undefined;
  const details = e['details'];
  const out: { message?: string; code?: string; details?: unknown } = {};
  if (message !== undefined) out.message = message;
  if (code !== undefined) out.code = code;
  if (details !== undefined) out.details = details;
  return out;
}

/**
 * Resolve the threads prefix. Kept factored so a future change can
 * accept a `threadsPath` override without plumbing it through every
 * call site.
 */
export function threadsPath(): string {
  return DEFAULT_THREADS_PATH;
}
