/**
 * OAuth login routes.
 *
 * Two endpoints per provider:
 *
 *   - `GET /ggui/oauth-login/:providerId/start?next=/settings`
 *     Mints PKCE verifier + S256 challenge, signs a state token
 *     binding `${random}|${providerId}|${nextPath}|${expiresAt}` with
 *     HMAC-SHA256, stashes the verifier in a HttpOnly short-lived
 *     `ggui_oauth_pkce` cookie, redirects 302 to the provider's
 *     authorize URL.
 *
 *   - `GET /ggui/oauth-login/:providerId/callback?code=&state=&error=`
 *     Validates state HMAC + freshness + provider match, reads the
 *     PKCE verifier off the cookie, exchanges the code for the user's
 *     `providerSubject`, mints a `ggui_user_*` bearer, registers it
 *     with the `AuthAdapter`, sets the `ggui_user_session` cookie
 *     atomically, clears the PKCE cookie, redirects 302 to the
 *     state-bound `nextPath`.
 *
 * Identity model: callbacks mint
 * `{ kind: 'user', userId: '${providerId}:${providerSubject}', roles: [] }`.
 * Email is informational metadata only — never load-bearing for the
 * identity. See `oauth-login-types.ts` for the locked seam.
 *
 * **Security boundary**: PKCE verifier MUST stay server-bound — the
 * state token is plaintext to the user (only HMAC-signed), so the
 * verifier lives in a separate HttpOnly cookie. State HMAC binds
 * providerId so a state from provider A can't be replayed at provider
 * B. `next` param is validated as same-origin relative path; otherwise
 * defaults to `/settings` (open-redirect rejection).
 */
import type { Express, Request, Response } from 'express';
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type {
  AuditEntry,
  AuditSink,
  AuthAdapter,
} from '@ggui-ai/mcp-server-core';
import { formatUserSessionCookieHeader } from './user-session-auth.js';
import {
  composeOAuthUserId,
  type OAuthLoginProvider,
} from './oauth-login-types.js';
import type { Logger } from './logger.js';

export const DEFAULT_OAUTH_START_PATH = '/ggui/oauth-login/:providerId/start';
export const DEFAULT_OAUTH_CALLBACK_PATH =
  '/ggui/oauth-login/:providerId/callback';
/**
 * Public route exposing the currently-configured provider list as
 * `[{providerId, displayName}]`. Anonymous-readable on purpose — the
 * `/login` page fetches this to render only buttons for providers
 * the operator has actually wired up. Returns `[]` when no provider
 * is enabled or credentialed; never leaks `clientSecret`.
 */
export const DEFAULT_OAUTH_PROVIDERS_LIST_PATH =
  '/ggui/oauth-login/providers';
export const OAUTH_PKCE_COOKIE_NAME = 'ggui_oauth_pkce';
const STATE_TTL_MS = 10 * 60 * 1000;
const PKCE_COOKIE_TTL_SEC = 600;
const DEFAULT_NEXT_PATH = '/settings';

export interface OAuthLoginRoutesOptions {
  /**
   * Live provider list. May be a static array (snapshot at mount
   * time — operator restart to apply changes) OR a getter the routes
   * call per request (dynamic — admin paste-then-click works without
   * restart). The CLI passes a getter wired through the
   * OAuthProvidersStore so credentials saved at /admin/oauth-providers
   * are picked up on the next /start request.
   */
  readonly providers:
    | ReadonlyArray<OAuthLoginProvider>
    | (() => ReadonlyArray<OAuthLoginProvider> | Promise<ReadonlyArray<OAuthLoginProvider>>);
  readonly auth: AuthAdapter;
  readonly logger: Logger;
  /** HMAC secret for state-token signing. ≥32 bytes recommended. */
  readonly stateSecret: string;
  /** Public base URL the server is reachable at; used to compose `redirect_uri`. */
  readonly publicBaseUrl: string;
  /** Optional audit sink — fires `auth.oauth.start/.success/.failure`. */
  readonly auditSink?: AuditSink;
  /** Adds `Secure` to cookies. */
  readonly secure?: boolean;
  /** User-session cookie TTL (seconds). */
  readonly ttlSec?: number;
  /** Override paths (mostly for tests). */
  readonly startPath?: string;
  readonly callbackPath?: string;
  readonly providersListPath?: string;
}

