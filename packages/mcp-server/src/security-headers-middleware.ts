/**
 * Security headers middleware.
 *
 * Sets three defense-in-depth headers on every response:
 *
 *   - `X-Frame-Options: DENY` — clickjacking guard.
 *   - `Referrer-Policy: strict-origin-when-cross-origin` — drops the
 *     full URL on cross-origin navigations; keeps it on same-origin.
 *   - `X-Content-Type-Options: nosniff` — content-type sniffing off.
 *
 * Deliberately does NOT set `Content-Security-Policy` — embedded UI
 * routes manage CSP separately so per-page nonces stay correct. Don't
 * double-set: if a header is already on the response when the
 * middleware runs, leave it alone.
 *
 * `skipPathPrefixes` lets the API surface stay headerless. Default
 * skips:
 *   - `/mcp` — claude.ai's connector consumes that endpoint cross-
 *     origin, and X-Frame-Options/Referrer-Policy aren't needed for
 *     a non-rendered JSON wire.
 *   - `/r` + `/preview` — the renderer routes are the iframe-target
 *     surfaces MCP Apps hosts (claude.ai, our chat shell, anyone
 *     embedding the bootstrap meta) must be able to load. Setting
 *     `X-Frame-Options: DENY` on these would be a direct protocol
 *     violation. Operators tightening for prod can override via
 *     {@link SecurityHeadersMiddlewareOptions.skipPathPrefixes} +
 *     route-level CSP `frame-ancestors` if they need a stricter
 *     allowlist than "any origin can embed".
 */
import type { RequestHandler } from 'express';

const HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['X-Frame-Options', 'DENY'],
  ['Referrer-Policy', 'strict-origin-when-cross-origin'],
  ['X-Content-Type-Options', 'nosniff'],
];

const DEFAULT_SKIP_PATH_PREFIXES: ReadonlyArray<string> = [
  '/mcp',
  '/r',
  '/preview',
];

export interface SecurityHeadersMiddlewareOptions {
  readonly skipPathPrefixes?: ReadonlyArray<string>;
}

/** Returns an Express middleware that sets the standard ggui security
 *  headers — only when not already present on the response, and only
 *  on paths NOT matched by `skipPathPrefixes`. */
export function createSecurityHeadersMiddleware(
  opts: SecurityHeadersMiddlewareOptions = {},
): RequestHandler {
  const skips = opts.skipPathPrefixes ?? DEFAULT_SKIP_PATH_PREFIXES;
  return (req, res, next) => {
    for (const prefix of skips) {
      if (req.path === prefix || req.path.startsWith(prefix + '/')) {
        next();
        return;
      }
    }
    for (const [name, value] of HEADERS) {
      if (res.getHeader(name) === undefined) {
        res.setHeader(name, value);
      }
    }
    next();
  };
}
