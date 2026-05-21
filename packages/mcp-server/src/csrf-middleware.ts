/**
 * CSRF middleware.
 *
 * Double-submit token pattern: token = `${randomB64url}.${hmacB64url}`,
 * HMAC-SHA256 over `${random}|${sessionBearer ?? ''}` with the
 * server-provided secret. Binding the HMAC to the current session
 * bearer prevents an anonymous-session token from being replayed
 * after the user logs in (post-login the cookie value differs, so
 * the recomputed HMAC won't match).
 *
 * The middleware skips:
 *
 *   - Safe HTTP methods (GET / HEAD / OPTIONS).
 *   - Operator-configured `skipPaths` (default: `/pair`,
 *     `/ggui/email-login/start`) — pre-auth endpoints that exist
 *     BEFORE the user has a session.
 *   - Programmatic Bearer requests with no session cookie. CSRF is a
 *     browser-context defense; the claude.ai connector posts pre-auth
 *     bearers without a same-origin cookie context.
 *
 * On every GET response that has a session cookie, the middleware
 * also sets `X-Ggui-CSRF-Token` so SPA bootstrap reads the latest
 * token straight off the response without an extra round-trip.
 * Anonymous GETs get a token bound to empty-bearer for pre-auth
 * POSTs (e.g. magic-link start).
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readUserSessionCookie } from './user-session-auth.js';
import type { Logger } from './logger.js';

export const CSRF_HEADER_NAME = 'X-Ggui-CSRF';
export const CSRF_RESPONSE_HEADER_NAME = 'X-Ggui-CSRF-Token';
export const DEFAULT_CSRF_TOKEN_PATH = '/ggui/csrf-token';
// Anonymous flow-starters — no authenticated-state mutation, so CSRF
// adds no protection. Same threat model as `/pair` (rate-limited,
// idempotent, the magic link goes to the typed email not the
// attacker). Verify is a GET and auto-skipped via SAFE_METHODS.
const DEFAULT_SKIP_PATHS: ReadonlyArray<string> = [
  '/pair',
  '/ggui/email-login/start',
];
const RANDOM_BYTES = 16;
/** Header-side TTL hint (5 min). The server doesn't cache tokens; the
 *  HMAC itself binds validity to the current session bearer. */
const TOKEN_LIFETIME_MS = 5 * 60 * 1000;

export interface CsrfMiddlewareOptions {
  readonly secret: string;
  readonly logger: Logger;
  readonly skipPaths?: ReadonlyArray<string>;
}

export interface MintCsrfTokenInput {
  readonly sessionBearer: string | null;
  readonly secret: string;
}

function base64url(bytes: Buffer): string {
  return bytes
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function computeHmac(random: string, sessionBearer: string | null, secret: string): string {
  const mac = createHmac('sha256', secret)
    .update(`${random}|${sessionBearer ?? ''}`)
    .digest();
  return base64url(mac);
}

/** Mint a fresh CSRF token bound to `sessionBearer`. Format:
 *  `${randomBase64url}.${hmacBase64url}`. */
export function mintCsrfToken(input: MintCsrfTokenInput): string {
  const random = base64url(randomBytes(RANDOM_BYTES));
  const sig = computeHmac(random, input.sessionBearer, input.secret);
  return `${random}.${sig}`;
}

function validateCsrfToken(
  token: string,
  sessionBearer: string | null,
  secret: string,
): boolean {
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [random, sig] = parts;
  if (!random || !sig) return false;
  const expected = computeHmac(random, sessionBearer, secret);
  // timingSafeEqual requires equal-length buffers; cheap length check
  // first to avoid throwing on malformed input.
  if (expected.length !== sig.length) return false;
  return timingSafeEqual(
    Buffer.from(expected, 'utf8'),
    Buffer.from(sig, 'utf8'),
  );
}

function isSafeMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

function pathMatches(
  path: string,
  skipPaths: ReadonlyArray<string>,
): boolean {
  for (const skip of skipPaths) {
    if (path === skip) return true;
  }
  return false;
}

/** Express middleware: enforces CSRF on state-changing requests + sets
 *  `X-Ggui-CSRF-Token` on safe responses. */
export function createCsrfMiddleware(opts: CsrfMiddlewareOptions): RequestHandler {
  const skipPaths = opts.skipPaths ?? DEFAULT_SKIP_PATHS;
  const reqLogger = opts.logger.child({ middleware: 'csrf' });
  return (req: Request, res: Response, next) => {
    const sessionBearer = readUserSessionCookie(req);
    // On safe-method responses, set the response header so SPAs read
    // the freshly-minted token without an extra round-trip.
    if (isSafeMethod(req.method)) {
      const token = mintCsrfToken({ sessionBearer, secret: opts.secret });
      res.setHeader(CSRF_RESPONSE_HEADER_NAME, token);
      next();
      return;
    }

    if (pathMatches(req.path, skipPaths)) {
      next();
      return;
    }

    // CSRF defends ONLY browser-cookie sessions. If there's no
    // user-session cookie on the request, the auth surface is one
    // of: (a) programmatic Bearer (claude.ai connector) — no
    // cross-origin cookie to ride; (b) fully unauthenticated — the
    // downstream auth gate will 401. Skip CSRF in both cases so
    // CSRF doesn't masquerade as the auth gate (which produces
    // misleading 403s on 401-deserving requests).
    if (sessionBearer === null) {
      // No cookie: cookieAuthMiddleware may have synthesized
      // `Authorization: Bearer <cookie>` upstream, but we read the
      // cookie directly above so the synthesis doesn't confuse the
      // skip rule. Bearer-without-cookie programmatic requests
      // (claude.ai connector) and fully unauthenticated requests
      // both fall through here.
      next();
      return;
    }

    const headerValueRaw = req.headers[CSRF_HEADER_NAME.toLowerCase()];
    const headerValue = Array.isArray(headerValueRaw)
      ? headerValueRaw[0]
      : headerValueRaw;
    if (typeof headerValue !== 'string' || headerValue.length === 0) {
      reqLogger.warn('csrf_missing', { path: req.path, method: req.method });
      res.status(403).json({
        error: {
          code: 'csrf_required',
          message: 'Missing or invalid CSRF token.',
        },
      });
      return;
    }

    if (!validateCsrfToken(headerValue, sessionBearer, opts.secret)) {
      reqLogger.warn('csrf_mismatch', { path: req.path, method: req.method });
      res.status(403).json({
        error: {
          code: 'csrf_required',
          message: 'Missing or invalid CSRF token.',
        },
      });
      return;
    }

    next();
  };
}

export interface MountCsrfTokenRouteOptions {
  readonly secret: string;
  readonly path?: string;
}

/** Mount `GET /ggui/csrf-token` returning `{ token, expiresAt }`. SPAs
 *  call this on app boot when they prefer an explicit fetch over
 *  reading `X-Ggui-CSRF-Token` off another response. */
export function mountCsrfTokenRoute(
  app: Express,
  opts: MountCsrfTokenRouteOptions,
): void {
  const path = opts.path ?? DEFAULT_CSRF_TOKEN_PATH;
  app.get(path, (req: Request, res: Response) => {
    const sessionBearer = readUserSessionCookie(req);
    const token = mintCsrfToken({ sessionBearer, secret: opts.secret });
    res.status(200).json({
      token,
      expiresAt: Date.now() + TOKEN_LIFETIME_MS,
    });
  });
}