/** Mount the OAuth login routes onto an Express app. */
export function mountOAuthLoginRoutes(
  app: Express,
  opts: OAuthLoginRoutesOptions,
): void {
  const startPath = opts.startPath ?? DEFAULT_OAUTH_START_PATH;
  const callbackPath = opts.callbackPath ?? DEFAULT_OAUTH_CALLBACK_PATH;
  const providersListPath =
    opts.providersListPath ?? DEFAULT_OAUTH_PROVIDERS_LIST_PATH;
  const auditSink = opts.auditSink;

  // Resolve providers per request when a getter was passed; snapshot
  // once when a static array was passed. Both paths produce a Map
  // keyed on providerId.
  const resolveProvidersById = async (): Promise<Map<string, OAuthLoginProvider>> => {
    const list =
      typeof opts.providers === 'function' ? await opts.providers() : opts.providers;
    const map = new Map<string, OAuthLoginProvider>();
    for (const p of list) map.set(p.providerId, p);
    return map;
  };

  const emitAudit = async (
    entry: Omit<AuditEntry, 'at'>,
    auditLogger: Logger,
  ): Promise<void> => {
    if (!auditSink) return;
    try {
      await auditSink.record({ at: Date.now(), ...entry });
    } catch (err) {
      auditLogger.warn('audit_emit_failed', {
        action: entry.action,
        error: String(err),
      });
    }
  };

  const composeRedirectUri = (providerId: string): string =>
    `${trimTrailingSlash(opts.publicBaseUrl)}/ggui/oauth-login/${providerId}/callback`;

  // --- GET /ggui/oauth-login/providers ---
  // Public-readable list of currently configured + enabled providers.
  // Returns ONLY `{providerId, displayName}` per row — never
  // `clientId` / `clientSecret` (those stay server-side). The /login
  // page fetches this so it can render only buttons backed by a
  // real provider; an unconfigured slot returns 404 from /start
  // anyway, but rendering a dead button is bad UX.
  //
  // No auth required — provider IDs ARE public anyway (they're in
  // every authorize URL the user sees during login). Withholding the
  // list buys nothing security-wise; serving it makes the empty
  // state honest.
  app.get(providersListPath, async (_req: Request, res: Response) => {
    const reqLogger = opts.logger.child({
      route: 'GET ' + providersListPath,
    });
    try {
      const providersById = await resolveProvidersById();
      const rows = Array.from(providersById.values()).map((p) => ({
        providerId: p.providerId,
        displayName: p.displayName,
      }));
      res.status(200).json({ providers: rows });
    } catch (err) {
      reqLogger.warn('oauth_providers_list_failed', { error: String(err) });
      res.status(500).json({
        error: {
          code: 'providers_list_failed',
          message: 'Failed to read OAuth provider list.',
        },
      });
    }
  });

  // --- GET /ggui/oauth-login/:providerId/start ---
  app.get(startPath, async (req: Request, res: Response) => {
    const providerId = req.params['providerId'];
    const reqLogger = opts.logger.child({
      route: 'GET ' + startPath,
      providerId: providerId ?? '<missing>',
    });
    const providersById = await resolveProvidersById();
    if (!providerId || !providersById.has(providerId)) {
      reqLogger.warn('oauth_start_unknown_provider', {});
      res.status(404).json({
        error: {
          code: 'unknown_provider',
          message: 'No OAuth provider registered for this providerId.',
        },
      });
      return;
    }
    const provider = providersById.get(providerId)!;
    const nextRaw = typeof req.query['next'] === 'string'
      ? req.query['next']
      : undefined;
    const nextPath = sanitizeNextPath(nextRaw) ?? DEFAULT_NEXT_PATH;

    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const expiresAt = Date.now() + STATE_TTL_MS;
    const state = signState(opts.stateSecret, {
      random: base64url(randomBytes(16)),
      providerId,
      nextPath,
      expiresAt,
    });

    const redirectUri = composeRedirectUri(providerId);
    const authorizeUrl = provider.authorizeUrl({
      state,
      codeChallenge: challenge,
      redirectUri,
    });

    res.setHeader(
      'Set-Cookie',
      formatPkceCookieHeader({
        verifier,
        secure: opts.secure ?? false,
      }),
    );
    reqLogger.info('oauth_start', { nextPath });
    await emitAudit(
      {
        action: 'auth.oauth.start',
        actor: { kind: 'anonymous' },
        resource: { kind: 'oauth-provider', id: providerId },
      },
      reqLogger,
    );
    res.redirect(302, authorizeUrl);
  });

  // --- GET /ggui/oauth-login/:providerId/callback ---
  app.get(callbackPath, async (req: Request, res: Response) => {
    const providerId = req.params['providerId'];
    const reqLogger = opts.logger.child({
      route: 'GET ' + callbackPath,
      providerId: providerId ?? '<missing>',
    });
    const errorParam = typeof req.query['error'] === 'string'
      ? req.query['error']
      : undefined;
    const codeParam = typeof req.query['code'] === 'string'
      ? req.query['code']
      : undefined;
    const stateParam = typeof req.query['state'] === 'string'
      ? req.query['state']
      : undefined;

    // Provider returned an error before issuing a code (user denied,
    // provider misconfig, etc.). Surface it as 400 + audit failure.
    if (errorParam) {
      reqLogger.warn('oauth_callback_provider_error', { error: errorParam });
      await emitAudit(
        {
          action: 'auth.oauth.failure',
          actor: { kind: 'anonymous' },
          resource: providerId
            ? { kind: 'oauth-provider', id: providerId }
            : undefined,
          metadata: { reason: 'provider_error', detail: errorParam },
        },
        reqLogger,
      );
      res.status(400).json({
        error: {
          code: 'oauth_provider_error',
          message: 'OAuth provider returned an error.',
          detail: errorParam,
        },
      });
      return;
    }

    const providersById = await resolveProvidersById();
    if (!providerId || !providersById.has(providerId)) {
      reqLogger.warn('oauth_callback_unknown_provider', {});
      res.status(404).json({
        error: {
          code: 'unknown_provider',
          message: 'No OAuth provider registered for this providerId.',
        },
      });
      return;
    }
    const provider = providersById.get(providerId)!;

    if (!stateParam || !codeParam) {
      reqLogger.warn('oauth_callback_missing_params', {
        hasCode: Boolean(codeParam),
        hasState: Boolean(stateParam),
      });
      await emitAudit(
        {
          action: 'auth.oauth.failure',
          actor: { kind: 'anonymous' },
          resource: { kind: 'oauth-provider', id: providerId },
          metadata: { reason: 'missing_params' },
        },
        reqLogger,
      );
      res.status(400).json({
        error: {
          code: 'oauth_missing_params',
          message: 'Callback missing required `code` and/or `state` query params.',
        },
      });
      return;
    }

    const stateValidation = verifyState(opts.stateSecret, stateParam);
    if (!stateValidation.ok) {
      reqLogger.warn('oauth_state_mismatch', { reason: stateValidation.reason });
      await emitAudit(
        {
          action: 'auth.oauth.failure',
          actor: { kind: 'anonymous' },
          resource: { kind: 'oauth-provider', id: providerId },
          metadata: { reason: 'state_mismatch', detail: stateValidation.reason },
        },
        reqLogger,
      );
      res.status(403).json({
        error: {
          code: 'oauth_state_mismatch',
          message: 'OAuth state token is invalid, expired, or tampered.',
        },
      });
      return;
    }
    const payload = stateValidation.payload;

    // Defense in depth: state must be specific to the URL providerId.
    if (payload.providerId !== providerId) {
      reqLogger.warn('oauth_state_provider_mismatch', {
        statePid: payload.providerId,
      });
      await emitAudit(
        {
          action: 'auth.oauth.failure',
          actor: { kind: 'anonymous' },
          resource: { kind: 'oauth-provider', id: providerId },
          metadata: { reason: 'provider_mismatch' },
        },
        reqLogger,
      );
      res.status(403).json({
        error: {
          code: 'oauth_state_mismatch',
          message: 'State token does not match URL provider.',
        },
      });
      return;
    }

    const verifier = readPkceCookie(req);
    if (!verifier) {
      reqLogger.warn('oauth_pkce_missing', {});
      await emitAudit(
        {
          action: 'auth.oauth.failure',
          actor: { kind: 'anonymous' },
          resource: { kind: 'oauth-provider', id: providerId },
          metadata: { reason: 'pkce_missing' },
        },
        reqLogger,
      );
      res.status(403).json({
        error: {
          code: 'oauth_pkce_missing',
          message:
            'PKCE verifier cookie is missing — start the flow at /ggui/oauth-login/:providerId/start.',
        },
      });
      return;
    }

    const redirectUri = composeRedirectUri(providerId);

    let exchange;
    try {
      exchange = await provider.exchangeCode({
        code: codeParam,
        codeVerifier: verifier,
        redirectUri,
      });
    } catch (err) {
      reqLogger.warn('oauth_exchange_failed', { error: String(err) });
      await emitAudit(
        {
          action: 'auth.oauth.failure',
          actor: { kind: 'anonymous' },
          resource: { kind: 'oauth-provider', id: providerId },
          metadata: { reason: 'exchange_failed' },
        },
        reqLogger,
      );
      res.status(400).json({
        error: {
          code: 'oauth_exchange_failed',
          message: 'OAuth provider rejected the code exchange.',
        },
      });
      return;
    }

    if (!opts.auth.registerToken) {
      reqLogger.warn('oauth_register_token_unsupported', {});
      res.status(501).json({
        error: {
          code: 'not_implemented',
          message:
            'AuthAdapter has no registerToken — OAuth login requires a token-registering adapter.',
        },
      });
      return;
    }

    const userId = composeOAuthUserId({
      providerId,
      providerSubject: exchange.providerSubject,
    });
    const bearer = `ggui_user_${base64url(randomBytes(16))}`;
    const metadata: Record<string, string> = {
      providerId,
      providerSubject: exchange.providerSubject,
    };
    if (exchange.email) metadata['email'] = exchange.email;
    if (exchange.displayName) metadata['displayName'] = exchange.displayName;
    opts.auth.registerToken(bearer, {
      identity: { kind: 'user', userId, roles: [] },
      source: 'oauth',
      metadata,
    });

    const sessionCookie = formatUserSessionCookieHeader({
      bearer,
      ...(opts.ttlSec !== undefined ? { ttlSec: opts.ttlSec } : {}),
      ...(opts.secure !== undefined ? { secure: opts.secure } : {}),
    });
    const clearPkceCookie = formatClearPkceCookieHeader({
      secure: opts.secure ?? false,
    });
    res.setHeader('Set-Cookie', [sessionCookie, clearPkceCookie]);

    reqLogger.info('oauth_callback_success', {
      userId,
      hasEmail: Boolean(exchange.email),
    });
    const auditMetadata: Record<string, string> = { providerId };
    if (exchange.email) auditMetadata['email'] = exchange.email;
    await emitAudit(
      {
        action: 'auth.oauth.success',
        actor: { kind: 'user', id: userId },
        resource: { kind: 'oauth-provider', id: providerId },
        metadata: auditMetadata,
      },
      reqLogger,
    );
    res.redirect(302, payload.nextPath);
  });
}

