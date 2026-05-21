/**
 * Embedded-ui cookie auth plane.
 *
 * This module owns the THIRD of the three token kinds the server
 * tracks for the embedded UI:
 *
 *   1. bootstrap tokens       — short-TTL, single-use, MCP Apps iframes.
 *   2. session tokens         — longer-TTL, reusable, post-bootstrap
 *                               reconnect creds.
 *   3. console cookies    — longer-TTL, reusable, same-origin
 *                               browser-only, issued by this server
 *                               for ITS OWN console landing/viewer
 *                               pages. **Scoped narrowly**: consumed
 *                               ONLY at the live-channel WebSocket
 *                               upgrade when `cookieAuth` is wired.
 *                               NEVER authenticates `/mcp`, `/pair`,
 *                               `/threads`, or any other ingress.
 *
 * Isolation invariant (load-bearing). The cookie uses the SAME HMAC
 * shape as the bootstrap/session tokens but a distinct `kind` claim
 * (`'console-session'`). That makes cross-kind confusion
 * impossible: a cookie value CAN'T verify as a bootstrap or session
 * token. Secrets are shared across kinds because they live in the
 * same trust domain (server-minted same-origin creds) and kind
 * discrimination is sufficient.
 *
 * Rationale for cookie-over-bearer. Browsers can't set `Authorization`
 * on native WebSocket upgrades. A same-origin HTTP-only cookie travels
 * automatically on the upgrade request, is unreadable from JS
 * (blocks XSS exfil), and is scoped to this origin by the browser
 * SameSite rules. The one genuine mismatch case (cookie authentication
 * on cross-origin requests) is defense-in-depth: set `SameSite=Strict`
 * so the cookie never leaves the console's origin in the first
 * place.
 *
 * Lifecycle. Cookie is minted at `POST /ggui/console/session-cookie`
 * (operator posts a shortCode → server resolves → sets Set-Cookie).
 * Cookie is consumed at `GET /ws` upgrade (if the server composition
 * wires `cookieAuth` to the session-channel). Never mutated in
 * between.
 */
import type { IncomingHttpHeaders } from 'node:http';
import {
  DEFAULT_DEVTOOL_SESSION_TTL_SEC,
  mintDevtoolSessionToken,
  verifyToken,
} from '@ggui-ai/mcp-server-core';

/**
 * Cookie name. Chosen deliberately to NOT conflict with common framework
 * cookies (Express session, CSRF, etc.). Change carries a compat
 * concern — the console SPA + the session-channel upgrade read by
 * this exact name. Keep this export as the single source of truth.
 */
export const CONSOLE_COOKIE_NAME = 'ggui_console_session';

/**
 * Result of minting a cookie. Callers set the cookie on their response
 * (the cookie endpoint) and echo the bound `sessionId`/`appId` back in
 * the response body so the client SPA can bootstrap the viewer without
 * a follow-up round-trip.
 */
export interface DevtoolCookieMint {
  readonly cookieValue: string;
  readonly setCookieHeader: string;
  readonly expiresAt: number;
  readonly sessionId: string;
  readonly appId: string;
}

export interface MintDevtoolCookieInput {
  readonly sessionId: string;
  readonly appId: string;
  /** HMAC secret. Shared with bootstrap + session tokens by design. */
  readonly secret: string;
  /** Cookie TTL in seconds. Defaults to 8 hours. */
  readonly ttlSec?: number;
  /**
   * When `true`, adds `Secure` to the Set-Cookie attribute string so
   * the cookie is only sent over HTTPS. Operators fronting the server
   * with TLS pass `true`; local dev / HTTP-only deployments leave it
   * falsy. No auto-detect — explicit is safer.
   */
  readonly secure?: boolean;
  /** Cookie path. Defaults to `/`. */
  readonly path?: string;
  /**
   * SameSite policy. Defaults to `'Strict'` — same-origin operator
   * convenience means we actively want the cookie NOT to travel on
   * cross-origin navigations.
   */
  readonly sameSite?: 'Strict' | 'Lax' | 'None';
}

