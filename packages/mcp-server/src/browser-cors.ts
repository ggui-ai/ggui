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
 * POSTURE: an origin ALLOWLIST, never `*`, for everything THIS layer
 * answers. The public `*` read routes (runtime bundle + shims, code and
 * contract modules, the session read endpoints) are credential-free or
 * token-in-URL public reads that stamp `*` on their own responses — and
 * since ggui#1231 they also OWN their preflight, via
 * `createPublicReadPreflight()`. The reason is structural: a sandboxed
 * `srcdoc` frame's origin is the literal `null`, a value no allowlist
 * can name, and a preflight this layer ended with a bare 204 made every
 * request the browser chose to preflight fail as an opaque CORS error
 * while the plain GET kept working. So an OPTIONS from an origin this
 * layer does not allow is PASSED THROUGH, not ended — a route-level
 * `app.options(path, createPublicReadPreflight())` gets its turn, and
 * `createPreflightFallback()`, mounted last, closes what nobody owns
 * with the bare 204. `/mcp` is different — `cookieAuthMiddleware`
 * promotes the session cookie to a Bearer on it, so it belongs to the
 * cookie-authed class and never owns a `*` preflight.
 * `Access-Control-Allow-Credentials` is NEVER set, by either handler.
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

    // No Origin — a non-browser client. Nothing to negotiate; an OPTIONS
    // falls through to a route-owned preflight or the fallback's 204.
    if (origin === undefined || origin.length === 0) {
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
        res.status(204).end();
        return;
      }
      // A preflight from an origin this layer does not allow is NOT ended
      // here (ggui#1231): the public `*` read routes own theirs — see
      // `createPublicReadPreflight()` — and `createPreflightFallback()`
      // answers everything nobody owns with a bare 204 and no CORS
      // header, so the browser fails the request, the intended outcome.
      next();
      return;
    }

    next();
  };
}

/** Methods a public read route serves; nothing side-effectful. */
const PUBLIC_READ_ALLOW_METHODS = "GET, HEAD, OPTIONS";

/**
 * Fallback allow-headers for a public read preflight that names none.
 * These routes take no `Authorization`: their gate, where they have one,
 * is a token in the URL, which the preflight never carries.
 */
const PUBLIC_READ_DEFAULT_ALLOW_HEADERS = "Accept, Content-Type, Range";

/**
 * The preflight answer of a public `*` read route (ggui#1231). Register
 * it as `app.options(<the same path>, createPublicReadPreflight())`
 * beside the route's `app.get`, so the preflight says exactly what the
 * GET already says: any origin — including the `null` of a sandboxed
 * `srcdoc` frame, which no allowlist can name — may read it. Reflects
 * the requested headers so a host-injected extra needs no code change
 * here. Never sets `Access-Control-Allow-Credentials`.
 *
 * An origin the allowlist DOES name never reaches this handler: the
 * allowlist layer answers its preflight first, with the specific origin.
 */
export function createPublicReadPreflight(): RequestHandler {
  return (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", PUBLIC_READ_ALLOW_METHODS);
    const requested = req.headers["access-control-request-headers"];
    res.setHeader(
      "Access-Control-Allow-Headers",
      typeof requested === "string" && requested.length > 0
        ? requested
        : PUBLIC_READ_DEFAULT_ALLOW_HEADERS
    );
    res.setHeader("Access-Control-Max-Age", MAX_AGE_SECONDS);
    res.status(204).end();
  };
}

/**
 * The terminal answer for a preflight nobody owns: a bare 204 with no
 * CORS header, so the browser fails the request. Mount it LAST — after
 * every route — because `createBrowserCorsMiddleware` passes an
 * unlisted-origin (or origin-less) OPTIONS through precisely so a
 * route-level preflight can answer before this does. Non-OPTIONS
 * requests are untouched.
 */
export function createPreflightFallback(): RequestHandler {
  return (req, res, next) => {
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}