interface StatePayload {
  readonly random: string;
  readonly providerId: string;
  readonly nextPath: string;
  readonly expiresAt: number;
}

function signState(secret: string, payload: StatePayload): string {
  const json = JSON.stringify(payload);
  const payloadB64 = base64url(Buffer.from(json, 'utf8'));
  const sig = createHmac('sha256', secret).update(payloadB64).digest();
  return `${payloadB64}.${base64url(sig)}`;
}

type StateVerification =
  | { readonly ok: true; readonly payload: StatePayload }
  | { readonly ok: false; readonly reason: string };

function verifyState(secret: string, token: string): StateVerification {
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) return { ok: false, reason: 'malformed' };
  const expectedSig = base64url(
    createHmac('sha256', secret).update(payloadB64).digest(),
  );
  if (expectedSig.length !== sigB64.length) {
    return { ok: false, reason: 'sig_length' };
  }
  const macMatch = timingSafeEqual(
    Buffer.from(expectedSig, 'utf8'),
    Buffer.from(sigB64, 'utf8'),
  );
  if (!macMatch) return { ok: false, reason: 'sig_mismatch' };

  let parsed: unknown;
  try {
    const json = base64urlDecode(payloadB64).toString('utf8');
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'payload_decode' };
  }
  if (!isStatePayload(parsed)) return { ok: false, reason: 'payload_shape' };
  if (parsed.expiresAt < Date.now()) return { ok: false, reason: 'expired' };
  return { ok: true, payload: parsed };
}

