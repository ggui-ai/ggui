/**
 * Per-request context plumbing — AsyncLocalStorage backed.
 *
 * The capability-URL routes (`/r/<code>`, `/api/bootstrap/<code>`) and
 * the render/update tool result-meta builders all want to know the
 * absolute public base URL of THIS server as seen by THIS client.
 * That can't come from a static config in two common dev/OSS scenarios:
 *
 *   1. Local dev behind cloudflared / ngrok: operator runs the MCP on
 *      `localhost:6781`, the tunnel rewrites the public host. The
 *      server doesn't know its tunnel host at boot; cloudflared
 *      connects over loopback and adds `X-Forwarded-Host: <tunnel>`.
 *   2. Co-located reverse proxy (Nginx, Caddy on the same box): same
 *      pattern, peer is loopback, host is in `X-Forwarded-Host`.
 *
 * Without auto-derive, every dev hits the "Runtime bundle failed to
 * load" trap: `_meta.ggui.bootstrap.runtimeUrl` ships the relative
 * `/_ggui/iframe-runtime.js`, the iframe boots inside an opaque
 * srcdoc origin (claude.ai), the relative path doesn't resolve.
 *
 * ## Trust model — read this BEFORE adding fields here
 *
 * `X-Forwarded-Host` is trivially spoofable when reachable from the
 * public internet (anyone with curl can send arbitrary headers). The
 * only safe trust signal is **TCP peer is loopback** (127.0.0.1, ::1,
 * IPv4-mapped loopback). Loopback means: this header was attached by
 * a co-located process the operator deployed (cloudflared, ngrok,
 * Nginx). Off-machine attackers can't reach the server via loopback;
 * a remote-bind would itself be the operator's deploy choice.
 *
 * Auto-derive applies ONLY to data the relevant route really should
 * derive from the request:
 *   - runtimeUrl on render/update bootstrap meta (this slice).
 *
 * Auto-derive MUST NOT apply to:
 *   - OAuth callback URLs (operator-config'd one-time per provider;
 *     leaking spoofed host into an OAuth flow opens redirect-attack
 *     vectors).
 *   - Email magic-link URLs (long-lived credentials; spoofed host
 *     makes an attacker the "trusted" destination).
 *   - WebSocket token base URLs.
 *
 * Each callsite that wants auto-derive opts in explicitly via
 * `resolvePublicBaseUrl(configuredOrUndefined)`. Everything not opting
 * in stays static-config-only.
 */

import type { NextFunction, Request, Response } from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';

/** Inferred public-facing identity of this request. */
export interface RequestContext {
  /** `http` or `https` — derived from X-Forwarded-Proto when peer is
   *  local, else from `req.protocol`. */
  readonly proto: 'http' | 'https';
  /** Host:port the client sees us at. Either `req.host`, or
   *  `X-Forwarded-Host` (first entry of a comma-separated list)
   *  when the TCP peer is loopback. */
  readonly host: string;
  /** True iff the TCP peer is loopback. Auto-derive logic gates on
   *  this — see file header for the trust rationale. */
  readonly peerIsLocal: boolean;
  /** True iff this request carried an `X-Forwarded-Host` header AND
   *  the peer was loopback. This is the "I am behind a proxy" signal.
   *  Auto-derive (`resolvePublicBaseUrl` without an explicit configured
   *  value) requires both — direct localhost browser hits don't get
   *  their URLs rewritten, only proxy-fronted ones do. */
  readonly forwardedHostHonored: boolean;
}

export const requestContextStore = new AsyncLocalStorage<RequestContext>();

/** Loopback TCP-peer addresses we accept as the "co-located reverse
 *  proxy" trust signal. Includes the IPv4-mapped IPv6 form Node uses
 *  for IPv4 connections on a dual-stack socket. */
const LOOPBACK_PEERS: ReadonlySet<string> = new Set([
  '127.0.0.1',
  '::1',
  '::ffff:127.0.0.1',
]);

