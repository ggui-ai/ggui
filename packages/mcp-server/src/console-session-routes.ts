/**
 * Console render-viewer session routes (cookie mint + resource +
 * meta + observation).
 *
 *   POST /ggui/console/session-cookie
 *     — resolve shortCode → render and mint the same-origin HTTP-only
 *       cookie the viewer authenticates to the live channel with.
 *
 *   GET /ggui/console/session-resource?session=<sessionId>
 *     — production thin-shell HTML, wrapped as a ResourceContents
 *       blob (`text` IS `GGUI_RENDER_SHELL_HTML`, byte-identical to
 *       what Claude Desktop fetches via MCP `resources/read
 *       ui://ggui/render`). NO inlined bootstrap — console fetches
 *       the bootstrap separately (meta route below) and replies to
 *       the iframe's `ui/initialize` postMessage with it.
 *
 *   GET /ggui/console/sessions/:sessionId/meta
 *     — slice-envelope JSON (`{ "ai.ggui/render": {...} }`, the same
 *       shape as the wire `_meta`). The console forwards this to the
 *       iframe as the `_meta` slice of a spec-canonical
 *       `ui/notifications/tool-result` notification (per
 *       `docs/protocol/extensions/ai.ggui-meta.md`). Requires
 *       `mcpApps: true` (mintBootstrap presence) — 503 otherwise.
 *
 *   GET /ggui/console/session?session=<sessionId>
 *     — `{render, eventSequence}` JSON. Console-only observation
 *       surface for `<GguiSessionViewer>` to mount `<RenderInspector>`.
 *
 * Named parties (all routes):
 *   - console (SPA caller) — holds the same-origin cookie.
 *   - mcp-server (these handlers) — gates auth + scope; mints the
 *     bootstrap on the meta route.
 *   - host wrapper (bootstrap forwarder; `<AppRenderer>` on web,
 *     `<McpAppIframe>` on RN) — receives the bootstrap JSON and
 *     forwards it as a `ui/notifications/tool-result` `_meta` slice.
 *   - renderer bundle (inside the iframe) — runs the same boot
 *     code path as production; reads the single `ai.ggui/render`
 *     slice meta.
 *
 * Auth + scope obligations (uniform):
 *   - Cookie-auth via `readDevtoolCookieFromHeaders` +
 *     `verifyDevtoolCookie`. Invalid / missing → 401.
 *   - Scope: `cookie.sessionId` MUST equal the requested session.
 *     Cross-render access with a valid cookie → 403.
 *   - GguiSession existence + appId match: 404 / 403 respectively.
 *
 * The mount RETURNS the `GguiSessionChannelCookieAuth` binding the
 * composer threads into `createGguiSessionChannelServer`, so the
 * cookie minted here authenticates the live-channel WS upgrade.
 */

import type { CodeStore, GguiSessionStore, ShortCodeIndex } from "@ggui-ai/mcp-server-core";
import { deriveContractBundle } from "@ggui-ai/mcp-server-handlers/renders";
import {
  GGUI_RENDER_RESOURCE_MIME,
  GGUI_RENDER_RESOURCE_URI,
  MCP_APP_AI_GGUI_RENDER_META_KEY,
  type McpAppAiGguiRenderMeta,
} from "@ggui-ai/protocol/integrations/mcp-apps";
import type { Express, Request, Response } from "express";
import {
  CONSOLE_COOKIE_NAME,
  mintDevtoolCookie,
  readDevtoolCookieFromHeaders,
  verifyDevtoolCookie,
} from "./console-auth.js";
import { applyDevtoolSecurityHeaders } from "./console-headers.js";
import type { GguiSessionChannelCookieAuth } from "./ggui-session-channel.js";
import type { Logger } from "./logger.js";
import { GGUI_RENDER_SHELL_HTML } from "./mcp-apps-outbound.js";
import { singleParam } from "./route-param.js";

interface MountOptions {
  /** Express app to mount onto. */
  readonly app: Express;
  /** Shared HMAC secret backing the console cookie mint/verify pair. */
  readonly secret: string;
  /** shortCode → render binding the cookie-mint route resolves through. */
  readonly shortCodeIndex: ShortCodeIndex;
  /** Cookie TTL override (undefined → helper default, 8h). */
  readonly cookieTtlSec?: number;
  /** Mark the cookie Secure (TLS-terminating deployments). */
  readonly cookieSecure: boolean;
  /** GguiSession store the gate + observation routes read. */
  readonly renderStore?: GguiSessionStore;
  /** Live-mode credential minter (`mcpApps: true` at construction). */
  readonly mintBootstrap?: (
    sessionId: string,
    appId: string
  ) => { wsUrl: string; token: string; expiresAt: string };
  /** Runtime-bundle bootstrap URL (rewritten absolute on meta reads). */
  readonly runtimeBootstrapUrl: string;
  /** Content-addressable store for the validator-bundle emission. */
  readonly codeStore?: CodeStore;
  /** Operator-configured public origin for absolute URL composition. */
  readonly publicBaseUrl?: string;
  /** Parent logger; the mount derives its `console-cookie` child. */
  readonly logger: Logger;
}