function isStatePayload(value: unknown): value is StatePayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<StatePayload>;
  return (
    typeof v.random === 'string' &&
    typeof v.providerId === 'string' &&
    typeof v.nextPath === 'string' &&
    typeof v.expiresAt === 'number'
  );
}

/**
 * Validate `next` query param: must be a relative path (`/foo`),
 * not a protocol-relative URL (`//evil.com`), backslash-prefixed
 * (`\evil.com`), or absolute URL. Returns `null` when invalid so the
 * caller falls back to the default. Open-redirect defense.
 */
function sanitizeNextPath(raw: string | undefined): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (!raw.startsWith('/')) return null;
  if (raw.startsWith('//')) return null;
  if (raw.startsWith('/\\')) return null;
  // Backslashes anywhere — IE and some legacy parsers treat `\` as `/`.
  if (raw.includes('\\')) return null;
  return raw;
}

function formatPkceCookieHeader(input: {
  readonly verifier: string;
  readonly secure: boolean;
}): string {
  const attrs: string[] = [
    `${OAUTH_PKCE_COOKIE_NAME}=${encodeURIComponent(input.verifier)}`,
    'Path=/',
    `Max-Age=${PKCE_COOKIE_TTL_SEC}`,
    'SameSite=Lax',
    'HttpOnly',
  ];
  if (input.secure) attrs.push('Secure');
  return attrs.join('; ');
}

function formatClearPkceCookieHeader(input: {
  readonly secure: boolean;
}): string {
  const attrs: string[] = [
    `${OAUTH_PKCE_COOKIE_NAME}=`,
    'Path=/',
    'Max-Age=0',
    'SameSite=Lax',
    'HttpOnly',
  ];
  if (input.secure) attrs.push('Secure');
  return attrs.join('; ');
}

function readPkceCookie(req: Request): string | null {
  const raw = req.headers['cookie'];
  if (typeof raw !== 'string') return null;
  for (const piece of raw.split(';')) {
    const trimmed = piece.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) !== OAUTH_PKCE_COOKIE_NAME) continue;
    const value = trimmed.slice(eq + 1);
    if (!value) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
}

function trimTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function base64url(bytes: Buffer): string {
  return bytes
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64urlDecode(input: string): Buffer {
  const padded = input + '='.repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
