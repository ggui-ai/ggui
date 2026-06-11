/**
 * MCP wire endpoints — the audience-routed JSON-RPC surfaces.
 *
 *   POST <universalMcpPath>            — agent+runtime tools (default `/mcp`)
 *   POST <pathPrefix>/:appId           — per-tenant variant (opt-in via
 *                                        `perAppRouting`)
 *   POST /protocol                     — design-time spec/discovery tools
 *   POST /ops                          — operator-class management tools
 *   POST <service.path>                — isolated MCP services (path IS
 *                                        the audience)
 *   GET/DELETE on each                 — 405 (stateless server; no
 *                                        streaming continuation /
 *                                        session-terminate verbs)
 *
 * Every route shares ONE request pipeline (`makeMcpHandler`): resolve
 * identity via the AuthAdapter (anonymous services synthesize a
 * builder identity on missing/invalid bearers), apply the per-app
 * authorize hook, build a fresh `McpServer` + Streamable HTTP
 * transport per request (stateless), and dispatch under the
 * AsyncLocalStorage-scoped `HandlerContext`. The difference between
 * routes is ONLY the handler set each exposes.
 *
 * See `docs/development/audience-routes.md` for the audience taxonomy
 * (`agent` / `runtime` / `protocol` / `ops`) and the wire-name prefix
 * rules.
 */

