/**
 * Origin/Host validation for the MCP wire — the DNS-rebinding defense
 * (ggui#438a).
 *
 * Spec (Streamable HTTP, 2025-11-25): "Servers MUST validate the Origin
 * header on all incoming connections to prevent DNS rebinding attacks…
 * If the Origin header is present and invalid, servers MUST respond
 * with HTTP 403 Forbidden."
 *
 * WHY THIS IS NOT CORS: CORS governs whether a browser lets a page READ
 * a cross-origin response; it never governs whether the request EXECUTES
 * server-side. After a DNS rebind (attacker.com → 127.0.0.1) the page's
 * requests are SAME-origin from the browser's view, so no preflight
 * fires and no CORS header is consulted — only an inbound Host/Origin
 * check catches it. See `./browser-cors.ts` for the (separate) CORS layer.
 *
 * WHY RAW HEADERS: `request-context.ts` honors `X-Forwarded-Host` when the
 * TCP peer is loopback — and a rebinding attacker IS a loopback peer, so a
 * check built on the derived host is bypassable with one attacker-supplied
 * header. `Host` and `Origin` are forbidden header names for `fetch`, so
 * page JS cannot forge them: the raw values are the trustworthy ones.
 *
 * WHY NOT THE SDK's enableDnsRebindingProtection: deprecated upstream in
 * favor of external middleware, per-transport (never sees the WS upgrade
 * ingress or non-transport routes), and runs after ggui's own pipeline.
 * The 403 body + message wording here mirror the SDK's
 * `createJsonErrorResponse` so clients see one rejection dialect.
 */
import type { RequestHandler } from "express";
import type { Logger } from "./logger.js";

/** Hostnames that mean "this machine". Compared without port. */
export const LOOPBACK_HOSTNAMES: ReadonlyArray<string> = ["localhost", "127.0.0.1", "::1", "[::1]"];

export interface OriginHostPolicy {
  /**
   * Allowed `Host` hostnames, port-agnostic and lowercased. `null`
   * disables the Host check entirely — used when the server is bound to
   * a non-loopback address, where the operator has explicitly opted into
   * wide exposure and rebinding is not the applicable threat model.
   * (Combined with --dev-allow-all that posture leaves a documented
   * residual — the CLI warns loudly; see serve-command.ts.)
   */
  readonly allowedHosts: ReadonlyArray<string> | null;
  /**
   * Allowed page origins, lowercased, exact (scheme + host + port):
   * the operator's `browserOrigins` plus the publicBaseUrl origin
   * (the server's own tunnel-served pages POST with it). Loopback
   * origins and same-origin requests are allowed unconditionally on
   * top of this list — see `validateOriginHost`.
   */
  readonly allowedOrigins: ReadonlyArray<string>;
}

export interface OriginHostRejection {
  readonly header: "host" | "origin";
  /** The offending header value; empty string when the header was absent. */
  readonly value: string;
}

/** Strip the port and surrounding brackets from a Host/authority value. */
function hostnameOf(authority: string): string {
  const lower = authority.trim().toLowerCase();
  if (lower.startsWith("[")) {
    const close = lower.indexOf("]");
    return close === -1 ? lower : lower.slice(0, close + 1);
  }
  // A bracket-less value with more than one colon is a bare IPv6
  // address (`::1`), not host:port — return it whole. Slicing at the
  // first colon would return "" and silently disable the Host check
  // for an IPv6 loopback bind.
  if (lower.indexOf(":") !== lower.lastIndexOf(":")) return lower;
  const colon = lower.indexOf(":");
  return colon === -1 ? lower : lower.slice(0, colon);
}

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.includes(hostname);
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    return isLoopbackHostname(hostnameOf(new URL(origin).host));
  } catch {
    return false;
  }
}

/**
 * Same-origin allowance: does the Origin's authority (host:port) match
 * the request's own Host? A page this server itself served (LAN bind,
 * tunnel) sends exactly that on every POST and WS handshake; rejecting
 * it would 403 the server's own console. Safe on loopback binds because
 * a rebound page fails the HOST check before Origin is consulted.
 */
