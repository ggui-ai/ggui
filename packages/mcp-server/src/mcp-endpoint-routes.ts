/**
 * MCP wire endpoints — the JSON-RPC surfaces.
 *
 *   POST <universalMcpPath>            — DATA PLANE: agent+runtime tools
 *                                        (default `/mcp`)
 *   POST <pathPrefix>/:appId           — data plane, per-app variant
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

import { MCP_ERROR_CODES, isRecord, type JsonValue } from "@ggui-ai/protocol";
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

/** Per-app URL routing shape — mirrors `CreateGguiServerOptions.perAppRouting`. */
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
  /**
   * JSON-RPC 2.0 error `data` — any JSON value the deployment wants the
   * client to read alongside `code` / `message` (a structured reason, a
   * retry hint). Serialized verbatim on `error.data`; omitted from the
   * body when absent, so a mapper that never sets it changes nothing.
   */
  readonly data?: JsonValue;
}

/** The JSON-RPC error object a mapped result becomes on the wire. */
function jsonRpcError(mapped: ErrorMapperResult): { code: number; message: string; data?: JsonValue } {
  return {
    code: mapped.code,
    message: mapped.message,
    ...(mapped.data !== undefined ? { data: mapped.data } : {}),
  };
}

/** The two statuses an authorization refusal may carry — a mapper is bounded to them. */
const AUTHORIZATION_REFUSAL_STATUSES: ReadonlySet<number> = new Set([401, 403]);

/**
 * A deployment's error mapper may attach JSON-RPC `data` (and its own
 * `code` / `message` / headers) to a per-app authorization refusal, so a
 * client can read a structured reason instead of parsing prose. The
 * refusal stays a 401 or a 403: a mapper answering any other status, or
 * throwing, is ignored and logged, and the default-deny 403 stands
 * byte-identical to a deployment with no mapper at all.
 */