/**
 * Mint a cookie value bound to `{ sessionId, appId }` and the formatted
 * `Set-Cookie` header to send on the response. Caller does
 * `res.setHeader('Set-Cookie', result.setCookieHeader)`.
 */
export function mintDevtoolCookie(
  input: MintDevtoolCookieInput,
): DevtoolCookieMint {
  const ttlSec = input.ttlSec ?? DEFAULT_DEVTOOL_SESSION_TTL_SEC;
  const { token, claims } = mintDevtoolSessionToken(
    { sessionId: input.sessionId, appId: input.appId, ttlSec },
    input.secret,
  );
  const attrs: string[] = [
    `${CONSOLE_COOKIE_NAME}=${token}`,
    `Path=${input.path ?? '/'}`,
    `Max-Age=${ttlSec}`,
    `SameSite=${input.sameSite ?? 'Strict'}`,
    `HttpOnly`,
  ];
  if (input.secure) attrs.push('Secure');
  return {
    cookieValue: token,
    setCookieHeader: attrs.join('; '),
    expiresAt: claims.exp * 1000,
    sessionId: input.sessionId,
    appId: input.appId,
  };
}

/**
 * Parse a raw `Cookie:` header and extract the console cookie
 * value, or `null` if absent.
 *
 * Minimal manual parser — intentionally avoids pulling in a cookie
 * library for a single cookie name. Handles the shapes we actually
 * see (single cookie, multiple `; `-separated pairs, URL-encoded
 * values); anything exotic returns null rather than trying to be
 * clever.
 */
export function extractDevtoolCookie(
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
    if (name !== CONSOLE_COOKIE_NAME) continue;
    const value = trimmed.slice(eq + 1);
    return value ? decodeURIComponent(value) : null;
  }
  return null;
}

/**
 * Read the console cookie off incoming headers. Thin wrapper
 * around {@link extractDevtoolCookie} that accepts Node's
 * `IncomingHttpHeaders` directly — the shape both the Express
 * request and the raw `IncomingMessage` use.
 *
 * Node's declared `headers['cookie']` type is `string | undefined`;
 * both Express (post-body-parser) and node:http (the WebSocket
 * upgrade path) consistently deliver a single string. Multi-line
 * `Cookie:` header arrays are not a real shape we see in practice,
 * so we don't try to support them — if a future runtime produces
 * that shape the cookie silently 404s, which is the correct
 * degraded behavior for this auth plane.
 */
export function readDevtoolCookieFromHeaders(
  headers: IncomingHttpHeaders,
): string | null {
  const raw = headers['cookie'];
  if (typeof raw === 'string') return extractDevtoolCookie(raw);
  return null;
}

/**
 * Verified claims extracted from an console cookie. Scope is
 * deliberately narrow: just the binding the session-channel upgrade
 * needs to enforce `subscribe.sessionId === cookie.sessionId`.
 */
export interface DevtoolCookieClaims {
  readonly sessionId: string;
  readonly appId: string;
}

/**
 * Verify an console cookie value. Returns the claims on success,
 * `null` on any failure (signature, expiry, wrong kind, malformed).
 *
 * Never throws. Failures collapse to `null` so callers don't have to
 * distinguish failure reasons in the hot path — an invalid cookie
 * means "no cookie" for auth purposes. A future refinement could
 * differentiate "cookie expired" (prompt re-mint) from "cookie is
 * for another server" (hard reject), but that distinction is not
 * surfaced today.
 */
export function verifyDevtoolCookie(
  cookieValue: string,
  secret: string,
): DevtoolCookieClaims | null {
  const result = verifyToken(cookieValue, secret, 'console-session');
  if (!result.ok) return null;
  return {
    sessionId: result.claims.sessionId,
    appId: result.claims.appId,
  };
}
