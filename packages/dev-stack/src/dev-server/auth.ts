/**
 * Minimal auth + CORS policy for the local dev server.
 *
 * Trust model (foundation slice, 2026-04-18):
 *
 * - The dev server binds to `127.0.0.1` by default, so the *primary*
 *   trust boundary is the loopback interface. This module adds a
 *   belt-and-suspenders token + origin check so the same server can
 *   also be reached by a browser-side preview UI opened in a
 *   different localhost port (different origin → CORS-regulated)
 *   without inventing a wide-open public-by-default posture.
 *
 * - Bearer tokens: `Authorization: Bearer <token>`. A single token
 *   per run, either supplied via `GGUI_DEV_TOKEN` or generated from
 *   `crypto.randomBytes(24)` on boot. The CLI prints the token + a
 *   ready-to-curl `Authorization` header so the developer can paste
 *   it wherever they need. `/health` is intentionally unauthenticated
 *   — any reachability check, client handshake probe, or liveness
 *   monitor wants this path without needing the token first.
 *
 * - Origin allowlist: browser clients must send `Origin` matching an
 *   allowed pattern. Defaults cover localhost / 127.0.0.1 on any
 *   port (`http(s)://localhost:NNNN` / `http(s)://127.0.0.1:NNNN`).
 *   Extra origins can be declared via `GGUI_DEV_ORIGINS` as a
 *   comma-separated exact-match list — no wildcards by design,
 *   a remote client's real hostname goes in explicitly or not at all.
 *
 * - Non-browser clients (no `Origin` header) pass the origin check;
 *   they are gated by the bearer token alone. That matches `curl`
 *   scripts and the paired-client case where the "origin" concept
 *   doesn't apply.
 *
 * - Preflight `OPTIONS` is handled here too — short-circuited with
 *   a 204 + the CORS headers the browser needs to follow up with the
 *   real request. The real handler never sees OPTIONS.
 *
 * This is deliberately the *minimum viable* auth layer. Long-term
 * the pairing protocol in the plan doc §4 replaces per-invocation
 * tokens with device-scoped long-lived tokens; that's a different
 * slice.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Policy shape used by the HTTP layer. `allowOrigin(origin)` returns
 * the exact string to echo in `Access-Control-Allow-Origin` (or
 * `null` to reject). `authorize(req)` decides whether a request
 * carries a valid token.
 */
export interface DevServerSecurityPolicy {
  /** Human-readable token the CLI prints. Never put this in logs
   * beyond boot. */
  readonly token: string;
  /** Was the token auto-generated this run? Informs the boot banner. */
  readonly tokenGenerated: boolean;
  /** List of exact-match allowed origins. `'localhost'` is expanded
   * at check time to cover any port. Empty = default set only. */
  readonly allowedOrigins: readonly string[];

  /**
   * Apply the policy to a request. Returns:
   *   - `{ outcome: 'handled' }` if the response was already
   *     terminated (preflight, unauthorized, etc.) — the caller must
   *     NOT write further.
   *   - `{ outcome: 'proceed' }` if the request may continue.
   *
   * Mutates `res` to attach CORS headers in the `proceed` path so
   * the main handler doesn't have to repeat them.
   */
  apply(req: IncomingMessage, res: ServerResponse): PolicyOutcome;
}

export type PolicyOutcome = { outcome: 'handled' } | { outcome: 'proceed' };