function mapAuthorizationRefusal(
  err: unknown,
  errorMapper: ((err: unknown) => ErrorMapperResult | undefined) | undefined,
  log: Logger,
): ErrorMapperResult | undefined {
  if (!errorMapper) return undefined;
  let mapped: ErrorMapperResult | undefined;
  try {
    mapped = errorMapper(err);
  } catch (mapperErr) {
    log.warn("error_mapper_failed", { error: String(mapperErr) });
    return undefined;
  }
  if (mapped === undefined) return undefined;
  if (!AUTHORIZATION_REFUSAL_STATUSES.has(mapped.status)) {
    log.warn("per_app_authorize_mapper_out_of_bounds", { status: mapped.status });
    return undefined;
  }
  return mapped;
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
  /**
   * The control plane's ops-tool name set (captured by
   * `buildControlService` before audience-stripping). Drives the
   * transport-level anonymous-ops OAuth challenge (ggui#505).
   */
  readonly controlOpsToolNames: ReadonlySet<string>;
  /** Validated isolated-service list (`validateMcpServices` output). */
  readonly mcpServices: ReadonlyArray<McpService>;
  /** Request-scoped HandlerContext storage shared with the handlers. */
  readonly als: AsyncLocalStorage<HandlerContext>;
  /** Identity → appId resolution rule (SPEC §12.2). */
  readonly appIdFromIdentity: (result: AuthResult) => string;
  /** Universal endpoint path (default `/mcp`; a deployment may serve it at `/`). */
  readonly universalMcpPath: string;
  /** Per-app endpoint shape — absent = universal-only deployment. */
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
    controlOpsToolNames,
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
   * OAuth auto-negotiation for the control plane (ggui#505): the first
   * tool name in the request body that is an ops tool, or `null` when
   * the request contains none. JSON-RPC bodies may be a single message
   * or a batch; a batch containing ANY ops call challenges as a whole
   * (mixed anonymous batches are not a supported shape).
   *
   * External-boundary narrowing via `isRecord` — the body is unvalidated
   * wire input here; the MCP transport re-validates after dispatch.
   */
  const findOpsToolCall = (body: unknown, opsToolNames: ReadonlySet<string>): string | null => {
    const messages = Array.isArray(body) ? body : [body];
    for (const m of messages) {
      if (!isRecord(m) || m.method !== "tools/call" || !isRecord(m.params)) continue;
      const name = m.params.name;
      if (typeof name === "string" && opsToolNames.has(name)) return name;
    }
    return null;
  };

  const makeMcpHandler =
    (
      routeHandlers: ReadonlyArray<SharedHandler<ZodRawShape, ZodRawShape>>,
      handlerOpts?: {
        readonly anonymous?: boolean;
        readonly rejectFederated?: boolean;
        /**
         * Ops-tool names that CHALLENGE anonymous callers at the
         * transport (ggui#505): an anonymous `tools/call` naming one
         * of these gets HTTP 401 + `WWW-Authenticate` pointing at the
         * control plane's RFC 9728 metadata, so standards hosts
         * auto-negotiate OAuth. Everything else on the route
         * (initialize, tools/list, protocol tools) stays
         * anonymous-capable — the mixed-audience posture survives.
         * The per-tool `withAuthGate` remains as defense-in-depth.
         */
        readonly anonymousOpsChallenge?: ReadonlySet<string>;
      }
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
            // Diagnostic: did a Bearer credential actually reach the server on
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
              error: { code: MCP_ERROR_CODES.UNAUTHORIZED, message: err.message },
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
          error: {
            code: MCP_ERROR_CODES.UNAUTHORIZED,
            message: "federated identities are not permitted on this route",
          },
          id: null,
        });
        return;
      }

      // OAuth auto-negotiation (ggui#505) — anonymous ops calls get a
      // transport 401 BEFORE dispatch, with the standards trigger in
      // the header AND the actionable guidance agents read in the
      // body. Runs only when the route opted in (the control plane)
      // and only for resolved-anonymous callers naming an ops tool —
      // every other message on the route keeps the anonymous-capable
      // design-time posture. This makes the documented
      // AuthRequiredError→401 mapping observable at the transport; the
      // per-tool auth gate stays as defense-in-depth for any path that
      // reaches dispatch.
      if (handlerOpts?.anonymousOpsChallenge !== undefined && identity.source === "anonymous") {
        const opsToolName = findOpsToolCall(req.body, handlerOpts.anonymousOpsChallenge);
        if (opsToolName !== null) {
          reqLogger.info("anonymous_ops_call_challenged", { tool: opsToolName });
          if (oauthEnabled) {
            res.setHeader(
              "WWW-Authenticate",
              buildWwwAuthenticate(resolveIssuerUrl(req, oauthIssuerUrl), CONTROL_PATH)
            );
          }
          res.status(401).json({
            jsonrpc: "2.0",
            error: {
              code: MCP_ERROR_CODES.UNAUTHORIZED,
              message:
                `${opsToolName} is an operator tool and needs an authenticated caller. ` +
                `Present a bearer token this deployment accepts, or complete the OAuth flow ` +
                `advertised in WWW-Authenticate (universal connector keys come from the ` +
                `console: Connector keys → New key, leave the app unset).`,
            },
            id: null,
          });
          return;
        }
      }

      // Per-app URL routing. When `perAppRouting`
      // is configured AND the request matched the per-app path
      // `/:${paramName}/mcp`, Express populates `req.params[paramName]`
      // with the validated app id. Use it as `ctx.appId` for this
      // request, overriding `appIdFromIdentity`. The universal `/mcp`
      // route doesn't have the param so it falls through to the
      // identity-based resolution.
      const urlAppId =
        perAppRouting !== undefined ? req.params[perAppRouting.paramName] : undefined;
      const hasUrlAppId = typeof urlAppId === "string" && urlAppId.length > 0;

      // Per-app authorize hook — when the deployment configured
      // `perAppRouting.authorize` AND the request matched the per-app
      // path, invoke the callback. Throwing refuses before the MCP
      // handler ever sees the request, which is the boundary that
      // prevents cross-user blueprint reads when a deployment's own tools bypass
      // AppSync owner-auth via raw DDB. Universal-endpoint requests
      // skip this entirely (no urlAppId). The deployment's `errorMapper`
      // may give the refusal a structured JSON-RPC `data` (bounded to
      // 401 / 403, see `mapAuthorizationRefusal`); otherwise — and for
      // every mapping outside those bounds — the default-deny 403 stands.
      if (hasUrlAppId && perAppRouting?.authorize) {
        try {
          await perAppRouting.authorize(urlAppId, identity);
        } catch (err) {
          reqLogger.warn("per_app_authorize_denied", {
            urlAppId,
            reason: err instanceof Error ? err.message : String(err),
          });
          const mapped = mapAuthorizationRefusal(err, errorMapper, reqLogger);
          if (mapped?.headers) res.set(mapped.headers);
          res.status(mapped?.status ?? 403).json({
            jsonrpc: "2.0",
            // #836: a first-party server never answers -32000 — that is the SDK
            // client's own ConnectionClosed number, so a refusal and a dropped
            // socket would read the same. An authorization refusal is UNAUTHORIZED.
            error: mapped
              ? jsonRpcError(mapped)
              : { code: MCP_ERROR_CODES.UNAUTHORIZED, message: "Unauthorized" },
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
        // fields: `apiKeyHash` for kind=app, `userId` for kind=user.
        // Threading them onto HandlerContext here means a deployment's own
        // handlers (per-key metering, per-user scoping) can read identity
        // directly without a parallel context shape; the handlers this
        // package ships ignore both fields.
        ...(identity.identity.kind === "app" ? { apiKeyHash: identity.identity.apiKeyHash } : {}),
        ...(identity.identity.kind === "user" ? { userId: identity.identity.userId } : {}),
        // What the credential itself may act on, when the adapter
        // distinguishes credential scopes. Identity-independent by
        // design: one account can present a key bound to a single app
        // on one request and an account-wide key on the next, and the
        // resolved userId is the same string both times — so the scope
        // has to ride the request, not be re-derived from the identity.
        ...(identity.credentialScope !== undefined
          ? { credentialScope: identity.credentialScope }
          : {}),
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
              error: jsonRpcError(mapped),
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
    // The control service captures this set BEFORE stripAudience
    // erases the tags — filtering `controlHandlers` here would yield
    // an empty set and silently disable the challenge (ggui#505).
    anonymousOpsChallenge: controlOpsToolNames,
  });

  // Universal endpoint — `appId` resolved from the auth identity via
  // `appIdFromIdentity`. A deployment's auth adapter may resolve it
  // (e.g. to the user's default app); without one it falls through to
  // userId / DEFAULT_BUILDER_APP_ID.
  //
  // Path defaults to `/mcp` (Streamable HTTP convention). A deployment
  // whose hostname already says "mcp" may serve it at `/` so the
  // bare-root URL is the universal endpoint — no path repeat.
  // Exposes audience tags ['agent', 'runtime'] — runtime tools stay
  // routable on the same endpoint but invisible to the agent's
  // `tools/list` via the `_meta.ui.visibility: ['app']` filter.
  app.post(universalMcpPath, agentMcpHandler);

  // Per-app endpoint — only mounted when the deployment opts in
  // via `perAppRouting`. The same handler reads `req.params[paramName]`
  // and uses it as `ctx.appId` for the request.
  //
  // When `pathPrefix` is set, the route mounts at
  // `${pathPrefix}/:${paramName}` — e.g. `/apps`, so URLs read
  // `<host>/apps/<appId>`. The prefix segments per-app traffic
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
