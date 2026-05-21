/**
 * End-user browser session cookie auth plane.
 *
 * This is the FOURTH cookie kind the OSS server tracks. Distinct from
 * the existing console session cookie (`ggui_console_session`,
 * `console-auth.ts`) — that one's an HMAC token bound to
 * `{sessionId, appId}` for narrow live-channel upgrade auth.
 *
 * The user-session cookie carries something different: **the raw
 * pairing-minted bearer**, opaque to this module, validated downstream
 * by the configured `AuthAdapter`. Architecture rationale:
 *
 *   - One bearer per end-user, two transports.
 *
 *     The pair-code consume flow (`POST /pair`) mints a bearer the
 *     MCP host (claude.ai's connector) sends as `Authorization: Bearer
 *     ...` on `/mcp` calls. The same bearer can also live in a
 *     same-origin HTTP-only cookie so the end-user's BROWSER (visiting
 *     the operator's `/settings` page) authenticates as the SAME
 *     identity. The AuthAdapter resolves both transports identically.
 *
 *   - `/login` mints the cookie atomically with a fresh pair-code
 *     consume.
 *
 *     Bearer paste at `/login` was rejected during the audit (session
 *     fixation: attacker tricks user into pasting attacker's bearer
 *     → user's actions land under attacker's identity). Only pair-code
 *     consume sets the cookie. The bearer never crosses an untrusted
 *     boundary.
 *
 *   - Cookie value === bearer string verbatim.
 *
 *     No HMAC-wrapping needed because the bearer is already a
 *     cryptographic credential the AuthAdapter validates. Wrapping
 *     would just add friction to the `Authorization: Bearer ...` ↔
 *     cookie symmetry. (The console session cookie HMACs because its
 *     payload is plain `{sessionId, appId}` claims, not a bearer.)
 *
 * Cookie attributes locked in the plan doc:
 *   - `HttpOnly` — JS can't read; XSS exfil blocked
 *   - `SameSite=Lax` — Strict breaks the Connect-Claude card
 *     cross-origin click flow (claude.ai iframe → ggui /settings)
 *   - `Secure` — TLS-only. Disabled for `secure: false` opt-out under
 *     localhost-only dev
 *   - `Path=/`
 *   - `Max-Age` — bound to bearer's pairing TTL
 *
 * What this module does NOT do:
 *   - Mint or verify HMAC tokens (that's bearer territory; AuthAdapter
 *     owns it).
 *   - Decide which routes require the cookie (composition-time;
 *     consumers wire `cookieAuthMiddleware` where they want
 *     cookie-or-header auth).
 *   - Rate-limiting, CSRF, audit hooks (handled by separate
 *     middleware).
 */
import type { IncomingHttpHeaders } from 'node:http';
import type { Request, RequestHandler } from 'express';

/**
 * Cookie name. Distinct from `ggui_console_session` so cross-kind
 * confusion is impossible — a cookie value never gets misinterpreted
 * as a different auth artifact. Change carries a compat concern (the
 * `/login` mint endpoint, `cookieAuthMiddleware`, and `/logout` clear
 * read this exact name); keep this export as the single source of
 * truth.
 */
export const USER_SESSION_COOKIE_NAME = 'ggui_user_session';

/**
 * Default cookie TTL (seconds). 8 hours mirrors the console session
 * cookie default — operators leaving a tab open for a workday don't
 * get re-prompted, but a stale cookie on a forgotten device expires
 * before it ages further. Operators wanting longer sessions pass
 * `ttlSec` at mount time.
 */
export const DEFAULT_USER_SESSION_TTL_SEC = 8 * 60 * 60;

export interface FormatUserSessionCookieInput {
  /** The pairing-minted bearer to embed as the cookie value. */
  readonly bearer: string;
  /** Cookie TTL in seconds. Defaults to {@link DEFAULT_USER_SESSION_TTL_SEC}. */
  readonly ttlSec?: number;
  /**
   * Adds `Secure` when truthy — cookie only sent over HTTPS. Operators
   * fronting the server with TLS pass `true`; localhost-only dev paths
   * leave it falsy. No auto-detect — explicit is safer here than
   * sniffing `req.protocol` (which lies behind reverse proxies).
   */
  readonly secure?: boolean;
  /** Cookie path. Defaults to `/`. */
  readonly path?: string;
  /**
   * SameSite policy. Defaults to `'Lax'` per the audit decision —
   * Strict would break the Connect-Claude card flow where the user
   * clicks an `<a target="_blank">` from claude.ai's iframe to
   * ggui's `/settings`. Lax permits top-level GET navigations to
   * carry the cookie, which is what we need; CSRF on POSTs is
   * defended via the CSRF-token middleware, not by cookie SameSite
   * alone.
   */
  readonly sameSite?: 'Strict' | 'Lax' | 'None';
}

