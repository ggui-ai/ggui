/**
 * CORS for browser-resident MCP clients (ggui#438b).
 *
 * SCOPE: this is enablement, not conformance. No MCP spec layer requires
 * CORS — the transport spec never mentions it, and the MCP Apps spec is
 * fully host-mediated (the view postMessages its host; the host holds the
 * MCP connection). claude.ai and ChatGPT connect to remote MCP servers
 * from their BACKENDS, so they need none of this. It exists for clients
 * where the browser itself holds the Streamable HTTP connection: guuey's
 * browser host layer, local dev SPAs, Electron renderers.
 *
 * POSTURE: an origin ALLOWLIST, never `*`. The three existing `*` routes
 * (runtime-bundle, code, api-renders) are credential-free or token-gated
 * public reads; `/mcp` is different — `cookieAuthMiddleware` promotes the
 * session cookie to a Bearer on it, so it belongs to the cookie-authed
 * class. `Access-Control-Allow-Credentials` is NEVER set.
 *
 * LAYER RELATIONSHIP: origin-validation runs first and decides WHETHER a
 * request executes at all (the spec-mandated 403); this layer decides HOW
 * the browser is told it may read the response. A disallowed origin never
 * reaches this layer's headers in production — its rejection branch is
 * defense-in-depth. CORS is never the security boundary.
 */
import type { RequestHandler } from "express";
import { validateOriginHost, type OriginHostPolicy } from "./origin-validation.js";

/**
 * Response headers the MCP client MUST be able to read.
 *
 * Both are silent-failure modes: the SDK client reads `Mcp-Session-Id`
 * off every response and echoes it on subsequent requests — without
 * exposure the browser hands back `null`, initialize appears to succeed,
 * and every later request fails against a stateful server. It reads
 * `WWW-Authenticate` off 401s to discover the OAuth resource metadata
 * URL; without exposure, discovery silently degrades to guessing
 * default well-known paths.
 */
const EXPOSE_HEADERS = "Mcp-Session-Id, WWW-Authenticate";

/**
 * Fallback allow-headers when the preflight omits
 * `Access-Control-Request-Headers`. `Authorization` MUST be named
 * explicitly — per the Fetch spec, `*` does not cover it.
 */
const DEFAULT_ALLOW_HEADERS =
  "Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID";

/** GET and DELETE are permitted even though ggui answers them 405: the
 *  SDK client auto-attempts both and tolerates 405 — but only if the
 *  browser lets it read the status. */
const ALLOW_METHODS = "GET, POST, DELETE, OPTIONS";

const MAX_AGE_SECONDS = "600";

export function createBrowserCorsMiddleware(opts: {
  readonly policy: OriginHostPolicy;
}): RequestHandler {
  const { policy } = opts;
  return (req, res, next) => {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;

    // No Origin — a non-browser client. Nothing to negotiate.
    if (origin === undefined || origin.length === 0) {
      if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
      }
      next();
      return;
    }

    // The SAME allowlist that governs validation governs CORS, so an
    // origin can never be CORS-allowed but Origin-rejected.
    const allowed = validateOriginHost(req.headers.host, origin, policy) === null;

    if (allowed) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      // Echoing a specific origin makes the response origin-dependent.
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Expose-Headers", EXPOSE_HEADERS);
      // NOTE: Access-Control-Allow-Credentials is deliberately never set.
    }

    if (req.method === "OPTIONS") {
      if (allowed) {
        res.setHeader("Access-Control-Allow-Methods", ALLOW_METHODS);
        // Reflect the requested headers so host-injected extras (a
        // request-id, say) do not require a code change here.
        const requested = req.headers["access-control-request-headers"];
        res.setHeader(
          "Access-Control-Allow-Headers",
          typeof requested === "string" && requested.length > 0 ? requested : DEFAULT_ALLOW_HEADERS
        );
        res.setHeader("Access-Control-Max-Age", MAX_AGE_SECONDS);
      }
      // A disallowed preflight gets a bare 204 with no CORS headers —
      // the browser fails the request, which is the intended outcome.
      res.status(204).end();
      return;
    }

    next();
  };
}
