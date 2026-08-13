/**
 * MCP wire endpoints — the JSON-RPC surfaces.
 *
 *   POST <universalMcpPath>            — DATA PLANE: agent+runtime tools
 *                                        (default `/mcp`)
 *   POST <pathPrefix>/:appId           — data plane, per-tenant variant
 *                                        (opt-in via `perAppRouting`)
 *   POST /control                      — CONTROL PLANE: design-time
 *                                        spec/discovery (anonymous) +
 *                                        operator management (authed)
 *   POST <service.path>                — isolated MCP services (path IS
 *                                        the audience)
 *   GET/DELETE on each                 — 405 (stateless server; no
 *                                        streaming continuation /
 *                                        session-terminate verbs)
 *
 * Every route shares ONE request pipeline (`makeMcpHandler`): resolve
 * identity via the AuthAdapter (anonymous surfaces synthesize a
 * builder identity on missing/invalid bearers), apply the per-app
 * authorize hook, build a fresh `McpServer` + Streamable HTTP
 * transport per request (stateless), and dispatch under the
 * AsyncLocalStorage-scoped `HandlerContext`. The difference between
 * routes is ONLY the handler set each exposes.
 *
 * Audience TAGS remain the normative caller-class declaration; what
 * they no longer do is mint one HTTP route each. `protocol` and `ops`
 * both mount on `/control` — see `./control-service.ts` for why (one
 * route carries one auth posture; the control plane needs two).
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
import {
  CONTROL_PATH,
  DATA_PLANE_AUDIENCES,
  filterHandlersByAudience,
} from "./control-service.js";
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

/**
 * Return shape for an `errorMapper` hook — a domain error mapped onto
 * an HTTP/JSON-RPC response triple, with optional response headers.
 *
 * `headers` is deliberately generic HTTP plumbing (e.g. `Retry-After`
 * on a `503`), not a deployment-specific concept — any operator
 * mapping a domain error to a status code that conventionally carries
 * a header can use it.
 */
export interface ErrorMapperResult {
  readonly status: number;
  readonly code: number;
  readonly message: string;
  /** Response headers to set before the JSON body is written. */
  readonly headers?: Readonly<Record<string, string>>;
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
  /** Full composed handler list (data-plane audience filtering happens here). */
  readonly handlers: ReadonlyArray<SharedHandler<ZodRawShape, ZodRawShape>>;
  /**
   * Control-plane handler set — already projected + wrapped by
   * `buildControlService`. Passed pre-built rather than filtered here
   * because the per-tool auth/confirm wrappers are composition, not
   * transport.
   */
  readonly controlHandlers: ReadonlyArray<SharedHandler<ZodRawShape, ZodRawShape>>;
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
  readonly errorMapper?: (err: unknown) => ErrorMapperResult | undefined;
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
 * Mount the data-plane (universal / per-app), control-plane, and
 * service MCP endpoints onto the express app. Returns nothing — the
 * routes self-register.
 */
export function mountMcpEndpoints(opts: MountOptions): void {
  const {
    app,
    logger,
    auth,
    info,
    handlers,
    controlHandlers,
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

  const makeMcpHandler =
    (
      routeHandlers: ReadonlyArray<SharedHandler<ZodRawShape, ZodRawShape>>,
      handlerOpts?: { readonly anonymous?: boolean; readonly rejectFederated?: boolean }
    ) =>
    async (req: Request, res: Response): Promise<void> => {
      const requestId =
        typeof req.headers["x-request-id"] === "string"
          ? req.headers["x-request-id"]
          : randomUUID();
      const reqLogger = logger.child({ requestId });

      // Auth is OPTIONAL on anonymous surfaces and REQUIRED otherwise.
      // Always attempt to resolve a presented credential: an anonymous
      // surface with a valid bearer still resolves to the real identity
      // (so it can offer authenticated capabilities — e.g. `/control`'s
      // ops tools, gated on `ctx.authSource`), while a missing or
      // unauthenticated credential falls back to the synthesized
      // anonymous builder so public reads (docs, protocol) work
      // bearer-less. Threading the resolved `source` onto the context is
      // what makes `'anonymous'` distinguishable from an authenticated
      // caller, per the `McpService.anonymous` contract — the identity
      // FIELDS are identical for both.
      let identity: AuthResult;
      try {
        identity = await resolveIdentity(auth, req);
      } catch (err) {
        if (err instanceof UnauthenticatedError) {
          if (handlerOpts?.anonymous) {
            identity = { identity: { kind: "builder" }, source: "anonymous" };
          } else {
            // Diagnostic: did a Bearer credential actually reach the pod on
            // this request? This splits "the client/transport never sent one"
            // from "we received it but the adapter rejected it" — otherwise
            // indistinguishable in `auth_failed`. Only a short, non-secret
            // prefix is logged (a JWT header is public), never the credential.
            const rawAuth = req.headers["authorization"];
            const authHeaderPresent =
              typeof rawAuth === "string" && rawAuth.length > 0;
            reqLogger.warn("auth_failed", {
              reason: err.message,
              authHeaderPresent,
              authHeaderPrefix: authHeaderPresent ? rawAuth.slice(0, 12) : null,
              // Bearer-stripped token length — a transit-truncation check
              // (compare against the minted length); never the credential.
              tokenLen: authHeaderPresent
                ? rawAuth.replace(/^Bearer\s+/i, "").length
                : 0,
              path: req.path,
            });
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

      // Control-plane guard: federated end-user identities
      // (source:'oidc', minted by the OIDC verify adapter) must never
      // reach the control plane — neither its operator half nor its
      // design-time spec half. Audience filtering only shapes
      // tools/list; it does NOT stop a direct tools/call, so this is a
      // route-level authorization gate that runs before MCP dispatch.
      if (handlerOpts?.rejectFederated && identity.source === "oidc") {
        reqLogger.warn("federated_identity_rejected", { route: req.path });
        res.status(403).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "federated identities are not permitted on this route" },
          id: null,
        });
        return;
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
        // How this request proved itself. The control plane's per-tool
        // auth gate reads it to refuse anonymous callers; no other
        // handler should branch on the specific mechanism.
        authSource: identity.source,
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
          let mapped: ErrorMapperResult | undefined;
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
            if (mapped.headers) res.set(mapped.headers);
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

  // Data plane — the subset of `handlers` whose `audience` tag
  // intersects ['agent','runtime']. Handlers without an explicit tag
  // default to ['agent'], so every untagged handler is agent-callable.
  const agentRouteHandlers = filterHandlersByAudience(handlers, DATA_PLANE_AUDIENCES);

  const agentMcpHandler = makeMcpHandler(agentRouteHandlers);
  // Control plane — anonymous-capable (design-time tools answer
  // bearer-less) with each ops tool re-imposing auth for itself.
  const controlMcpHandler = makeMcpHandler(controlHandlers, {
    anonymous: true,
    rejectFederated: true,
  });

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

  // /control — the control plane. Hosts every `audience: ['protocol']`
  // tool (design-time spec/discovery, anonymous) and every
  // `audience: ['ops']` tool (operator management, auth-gated per tool,
  // state-changing ones confirm-gated). Keeping both off the data plane
  // strips spec-discovery and account-management noise from the agent's
  // runtime `tools/list`.
  //
  // ALWAYS mounted — the control plane is part of what a ggui server
  // IS, not an opt-in. It is empty only when a deployment wired no
  // protocol- or ops-tagged handlers at all.
  app.post(CONTROL_PATH, controlMcpHandler);
  app.get(CONTROL_PATH, methodNotAllowed);
  app.delete(CONTROL_PATH, methodNotAllowed);

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
