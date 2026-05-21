/**
 * Typed `fetch` wrapper for the api.ggui.ai REST endpoints (S2 + S3).
 *
 * Two layers:
 *
 *   1. Unauthenticated calls used by `ggui login` (`/v1/auth/device`,
 *      `/v1/auth/poll`, `/v1/auth/refresh`).
 *   2. Authenticated calls used by every other command — they take a
 *      `cli_at_*` access token and surface a 401 → callers either
 *      retry-with-refresh (handled by {@link withAuthRetry}) or
 *      bubble up "session expired".
 *
 * No retry / backoff loops here for transient network errors — let
 * the operator hit C-c and rerun. Only the 401-refresh-once flow is
 * automatic.
 */
import {
  loadAuthSession,
  saveAuthSession,
  type AuthSessionDocument,
} from './auth-store.js';

// ─────────────────────────────────────────────────────────────────────────
// Wire types — match the backend handlers exactly.
// ─────────────────────────────────────────────────────────────────────────

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
  session_id: string;
}

export interface MeResponse {
  userId: string;
  sessionId: string;
  clientName: string | null;
  accessExpiresAt: number;
}

export interface ApiKeySummary {
  id: string;
  apiKeyPrefix: string;
  name?: string;
  status: string;
  createdAt?: string;
  expiresAt?: string;
  lastUsedAt?: string;
}

export interface KeysListResponse {
  keys: ApiKeySummary[];
}

export interface KeysCreateResponse {
  apiKey: string;
  id: string;
  prefix: string;
  createdAt: string;
}

export interface ServerErrorBody {
  error: string;
  error_description?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'ApiError';
  }
}

async function parseError(res: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return new ApiError(res.status, 'http_error', `HTTP ${res.status}`);
  }
  const err = body as ServerErrorBody;
  return new ApiError(
    res.status,
    err.error ?? 'http_error',
    err.error_description ?? err.error ?? `HTTP ${res.status}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Unauthenticated calls (login flow).
// ─────────────────────────────────────────────────────────────────────────

export async function postAuthDevice(
  endpoint: string,
  clientName: string,
): Promise<DeviceCodeResponse> {
  const res = await fetch(`${endpoint}/v1/auth/device`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: clientName }),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as DeviceCodeResponse;
}

export async function postAuthPoll(
  endpoint: string,
  deviceCode: string,
): Promise<TokenResponse> {
  const res = await fetch(`${endpoint}/v1/auth/poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_code: deviceCode }),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as TokenResponse;
}

export async function postAuthRefresh(
  endpoint: string,
  refreshToken: string,
): Promise<TokenResponse> {
  const res = await fetch(`${endpoint}/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as TokenResponse;
}

// ─────────────────────────────────────────────────────────────────────────
// Authenticated calls — caller passes the access token.
// ─────────────────────────────────────────────────────────────────────────

interface AuthedFetchOptions {
  method: string;
  path: string;
  body?: unknown;
}

async function authedFetch(
  session: AuthSessionDocument,
  opts: AuthedFetchOptions,
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.accessToken}`,
  };
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  return fetch(`${session.endpoint}${opts.path}`, {
    method: opts.method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

/**
 * Run an authenticated fetch with one transparent refresh on 401.
 * On success the (possibly updated) session is returned alongside
 * the parsed response — callers persist via `saveAuthSession`.
 */
async function withAuthRetry<T>(
  call: (session: AuthSessionDocument) => Promise<Response>,
  parse: (res: Response) => Promise<T>,
): Promise<T> {
  let session = loadAuthSession();
  let res = await call(session);
  if (res.status === 401) {
    // Try refresh once.
    let tokens: TokenResponse;
    try {
      tokens = await postAuthRefresh(session.endpoint, session.refreshToken);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        throw new ApiError(
          401,
          'session_expired',
          'Session expired. Run `ggui login` again.',
        );
      }
      throw err;
    }
    const now = Math.floor(Date.now() / 1000);
    session = {
      ...session,
      accessToken: tokens.access_token,
      accessExpiresAt: now + tokens.expires_in,
      refreshToken: tokens.refresh_token,
      // refresh response carries token_type + session_id only — refresh
      // expiry stays the same (server-side refresh-token rotation isn't
      // implemented at v1). If the refresh-token call returned a new
      // refreshExpiresAt we'd update it here.
      writtenAt: new Date().toISOString(),
    };
    saveAuthSession(session);
    res = await call(session);
  }
  if (!res.ok) throw await parseError(res);
  return parse(res);
}

export async function getMe(): Promise<MeResponse> {
  return withAuthRetry(
    (s) => authedFetch(s, { method: 'GET', path: '/v1/me' }),
    (r) => r.json() as Promise<MeResponse>,
  );
}

export async function listKeys(): Promise<KeysListResponse> {
  return withAuthRetry(
    (s) => authedFetch(s, { method: 'GET', path: '/v1/keys' }),
    (r) => r.json() as Promise<KeysListResponse>,
  );
}

export async function createKey(args: {
  name?: string;
  expiresAt?: string;
}): Promise<KeysCreateResponse> {
  return withAuthRetry(
    (s) =>
      authedFetch(s, {
        method: 'POST',
        path: '/v1/keys',
        body: {
          ...(args.name ? { name: args.name } : {}),
          ...(args.expiresAt ? { expires_at: args.expiresAt } : {}),
        },
      }),
    (r) => r.json() as Promise<KeysCreateResponse>,
  );
}

export async function revokeKey(id: string): Promise<void> {
  await withAuthRetry(
    (s) =>
      authedFetch(s, {
        method: 'DELETE',
        path: `/v1/keys/${encodeURIComponent(id)}`,
      }),
    async () => undefined,
  );
}