/**
 * Build the Express middleware that runs every request inside an ALS
 * scope. Add this near the top of the middleware chain — before any
 * route handler or downstream `app.use` that may call `getRequestContext()`.
 *
 * Reads `req.socket.remoteAddress` directly (not `req.ip`) so a
 * prior `app.set('trust proxy', ...)` configuration doesn't widen
 * the loopback gate behind our back.
 */
export function buildRequestContextMiddleware() {
  return (req: Request, _res: Response, next: NextFunction) => {
    const peer = req.socket.remoteAddress ?? '';
    const peerIsLocal = LOOPBACK_PEERS.has(peer);

    let proto: 'http' | 'https' = req.protocol === 'https' ? 'https' : 'http';
    let host = req.get('host') ?? '';
    let forwardedHostHonored = false;

    if (peerIsLocal) {
      const xfHost = req.get('x-forwarded-host');
      const xfProto = req.get('x-forwarded-proto');
      if (typeof xfHost === 'string' && xfHost.length > 0) {
        // X-Forwarded-Host may be a comma-separated chain; the
        // outermost (first) entry is the public-facing host.
        const first = xfHost.split(',')[0];
        if (typeof first === 'string' && first.trim().length > 0) {
          host = first.trim();
          forwardedHostHonored = true;
        }
      }
      if (xfProto === 'http' || xfProto === 'https') {
        proto = xfProto;
      } else if (typeof xfProto === 'string' && xfProto.includes(',')) {
        // Same chain semantics — first entry wins.
        const first = xfProto.split(',')[0]?.trim();
        if (first === 'http' || first === 'https') {
          proto = first;
        }
      }
    }

    requestContextStore.run(
      { proto, host, peerIsLocal, forwardedHostHonored },
      next,
    );
  };
}

/** Read the request context out of the ALS store. Returns undefined
 *  when called outside any request (background workers, boot setup). */
export function getRequestContext(): RequestContext | undefined {
  return requestContextStore.getStore();
}

/**
 * Resolve the public base URL for a request.
 *
 * Order:
 *   1. Explicit configured value wins — operators ALWAYS get the last
 *      word. Trailing slash trimmed for join-safety.
 *   2. If a request context exists AND its TCP peer is loopback AND
 *      the request carries a usable host, return `<proto>://<host>`.
 *   3. Otherwise undefined — callers must fall back to their own
 *      default (typically a relative URL or skip auto-prefixing).
 *
 * Returns undefined (not an empty string) so callers can distinguish
 * "I have a base, use it" from "I don't have a base, ship the value
 * as-is" with a simple `if (base) ...` check.
 */
export function resolvePublicBaseUrl(configured?: string): string | undefined {
  if (typeof configured === 'string' && configured.length > 0) {
    return configured.replace(/\/$/, '');
  }
  const ctx = getRequestContext();
  if (!ctx || !ctx.forwardedHostHonored || !ctx.host) {
    // No explicit `X-Forwarded-Host` from a trusted (loopback) peer
    // means there's no proxy signal to act on. Return undefined so
    // callers ship their static value as-is — direct browser hits
    // resolve relative URLs against the page origin just fine.
    return undefined;
  }
  return `${ctx.proto}://${ctx.host}`;
}

/**
 * Resolve `runtimeUrl` against the request. If the configured/static
 * value is already absolute, return it verbatim. Otherwise prefix it
 * with the public base URL
 * derived from {@link resolvePublicBaseUrl}; if no base is available,
 * return the raw (still-relative) value so the caller's existing
 * fall-back paths kick in.
 *
 * Both `runtimeUrl` arguments tolerate `undefined` to keep callsites
 * tidy when the dep is optional.
 */
export function resolveRuntimeUrl(args: {
  readonly configuredPublicBaseUrl?: string;
  readonly runtimeUrl?: string;
}): string | undefined {
  const raw = args.runtimeUrl;
  if (raw === undefined) return undefined;
  if (/^https?:\/\//i.test(raw)) return raw;
  const base = resolvePublicBaseUrl(args.configuredPublicBaseUrl);
  if (!base) return raw;
  return raw.startsWith('/') ? base + raw : `${base}/${raw}`;
}