function originMatchesRequestHost(origin: string, rawHost: string | undefined): boolean {
  if (rawHost === undefined || rawHost.length === 0) return false;
  try {
    return new URL(origin).host === rawHost.trim().toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Build the effective policy from deployment inputs.
 *
 * The Host check is active only for loopback binds — that is exactly the
 * configuration the spec's rebinding warning targets (a local server
 * reachable because the attacker's domain resolves to 127.0.0.1). A
 * server bound to 0.0.0.0 or a routable address was deliberately exposed
 * by its operator; rejecting its own LAN hostname would break phone/LAN
 * testing for no security gain — auth is the gate there.
 *
 * `browserOrigins` contribute ONLY to allowedOrigins, never to
 * allowedHosts: a page at https://app.guuey.com talking to a local serve
 * sends `Host: localhost:6781`, so widening the anti-rebinding Host
 * allowlist with page hostnames would serve no flow.
 */
export function buildOriginHostPolicy(input: {
  readonly bindHost: string;
  readonly publicBaseUrl?: string;
  readonly browserOrigins?: ReadonlyArray<string>;
}): OriginHostPolicy {
  const boundToLoopback = isLoopbackHostname(hostnameOf(input.bindHost));

  const hosts: string[] = [...LOOPBACK_HOSTNAMES];
  const origins: string[] = (input.browserOrigins ?? [])
    .map((o) => o.trim().toLowerCase().replace(/\/$/, ""))
    .filter((o) => o.length > 0);

  if (input.publicBaseUrl !== undefined) {
    try {
      const url = new URL(input.publicBaseUrl);
      // The tunnel/proxy host arrives on forwarded requests' Host
      // header, and the server's OWN pages served from that origin
      // (console, /r/<code>) POST + open WS with it as Origin. Both
      // must validate, or a tunnel deployment 403s itself.
      hosts.push(hostnameOf(url.host));
      origins.push(url.origin.toLowerCase());
    } catch {
      // A malformed publicBaseUrl is the caller's problem to report;
      // silently contributing nothing keeps validation fail-closed.
    }
  }

  return {
    allowedHosts: boundToLoopback ? hosts : null,
    allowedOrigins: origins,
  };
}

/**
 * Validate one request's raw Host/Origin against the policy.
 * Returns `null` when the request passes.
 *
 * Pure by design: the Express middleware and the WebSocket `upgrade`
 * handler (a second ingress Express never sees) call the same function,
 * so the two ingresses cannot drift.
 */
export function validateOriginHost(
  rawHost: string | undefined,
  rawOrigin: string | undefined,
  policy: OriginHostPolicy
): OriginHostRejection | null {
  if (policy.allowedHosts !== null) {
    if (rawHost === undefined || rawHost.length === 0) {
      return { header: "host", value: "" };
    }
    if (!policy.allowedHosts.includes(hostnameOf(rawHost))) {
      return { header: "host", value: rawHost };
    }
  }

  // Absent Origin passes: every non-browser client omits it.
  if (rawOrigin === undefined || rawOrigin.length === 0) return null;

  const origin = rawOrigin.trim().toLowerCase().replace(/\/$/, "");
  // Loopback pages are allowed unconditionally so the zero-config
  // quickstart (sample SPA on :6890 → serve on :6781) needs no flags.
  // Safe because loopback origins can only be opened by software already
  // running on this machine.
  if (isLoopbackOrigin(origin)) return null;
  if (originMatchesRequestHost(origin, rawHost)) return null;
  if (policy.allowedOrigins.includes(origin)) return null;
  return { header: "origin", value: rawOrigin };
}

/** Message text for a rejection — mirrors the SDK's own wording. */
export function rejectionMessage(rejection: OriginHostRejection): string {
  const label = rejection.header === "host" ? "Host" : "Origin";
  return `Invalid ${label} header: ${rejection.value}`;
}

export function createOriginHostValidationMiddleware(opts: {
  readonly policy: OriginHostPolicy;
  /**
   * Path prefixes where a present-and-disallowed Origin is 403'd — the
   * MCP wire (universal /mcp, per-app prefix, /control, isolated
   * services). The HOST check runs on EVERY path regardless: it is the
   * actual rebinding defense and legitimate cross-origin consumers
   * still send the server's own Host. Origin enforcement is scoped
   * because several non-MCP surfaces are deliberately consumed
   * cross-origin — the runtime-bundle and /code routes are fetched by
   * sandboxed iframes whose Origin is literally `null`.
   */
  readonly enforceOriginPathPrefixes: ReadonlyArray<string>;
  readonly logger: Logger;
}): RequestHandler {
  const { policy, enforceOriginPathPrefixes, logger } = opts;
  // Lowercased once at middleware-creation time so a caller passing a
  // mixed-case service path (e.g. perAppRouting.pathPrefix) is still
  // matched correctly below — see the req.path.toLowerCase() comment.
  const lowerEnforcePrefixes = enforceOriginPathPrefixes.map((p) => p.toLowerCase());
  // Dedupe log noise: a polling page would otherwise flood the log with
  // one identical warning per request. Capped so attacker-minted unique
  // header values cannot grow the set without bound; after the cap,
  // rejections still 403 — they just stop logging.
  const warned = new Set<string>();
  return (req, res, next) => {
    // Express routes case-insensitively by default (no `case sensitive
    // routing` setting here), so `POST /MCP` reaches the same handler as
    // `POST /mcp`. Comparing req.path as-is would let that case variant
    // skip Origin enforcement entirely — the Origin MUST must not be
    // case-bypassable — so both sides are lowercased before comparison.
    const path = req.path.toLowerCase();
    const originEnforced = lowerEnforcePrefixes.some((p) => path === p || path.startsWith(`${p}/`));
    const rejection = validateOriginHost(
      req.headers.host,
      originEnforced && typeof req.headers.origin === "string" ? req.headers.origin : undefined,
      policy
    );
    if (rejection === null) {
      next();
      return;
    }
    const key = `${rejection.header}:${rejection.value}`;
    if (!warned.has(key) && warned.size < 100) {
      warned.add(key);
      logger.warn("origin_host_rejected", {
        header: rejection.header,
        value: rejection.value,
        path: req.path,
        hint:
          rejection.header === "origin"
            ? "Add the page origin with `ggui serve --browser-origin <origin>` (or GGUI_BROWSER_ORIGINS)."
            : "Request arrived with an unexpected Host header — DNS-rebinding defense. Set --public-base-url if this is a legitimate proxy/tunnel host.",
      });
    }
    res.status(403).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: rejectionMessage(rejection) },
      id: null,
    });
  };
}