/**
 * Format the `Set-Cookie` header value. Caller does
 * `res.setHeader('Set-Cookie', formatUserSessionCookieHeader(...))`.
 *
 * The bearer is URL-encoded so values containing `;` / `,` / `=`
 * survive the cookie wire format. `extractUserSessionCookie` decodes
 * symmetrically.
 */
export function formatUserSessionCookieHeader(
  input: FormatUserSessionCookieInput,
): string {
  const ttlSec = input.ttlSec ?? DEFAULT_USER_SESSION_TTL_SEC;
  const attrs: string[] = [
    `${USER_SESSION_COOKIE_NAME}=${encodeURIComponent(input.bearer)}`,
    `Path=${input.path ?? '/'}`,
    `Max-Age=${ttlSec}`,
    `SameSite=${input.sameSite ?? 'Lax'}`,
    `HttpOnly`,
  ];
  if (input.secure) attrs.push('Secure');
  return attrs.join('; ');
}

/**
 * Format a `Set-Cookie` header that immediately invalidates the
 * user-session cookie. Used by `/logout` and `/revoke-bearer` so the
 * browser drops it without waiting for `Max-Age`.
 *
 * `Max-Age=0` is the canonical clear pattern; matching attrs (Path,
 * Secure) are required so the browser pairs this with the original
 * mint and replaces it.
 */
export function formatClearUserSessionCookieHeader(input: {
  readonly secure?: boolean;
  readonly path?: string;
  readonly sameSite?: 'Strict' | 'Lax' | 'None';
}): string {
  const attrs: string[] = [
    `${USER_SESSION_COOKIE_NAME}=`,
    `Path=${input.path ?? '/'}`,
    `Max-Age=0`,
    `SameSite=${input.sameSite ?? 'Lax'}`,
    `HttpOnly`,
  ];
  if (input.secure) attrs.push('Secure');
  return attrs.join('; ');
}

/**
 * Read the user-session cookie value from a `Cookie` header string.
 * Returns the URL-decoded bearer, or `null` when the cookie is absent
 * / malformed.
 *
 * Manual parser — same shape as `extractDevtoolCookie`. Tolerant of
 * multi-cookie headers (`a=1; ggui_user_session=xyz; b=2`); rejects
 * empty values rather than treating them as an authenticated bearer.
 */
export function extractUserSessionCookie(
  cookieHeader: string | undefined,
): string | null {
  if (!cookieHeader) return null;
  const pairs = cookieHeader.split(';');
  for (const raw of pairs) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq);
    if (name !== USER_SESSION_COOKIE_NAME) continue;
    const value = trimmed.slice(eq + 1);
    if (!value) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      // Malformed URL-encoding — treat as no cookie. The browser
      // shouldn't produce this, but defensive.
      return null;
    }
  }
  return null;
}

/**
 * Read the cookie off Node `IncomingHttpHeaders` directly. Thin
 * wrapper for callers operating below Express (raw `IncomingMessage`,
 * WebSocket upgrade).
 */
export function readUserSessionCookieFromHeaders(
  headers: IncomingHttpHeaders,
): string | null {
  const raw = headers['cookie'];
  if (typeof raw === 'string') return extractUserSessionCookie(raw);
  return null;
}

/**
 * Express middleware that bridges the cookie → header path.
 *
 * When a request arrives WITHOUT an `Authorization` header but WITH a
 * valid user-session cookie, the middleware synthesizes
 * `Authorization: Bearer <cookie>` so every existing
 * `resolveIdentity(auth, req)` call works transparently. No new auth
 * codepath, no new gate logic.
 *
 * When the request already has an `Authorization` header, the cookie
 * is ignored — the explicit header wins. This preserves the existing
 * `/mcp` ingress posture (claude.ai's connector sends Authorization;
 * the cookie does not interfere with it).
 *
 * Composition-time: mount BEFORE any gate that reads
 * `req.headers['authorization']` (the `/ggui/console/llm-keys` gate,
 * the `/mcp` ingress, etc.). Order matters — middleware runs
 * top-to-bottom in the Express chain.
 */
export function cookieAuthMiddleware(): RequestHandler {
  return (req, _res, next) => {
    if (req.headers['authorization']) {
      next();
      return;
    }
    const cookieValue = readUserSessionCookieFromHeaders(req.headers);
    if (cookieValue) {
      req.headers['authorization'] = `Bearer ${cookieValue}`;
    }
    next();
  };
}

/**
 * Read the user-session cookie off an Express request. Used by
 * `/logout` to know whether there's anything to clear, by
 * `/revoke-bearer` to identify the pairing to revoke, and by tests
 * that need to inspect the cookie without going through middleware.
 */
export function readUserSessionCookie(req: Request): string | null {
  return readUserSessionCookieFromHeaders(req.headers);
}