export interface CreatePolicyOptions {
  /** Override the bearer token. If omitted and `GGUI_DEV_TOKEN` is
   * unset, a random 24-byte hex token is generated. */
  token?: string;
  /** Explicit extra origins (beyond the localhost defaults). */
  extraOrigins?: readonly string[];
  /** Read env vars from this record. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

const DEFAULT_LOCALHOST_HOSTS = ['localhost', '127.0.0.1'];
const BEARER_PREFIX = 'bearer ';

/** Endpoints that skip the token check. Kept in one place so the
 * auth rule is visible at a glance. `/hub` is public because it's
 * the HTML shell a browser loads before it has the token — the
 * existing origin allowlist still blocks cross-origin access, and
 * the shell itself embeds the token for its same-origin XHRs.
 * `/hub/preview` follows the same pattern: the browser loads it as
 * an iframe under the hub, and the shell embeds the bearer for its
 * own data XHRs. */
const PUBLIC_PATHS = new Set<string>([
  '/health',
  '/health/',
  '/hub',
  '/hub/',
  '/hub/preview',
  '/hub/preview/',
  // The preview iframe loads this bundle with a plain
  // `<script type="module" src="/hub/preview.js">` — browsers do not
  // attach Authorization headers to element-triggered script loads,
  // so the bundle must be reachable without a bearer. The origin
  // allowlist still blocks cross-origin reads; the bundle itself
  // only reads from the iframe's same-origin bootstrap.
  '/hub/preview.js',
]);

export function createSecurityPolicy(
  options: CreatePolicyOptions = {},
): DevServerSecurityPolicy {
  const env = options.env ?? process.env;
  const envToken = env.GGUI_DEV_TOKEN?.trim();
  const explicitToken = options.token ?? (envToken && envToken.length > 0 ? envToken : undefined);
  const tokenGenerated = !explicitToken;
  const token = explicitToken ?? randomBytes(24).toString('hex');

  const fromEnv = (env.GGUI_DEV_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const allowedOrigins = Object.freeze([...(options.extraOrigins ?? []), ...fromEnv]);

  const apply = (req: IncomingMessage, res: ServerResponse): PolicyOutcome => {
    const origin = header(req, 'origin');
    const pathname = pathOf(req);

    // Preflight: respond even before authentication so the browser
    // can actually deliver the `Authorization` header on the real
    // request. An allowed origin is still required — otherwise we
    // teach the browser to send credentials to a server we might
    // disown.
    if (req.method === 'OPTIONS') {
      if (origin !== null && !isOriginAllowed(origin, allowedOrigins)) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'origin-not-allowed', origin }));
        return { outcome: 'handled' };
      }
      writeCorsHeaders(res, origin);
      res.writeHead(204);
      res.end();
      return { outcome: 'handled' };
    }

    // Origin check — browser-only. Non-browser clients (`curl`, agent
    // pods, etc.) omit `Origin` and are gated by the token alone.
    if (origin !== null && !isOriginAllowed(origin, allowedOrigins)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'origin-not-allowed', origin }));
      return { outcome: 'handled' };
    }

    // Token check — skipped for the public health path so liveness
    // probes don't need the secret.
    if (!PUBLIC_PATHS.has(pathname)) {
      const presented = extractBearerToken(req);
      if (!presented || !constantTimeEqual(presented, token)) {
        writeCorsHeaders(res, origin);
        res.writeHead(401, {
          'content-type': 'application/json',
          'www-authenticate': 'Bearer realm="ggui-dev"',
        });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return { outcome: 'handled' };
      }
    }

    writeCorsHeaders(res, origin);
    return { outcome: 'proceed' };
  };

  return { token, tokenGenerated, allowedOrigins, apply };
}

function writeCorsHeaders(res: ServerResponse, origin: string | null): void {
  if (origin === null) return;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('access-control-allow-credentials', 'true');
  res.setHeader('access-control-allow-methods', 'GET, HEAD, OPTIONS');
  res.setHeader('access-control-allow-headers', 'authorization, content-type');
  res.setHeader('vary', 'origin');
}

function isOriginAllowed(origin: string, extras: readonly string[]): boolean {
  if (extras.includes(origin)) return true;
  // Normalise and check localhost / 127.0.0.1 defaults.
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return DEFAULT_LOCALHOST_HOSTS.includes(url.hostname);
}

function extractBearerToken(req: IncomingMessage): string | null {
  const auth = header(req, 'authorization');
  if (auth === null) return null;
  if (!auth.toLowerCase().startsWith(BEARER_PREFIX)) return null;
  const value = auth.slice(BEARER_PREFIX.length).trim();
  return value.length > 0 ? value : null;
}

function header(req: IncomingMessage, name: string): string | null {
  const raw = req.headers[name];
  if (raw === undefined) return null;
  if (Array.isArray(raw)) return raw[0] ?? null;
  return raw;
}

function pathOf(req: IncomingMessage): string {
  const url = new URL(req.url ?? '/', 'http://ggui-dev.local/');
  return url.pathname;
}

function constantTimeEqual(a: string, b: string): boolean {
  // Pad to equal length so `timingSafeEqual` doesn't throw; length
  // mismatch is still rejected because the buffers won't match.
  const max = Math.max(a.length, b.length);
  const ab = Buffer.from(a.padEnd(max, '\0'));
  const bb = Buffer.from(b.padEnd(max, '\0'));
  return ab.length === bb.length && a.length === b.length && timingSafeEqual(ab, bb);
}