import type { AuthAdapter, AuthResult } from "@ggui-ai/mcp-server-core";
import type { HandlerContext, SharedHandler } from "@ggui-ai/mcp-server-handlers";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Express, Request, Response } from "express";
import type { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { ZodRawShape } from "zod";
import { resolveIdentity, UnauthenticatedError } from "./auth.js";
import { buildMcpServer, type BuildMcpServerOptions, type ServerInfo } from "./build-mcp.js";
import type { Logger } from "./logger.js";
import type { McpService } from "./mcp-mounts.js";
import { buildWwwAuthenticate, resolveIssuerUrl } from "./oauth.js";

/** Per-tenant URL routing shape — mirrors `CreateGguiServerOptions.perAppRouting`. */
interface PerAppRouting {
  readonly paramName: string;
  readonly paramPattern: string;
  readonly pathPrefix?: string;
  readonly authorize?: (urlAppId: string, identity: AuthResult) => Promise<void>;
}

interface MountOptions {
  /** Express app to mount onto. */
  readonly app: Express;
  /** Structured logger; per-request children carry `requestId`. */
  readonly logger: Logger;
  /** Auth adapter every route resolves bearers against. */
  readonly auth: AuthAdapter;
  /** Server identity forwarded to every per-request `buildMcpServer`. */
  readonly info: ServerInfo;
  /** Full composed handler list (audience filtering happens here). */
  readonly handlers: ReadonlyArray<SharedHandler<ZodRawShape, ZodRawShape>>;
  /** Validated isolated-service list (`validateMcpServices` output). */
  readonly mcpServices: ReadonlyArray<McpService>;
  /** Request-scoped HandlerContext storage shared with the handlers. */
  readonly als: AsyncLocalStorage<HandlerContext>;
  /** Identity → appId resolution rule (SPEC §12.2). */
  readonly appIdFromIdentity: (result: AuthResult) => string;
  /** Universal endpoint path (default `/mcp`; cloud overrides to `/`). */
  readonly universalMcpPath: string;
  /** Per-tenant endpoint shape — absent = universal-only deployment. */
  readonly perAppRouting?: PerAppRouting;
  /** Whether OAuth is enabled (adds `WWW-Authenticate` on 401). */
  readonly oauthEnabled: boolean;
  /** Operator-configured issuer URL override (OAuth). */
  readonly oauthIssuerUrl?: string;
  /** Operator-supplied error → HTTP/JSON-RPC mapping hook. */
  readonly errorMapper?: (
    err: unknown
  ) => { readonly status: number; readonly code: number; readonly message: string } | undefined;
  /**
   * Per-boot `buildMcpServer` options. Assembled once by the composer
   * (every input is fixed at composition time); the handler spreads a
   * fresh object per request so the builder never sees a shared
   * mutable reference.
   */
  readonly buildMcpOptions: BuildMcpServerOptions;
}

/**
 * Resolve the resource path that `WWW-Authenticate` should point at
 * for the current request. Per-app `/mcp` requests
 * get `${pathPrefix}/${appId}` so RFC 9728 discovery resolves to the
 * per-app metadata; universal-route requests get `''` which collapses
 * back to the universal `${issuer}/.well-known/oauth-protected-resource`.
 *
 * Defense in depth: even when `perAppRouting` is configured, we
 * reject empty or whitespace-only `appId` values rather than emitting
 * an obviously-wrong `${pathPrefix}//.well-known/...` URL — falling
 * back to universal is the safer behavior.
 */
function resolveWwwAuthResourcePath(
  req: Request,
  perAppRouting: PerAppRouting | undefined
): string {
  if (perAppRouting === undefined) return "";
  const { paramName, pathPrefix = "" } = perAppRouting;
  const appId = req.params[paramName];
  if (typeof appId !== "string" || appId.length === 0) return "";
  return `${pathPrefix}/${appId}`;
}

/**
 * Mount the universal / per-app / protocol / ops / service MCP
 * endpoints onto the express app. Returns nothing — the routes
 * self-register.
 */
export function mountMcpEndpoints(opts: MountOptions): void {
  const {
    app,
    logger,
    auth,
    info,
    handlers,
    mcpServices,
    als,
    appIdFromIdentity,
    universalMcpPath,
    perAppRouting,
    oauthEnabled,
    oauthIssuerUrl,
    errorMapper,
    buildMcpOptions,
  } = opts;

  /**
   * Audience filter — returns the subset of `handlers` whose
   * `audience` tag intersects `allowed`. Read on route mounting so
   * each MCP route exposes only its audience's tools.
   *
   * Handlers with `audience: undefined` default to ['agent'] — every
   * such handler is agent-runtime callable.
   */
  const filterHandlersByAudience = (
    set: ReadonlyArray<SharedHandler<ZodRawShape, ZodRawShape>>,
    allowed: ReadonlyArray<"agent" | "runtime" | "protocol" | "ops">
  ): ReadonlyArray<SharedHandler<ZodRawShape, ZodRawShape>> =>
    set.filter((h) => {
      const tags = h.audience ?? (["agent"] as const);
      return tags.some((t) => allowed.includes(t));
    });

  const makeMcpHandler =
    (
      routeHandlers: ReadonlyArray<SharedHandler<ZodRawShape, ZodRawShape>>,
      handlerOpts?: { readonly anonymous?: boolean }
    ) =>
    async (req: Request, res: Response): Promise<void> => {
      const requestId =
        typeof req.headers["x-request-id"] === "string"
          ? req.headers["x-request-id"]
          : randomUUID();
      const reqLogger = logger.child({ requestId });

      // Auth is OPTIONAL on anonymous services and REQUIRED otherwise.
      // Always attempt to resolve a presented credential: an anonymous
      // service with a valid bearer still resolves to the real identity
      // (so it can offer authenticated capabilities — e.g. `/dev`'s ops
      // tools read `ctx.userId`), while a missing/unauthenticated
      // credential falls back to the synthesized anonymous builder so
      // public reads (docs, protocol) work bearer-less. This is what makes
      // `source: 'anonymous'` distinguishable from an authenticated caller,
      // per the `McpService.anonymous` contract — resolving a present
      // bearer is the only way a handler can tell the two apart.
      let identity: AuthResult;
      try {
        identity = await resolveIdentity(auth, req);
      } catch (err) {
        if (err instanceof UnauthenticatedError) {
          if (handlerOpts?.anonymous) {
            identity = { identity: { kind: "builder" }, source: "anonymous" };
          } else {
            reqLogger.warn("auth_failed", { reason: err.message });
            // OAuth-discovery clients (Claude Desktop, claude.ai, etc.)
            // read this header to find the resource-metadata URL and
            // begin the OAuth dance. Pure-bearer clients ignore it.
            //
            // Per-app routes point at the per-app resource-metadata
            // document so RFC 9728 discovery resolves
            // to a per-app `resource` URL. Universal routes keep the
            // bare metadata path.
            if (oauthEnabled) {
              const wwwAuthResourcePath = resolveWwwAuthResourcePath(req, perAppRouting);
              res.setHeader(
                "WWW-Authenticate",
                buildWwwAuthenticate(resolveIssuerUrl(req, oauthIssuerUrl), wwwAuthResourcePath)
              );
            }
            res.status(401).json({
              jsonrpc: "2.0",
              error: { code: -32000, message: err.message },
              id: null,
            });
            return;
          }
        } else {
          reqLogger.error("auth_unexpected_error", { error: String(err) });
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          });
          return;
        }
      }

      // Per-tenant URL routing. When `perAppRouting`
      // is configured AND the request matched the per-app path
      // `/:${paramName}/mcp`, Express populates `req.params[paramName]`
      // with the validated tenant id. Use it as `ctx.appId` for this
      // request, overriding `appIdFromIdentity`. The universal `/mcp`
      // route doesn't have the param so it falls through to the
      // identity-based resolution.
      const urlAppId =
        perAppRouting !== undefined ? req.params[perAppRouting.paramName] : undefined;
      const hasUrlAppId = typeof urlAppId === "string" && urlAppId.length > 0;

      // Per-app authorize hook — when the deployment configured
      // `perAppRouting.authorize` AND the request matched the per-app
      // path, invoke the callback. Throwing collapses to a 403 before
      // the MCP handler ever sees the request, which is the boundary
      // that prevents cross-user blueprint reads when pod tools bypass
      // AppSync owner-auth via raw DDB. Universal-endpoint requests
      // skip this entirely (no urlAppId).
      if (hasUrlAppId && perAppRouting?.authorize) {
        try {
          await perAppRouting.authorize(urlAppId, identity);
        } catch (err) {
          reqLogger.warn("per_app_authorize_denied", {
            urlAppId,
            reason: err instanceof Error ? err.message : String(err),
          });
          res.status(403).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Forbidden" },
            id: null,
          });
          return;
        }
      }

      const ctx: HandlerContext = {
        appId: hasUrlAppId ? urlAppId : appIdFromIdentity(identity),
        requestId,
        // Identity is the canonical source of two mutually-exclusive
        // hosted fields: `apiKeyHash` for kind=app, `userId` for kind=user.
        // Threading them onto HandlerContext here means hosted handlers
        // (the K8s ggui-protocol pod's billing gate + per-user blueprint
        // scoping) can read identity directly without a parallel pod-only
        // context shape; OSS handlers continue to ignore both fields.
        ...(identity.identity.kind === "app" ? { apiKeyHash: identity.identity.apiKeyHash } : {}),
        ...(identity.identity.kind === "user" ? { userId: identity.identity.userId } : {}),
      };
      reqLogger.debug?.("mcp_request", { appId: ctx.appId });

      const mcp = buildMcpServer(info, routeHandlers, () => als.getStore() ?? ctx, reqLogger, {
        ...buildMcpOptions,
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      res.on("close", () => {
        transport.close().catch(() => undefined);
        mcp.close().catch(() => undefined);
      });

      try {
        await mcp.connect(transport);
        await als.run(ctx, () => transport.handleRequest(req, res, req.body));
      } catch (err) {
        reqLogger.error("mcp_handle_failed", { error: String(err) });
        if (!res.headersSent) {
          let mapped:
            | { readonly status: number; readonly code: number; readonly message: string }
            | undefined;
          if (errorMapper) {
            try {
              mapped = errorMapper(err);
            } catch (mapperErr) {
              // Defensive: a thrown mapper degrades to the default 500
              // rather than letting the inner failure escape the handler.
              reqLogger.warn("error_mapper_failed", {
                error: String(mapperErr),
              });
            }
          }
          if (mapped) {
            res.status(mapped.status).json({
              jsonrpc: "2.0",
              error: { code: mapped.code, message: mapped.message },
              id: null,
            });
          } else {
            res.status(500).json({
              jsonrpc: "2.0",
              error: { code: -32603, message: "Internal server error" },
              id: null,
            });
          }
        }
      }
    };

  const methodNotAllowed = (_req: Request, res: Response): void => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed (stateless server).",
      },
      id: null,
    });
  };

  // Three audience-filtered handler sets. Each set is the
  // subset of `handlers` whose `audience` tag intersects the route's
  // allowed list. Handlers without an explicit tag default to
  // ['agent'] — every such handler is agent-runtime callable.
  const agentRouteHandlers = filterHandlersByAudience(handlers, ["agent", "runtime"]);
  const protocolRouteHandlers = filterHandlersByAudience(handlers, ["protocol"]);
  const opsRouteHandlers = filterHandlersByAudience(handlers, ["ops"]);

  const agentMcpHandler = makeMcpHandler(agentRouteHandlers);
  const protocolMcpHandler = makeMcpHandler(protocolRouteHandlers);
  const opsMcpHandler = makeMcpHandler(opsRouteHandlers);

  // Universal endpoint — `appId` resolved from the auth identity via
  // `appIdFromIdentity`. Cloud `mcp.ggui.ai` deployments resolve this
  // to `User.defaultAppId` via the auth-adapter; OSS deployments fall
  // through to userId / DEFAULT_BUILDER_APP_ID.
  //
  // Path defaults to `/mcp` (Streamable HTTP convention). Cloud
  // `mcp.ggui.ai` overrides to `/` so the bare-root URL is the
  // universal endpoint — domain already says "mcp", no path repeat.
  // Exposes audience tags ['agent', 'runtime'] — runtime tools stay
  // routable on the same endpoint but invisible to the agent's
  // `tools/list` via the `_meta.ui.visibility: ['app']` filter.
  app.post(universalMcpPath, agentMcpHandler);

  // Per-tenant endpoint — only mounted when the deployment opts in
  // via `perAppRouting`. The same handler reads `req.params[paramName]`
  // and uses it as `ctx.appId` for the request.
  //
  // When `pathPrefix` is set, the route mounts at
  // `${pathPrefix}/:${paramName}` — cloud uses `/apps` so URLs are
  // `mcp.ggui.ai/apps/<appId>`. The prefix segments per-tenant traffic
  // from system routes (`/health`, `/oauth/*`, `/.well-known/*`,
  // `/r/*`) so an opaque appId can never shadow a future static path.
  //
  // Without `pathPrefix`, the route mounts bare. The `paramPattern`
  // constraint is the only collision defense — fine when the pattern
  // guarantees non-collision (e.g. UUIDs).
  //
  // `path-to-regexp` v8 (express@5) dropped the `:param(pattern)`
  // inline-regex syntax, so the pattern is enforced via a single
  // `app.param` validator (anchored full-match) rather than baked into
  // the route string. Registered once here; Express resolves it at
  // dispatch for EVERY route declaring `paramName` — the per-app
  // well-known route in the OAuth family AND this MCP route —
  // regardless of registration order. A value failing the pattern
  // 404s before any handler runs.
  if (perAppRouting !== undefined) {
    const { paramName, paramPattern, pathPrefix } = perAppRouting;
    const appIdPattern = new RegExp(`^(?:${paramPattern})$`);
    app.param(paramName, (_req, res, next, val) => {
      if (typeof val !== "string" || !appIdPattern.test(val)) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      next();
    });
    const route = pathPrefix !== undefined ? `${pathPrefix}/:${paramName}` : `/:${paramName}`;
    app.post(route, agentMcpHandler);
  }

  // /protocol — design-time spec/discovery surface.
  // Hosts the `audience: ['protocol']` tools (`ggui_describe_*`,
  // `ggui_get_example_blueprints`, `ggui_validate_blueprint`,
  // `ggui_list_available_primitives`, `ggui_get_blueprint_boilerplate`).
  // Strips spec-discovery noise off the agent's runtime `tools/list`
  // — agents that need format docs hit `/protocol` explicitly.
  // Always mounted; the route has the same auth chain as `/mcp` for
  // v1 (operators MAY narrow auth in their own middleware later).
  // Empty when the deployment didn't wire any protocol-tagged handlers.
  app.post("/protocol", protocolMcpHandler);
  app.get("/protocol", methodNotAllowed);
  app.delete("/protocol", methodNotAllowed);

  // /ops — operator-class management surface. Hosts the
  // `audience: ['ops']` tools (`ggui_set_provider_key`, `ggui_get_credit_balance`,
  // etc.). Always mounted; same auth chain as `/mcp`. Empty when the
  // deployment didn't wire any ops-tagged handlers.
  app.post("/ops", opsMcpHandler);
  app.get("/ops", methodNotAllowed);
  app.delete("/ops", methodNotAllowed);

  // Isolated MCP services — each at its own HTTP path with its own
  // tool namespace. Bypasses audience filtering (the path IS the
  // audience). Each service builds its own MCP request handler via
  // `makeMcpHandler(svc.handlers)`, reusing the same auth chain +
  // identity-resolution as the canonical routes — the difference is
  // ONLY the handler set the route exposes.
  //
  // Validation already ran in the composer via `validateMcpServices`;
  // here we just iterate the validated list.
  for (const svc of mcpServices) {
    // `anonymous: true` skips the auth chain and synthesizes a
    // builder-kind identity with `source: 'anonymous'`. Default
    // (undefined / false) preserves the auth-required posture of
    // every canonical route.
    const svcMcpHandler = makeMcpHandler(
      svc.handlers,
      svc.anonymous ? { anonymous: true } : undefined
    );
    app.post(svc.path, svcMcpHandler);
    app.get(svc.path, methodNotAllowed);
    app.delete(svc.path, methodNotAllowed);
  }

  app.get(universalMcpPath, methodNotAllowed);
  app.delete(universalMcpPath, methodNotAllowed);
}