/**
 * Mount the console session routes onto the express app and return
 * the cookie-auth binding for the live channel.
 */
export function mountConsoleSessionRoutes(opts: MountOptions): GguiSessionChannelCookieAuth {
  const {
    app,
    secret,
    shortCodeIndex,
    cookieTtlSec,
    cookieSecure,
    renderStore,
    mintBootstrap,
    runtimeBootstrapUrl,
    codeStore,
    publicBaseUrl,
    logger,
  } = opts;
  const cookieLogger = logger.child({
    component: "console-cookie",
  });

  app.post("/ggui/console/session-cookie", async (req: Request, res: Response) => {
    applyDevtoolSecurityHeaders(res);
    const body = (req.body ?? {}) as { shortCode?: unknown };
    if (typeof body.shortCode !== "string" || body.shortCode.length === 0) {
      res.status(400).json({
        error: "invalid_request",
        message: "`shortCode` (string) is required",
      });
      return;
    }
    let binding: Awaited<ReturnType<ShortCodeIndex["lookup"]>>;
    try {
      binding = await shortCodeIndex.lookup(body.shortCode);
    } catch (err) {
      cookieLogger.error("short_code_lookup_failed", {
        error: String(err),
      });
      res.status(500).json({ error: "internal_error" });
      return;
    }
    if (!binding) {
      res.status(404).json({
        error: "unknown_short_code",
        message: "Short-code does not resolve to any render on this server",
      });
      return;
    }
    const mint = mintDevtoolCookie({
      sessionId: binding.sessionId,
      appId: binding.appId,
      secret,
      ...(cookieTtlSec !== undefined ? { ttlSec: cookieTtlSec } : {}),
      secure: cookieSecure,
    });
    res.setHeader("Set-Cookie", mint.setCookieHeader);
    res.json({
      sessionId: mint.sessionId,
      appId: mint.appId,
      expiresAt: mint.expiresAt,
    });
  });

  /**
   * Shared auth + scope gate for the console render routes.
   * Returns the verified `(sessionId, appId)` pair on success or
   * `null` after writing an HTTP error response on failure.
   *
   * Internal — closure-scoped to the route block; not exported.
   */
  const gateDevtoolRenderRequest = async (
    req: Request,
    res: Response,
    explicitSessionId?: string
  ): Promise<{ sessionId: string; appId: string } | null> => {
    const sessionIdRaw = explicitSessionId !== undefined ? explicitSessionId : req.query["session"];
    if (typeof sessionIdRaw !== "string" || sessionIdRaw.length === 0) {
      res.status(400).json({
        error: "invalid_request",
        message:
          "`render` query parameter (or :sessionId path parameter on the meta route) is required",
      });
      return null;
    }
    const rawCookie = readDevtoolCookieFromHeaders(req.headers);
    if (!rawCookie) {
      res.status(401).json({
        error: "missing_cookie",
        message: `${CONSOLE_COOKIE_NAME} cookie required (mint via POST /ggui/console/session-cookie first)`,
      });
      return null;
    }
    const claims = verifyDevtoolCookie(rawCookie, secret);
    if (!claims) {
      res.status(401).json({
        error: "invalid_cookie",
        message: "Console cookie is invalid, expired, or for another server",
      });
      return null;
    }
    if (claims.sessionId !== sessionIdRaw) {
      res.status(403).json({
        error: "cookie_session_mismatch",
        message: `Console cookie is bound to render '${claims.sessionId}' but request targets '${sessionIdRaw}'`,
      });
      return null;
    }
    // GguiSession existence + appId match — even on the static-shell
    // route we honestly answer 404 instead of leaking an HTML blob
    // for a render the server doesn't know about.
    let render: Awaited<ReturnType<GguiSessionStore["get"]>> = null;
    if (renderStore) {
      try {
        render = await renderStore.get(claims.sessionId);
      } catch (err) {
        cookieLogger.error("render_resource_store_failed", {
          error: String(err),
          sessionId: claims.sessionId,
        });
        res.status(500).json({ error: "internal_error" });
        return null;
      }
    }
    if (!render) {
      res.status(404).json({
        error: "session_not_found",
        message: `GguiSession '${claims.sessionId}' is not on this server`,
      });
      return null;
    }
    if (render.appId !== claims.appId) {
      res.status(403).json({
        error: "app_mismatch",
        message: `Cookie bound to app '${claims.appId}' but render is on app '${render.appId}'`,
      });
      return null;
    }
    return { sessionId: claims.sessionId, appId: claims.appId };
  };

  // GET /ggui/console/session-resource?session=<sessionId>
  // → production thin-shell HTML, wrapped as a ResourceContents
  //   blob. NO inlined bootstrap — console fetches the bootstrap
  //   separately (route below) and replies to the iframe's
  //   `ui/initialize` postMessage with it.
  app.get("/ggui/console/session-resource", async (req: Request, res: Response) => {
    applyDevtoolSecurityHeaders(res);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    const verified = await gateDevtoolRenderRequest(req, res);
    if (!verified) return;
    res.status(200).json({
      contents: [
        {
          uri: GGUI_RENDER_RESOURCE_URI,
          mimeType: GGUI_RENDER_RESOURCE_MIME,
          text: GGUI_RENDER_SHELL_HTML,
        },
      ],
    });
  });

  // GET /ggui/console/sessions/:sessionId/meta
  // → slice-envelope JSON (`{ "ai.ggui/render": {...} }`, the same
  //   shape as the wire `_meta`). Required when the console is
  //   hosting the renderer in a srcdoc iframe and needs to feed
  //   the iframe a meta payload via `ui/initialize`. `mcpApps:
  //   true` is required (mintWsToken/mintBootstrap presence) —
  //   503 otherwise.
  app.get("/ggui/console/sessions/:sessionId/meta", async (req: Request, res: Response) => {
    applyDevtoolSecurityHeaders(res);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    const sessionIdFromPath = singleParam(req.params["sessionId"]);
    const verified = await gateDevtoolRenderRequest(req, res, sessionIdFromPath);
    if (!verified) return;
    if (!mintBootstrap) {
      res.status(503).json({
        error: "mcp_apps_disabled",
        message:
          "renders/:sessionId/meta requires mcpApps: true on the server so the renderer can receive a valid WS auth token. Enable `mcpApps` on createGguiServer() and retry.",
      });
      return;
    }
    const minted = mintBootstrap(verified.sessionId, verified.appId);
    // Console/srcdoc absolute-URL fix: `<McpAppIframe>`
    // mounts the resource via `srcdoc`, so the iframe's URL
    // is `about:srcdoc` and any relative URL would resolve
    // against that, not the dev server. Rewrite the
    // same-origin `runtimeUrl` to absolute based on the
    // request host. The `wsUrl` minted at server-boot
    // defaults to `ws://localhost/ws` — also rewrite that
    // to the request-host's actual host:port when its
    // hostname is `localhost`, so the iframe's WebSocket
    // open lands on the same listener. Operators who
    // configured a CDN / external `wsUrl` / `runtime.url`
    // are passed through unchanged.
    const requestHost = req.get("host") ?? "";
    const absoluteRendererUrl = /^https?:\/\//i.test(runtimeBootstrapUrl)
      ? runtimeBootstrapUrl
      : `${req.protocol}://${requestHost}${runtimeBootstrapUrl}`;
    let resolvedWsUrl = minted.wsUrl;
    try {
      const wsParsed = new URL(minted.wsUrl);
      if (
        (wsParsed.hostname === "localhost" || wsParsed.hostname === "127.0.0.1") &&
        requestHost.length > 0
      ) {
        const wsScheme = req.protocol === "https" ? "wss" : "ws";
        resolvedWsUrl = `${wsScheme}://${requestHost}${wsParsed.pathname}${wsParsed.search}`;
      }
    } catch {
      // Malformed `wsUrl` — leave it as-is so the renderer
      // surfaces the failure through its own bootstrap-failed
      // envelope rather than us silently rewriting a string
      // we don't understand.
    }
    // Content-addressable contract-validator bundle (#109) for
    // the active render. The renderer iframe's strict CSP
    // forbids the `new Function` codegen `ajv.compile()` needs,
    // so the server compiles + writes the bundle to its
    // CodeStore at render time and threads the URL here. The
    // iframe fetches the URL + dynamic-imports to resolve
    // validators. Best-effort: a missing bundle degrades to no
    // client-side validation; server-side `assertActionContract`
    // remains authoritative.
    let renderContractHash: string | undefined;
    let renderValidatorsUrl: string | undefined;
    if (renderStore && codeStore) {
      try {
        const stored = await renderStore.get(verified.sessionId);
        if (
          stored !== null &&
          stored.render.type !== "mcpApps" &&
          stored.render.type !== "system" &&
          typeof stored.render.componentCode === "string" &&
          stored.render.componentCode.length > 0
        ) {
          const bundle = await deriveContractBundle(stored.render);
          if (bundle) {
            await codeStore.put(bundle.contractHash, bundle.bundleSource);
            renderContractHash = bundle.contractHash;
            const baseForValidators = publicBaseUrl
              ? publicBaseUrl.replace(/\/$/, "")
              : `${req.protocol}://${requestHost}`;
            renderValidatorsUrl = `${baseForValidators}/contract/${bundle.contractHash}.js`;
          }
        }
      } catch (err) {
        cookieLogger.warn("render_meta_validators_failed", {
          error: String(err),
          sessionId: verified.sessionId,
        });
      }
    }
    // Slice-envelope response (Phase B: single ai.ggui/render
    // slice) — same shape as the wire `_meta` and the inline
    // `__GGUI_META__` global the `/r/<shortCode>` shell carries.
    // GguiSessionViewer parses with `parseMcpAppAiGguiRenderMeta`.
    const renderMeta: McpAppAiGguiRenderMeta = {
      sessionId: verified.sessionId,
      appId: verified.appId,
      runtimeUrl: absoluteRendererUrl,
      wsUrl: resolvedWsUrl,
      wsToken: minted.token,
      expiresAt: minted.expiresAt,
      ...(renderContractHash !== undefined && renderValidatorsUrl !== undefined
        ? {
            contractHash: renderContractHash,
            validatorsUrl: renderValidatorsUrl,
          }
        : {}),
    };
    res.status(200).json({
      [MCP_APP_AI_GGUI_RENDER_META_KEY]: renderMeta,
    });
  });

  // GET /ggui/console/session?session=<sessionId>
  // → `{render, eventSequence}` JSON.
  //
  // Console-only observation surface for `<GguiSessionViewer>` to mount
  // `<RenderInspector>`. The iframe owns the live WS subscription
  // + the bootstrap token (single-use), so the OUTER console DOM
  // has no live source for render data — without this endpoint
  // the inspector can't render contract / test-action panels.
  //
  // Failure modes:
  //   - 401 missing/invalid cookie · 403 cross-render/app · 404
  //     unknown render · 500 store failure (all delegated to
  //     `gateDevtoolRenderRequest`).
  //   - 503 if `renderStore` is not wired (zero-config server).
  //
  // Shape note: Phase B collapsed the prior session-stack array to
  // a single `GguiSession` row. The response now returns the resolved
  // `GguiSession` directly; console narrows on `render.type` before
  // passing into `<RenderInspector>` (which only accepts the
  // ComponentGguiSession variant since the inspector reads actionSpec /
  // streamSpec / propsSpec — fields McpAppsGguiSession doesn't carry).
  app.get("/ggui/console/session", async (req: Request, res: Response) => {
    applyDevtoolSecurityHeaders(res);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    const verified = await gateDevtoolRenderRequest(req, res);
    if (!verified) return;
    if (!renderStore) {
      res.status(503).json({
        error: "session_store_unavailable",
        message:
          "GguiSession observation requires renderChannel: true on the server so the render store is wired. Enable `renderChannel` on createGguiServer() and retry.",
      });
      return;
    }
    let stored: Awaited<ReturnType<GguiSessionStore["get"]>> = null;
    try {
      stored = await renderStore.get(verified.sessionId);
    } catch (err) {
      cookieLogger.error("render_store_failed", {
        error: String(err),
        sessionId: verified.sessionId,
      });
      res.status(500).json({ error: "internal_error" });
      return;
    }
    if (!stored) {
      // Race: gate verified existence above but the render
      // could expire between calls. Honest 404.
      res.status(404).json({
        error: "session_not_found",
        message: `GguiSession '${verified.sessionId}' is not on this server`,
      });
      return;
    }
    res.status(200).json({
      render: stored.render,
      eventSequence: stored.eventSequence,
    });
  });

  // Reference the cookie name to keep the export alive for
  // downstream consumers + lint. The name is the single source
  // of truth; avoid duplicating the string anywhere.
  cookieLogger.debug?.("console_cookie_ready", {
    cookieName: CONSOLE_COOKIE_NAME,
  });

  // Cookie-auth binding for the render channel — the composer
  // threads this into `createGguiSessionChannelServer`.
  return {
    readCookie: readDevtoolCookieFromHeaders,
    verify: (cookieValue: string) => verifyDevtoolCookie(cookieValue, secret),
  };
}
