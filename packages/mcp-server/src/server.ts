/**
 * createGguiServer — build a runnable open MCP server.
 *
 * Composition:
 *
 *   - `@ggui-ai/mcp-server-handlers/blueprints` — the three blueprint-read
 *     handlers (search / list_featured / render), shared with hosted
 *     closed-runtime servers. If you want more tools, extract the next
 *     family into `@ggui-ai/mcp-server-handlers` and pass it via
 *     `handlers:`.
 *
 *   - `@ggui-ai/mcp-server-core/in-memory` — default backing adapters
 *     (vectors, embedding, auth). Real persistence bindings ship in
 *     later packages (sqlite / postgres / redis) and plug into the
 *     same interfaces.
 *
 *   - `@modelcontextprotocol/sdk` — `McpServer` + `StreamableHTTPServerTransport`
 *     matching the MCP wire spec. Fresh transport + fresh server per
 *     request (stateless); response close tears both down.
 *
 * Transport:
 *
 *   POST /mcp             — MCP Streamable HTTP wire protocol (JSON-RPC).
 *   GET  /ggui/health     — unauthenticated liveness, returns
 *                           `{status, server, version, tools, ...}`.
 *   GET  /ggui/auth-check — authenticated liveness. 204 when the bearer
 *                           token resolves via the configured AuthAdapter,
 *                           401 otherwise. Pairs with `/ggui/health` so
 *                           clients (e.g. Portal settings) can distinguish
 *                           `reachable` from `token-invalid` without
 *                           opening a full MCP session just to probe.
 *   GET/DELETE /mcp       — 405 (stateless server doesn't support the
 *                           streaming continuation / session-terminate verbs).
 *
 * Zero-config boot: omit every option and you get an in-memory server
 * accepting any bearer token (dev mode) with the blueprint-read
 * handlers wired up. The `Logger.warn('dev_mode_auth_enabled')` fires
 * once at boot so operators see the shape they're running.
 */

import { CONSOLE_DIST_DIR } from "@ggui-ai/console/server";
import { RUNTIME_BUNDLE_FILE, RUNTIME_BUNDLE_URL_PATH } from "@ggui-ai/iframe-runtime/server";
import type {
  AppMetadataStore,
  AuditSink,
  AuthAdapter,
  AuthResult,
  BlueprintIndex,
  BlueprintProvider,
  BlueprintSearch,
  BlueprintSelector,
  BlueprintStore,
  CodeStore,
  ConnectorRegistry,
  EmbeddingProvider,
  GeneratorRegistry,
  KeyValueStore,
  PairingService,
  PendingEventConsumer,
  ProviderKeyStore,
  RateLimiter,
  GguiSessionStore,
  GguiSessionStreamBuffer,
  ShortCodeIndex,
  TelemetrySink,
  ThreadStore,
  VectorStore,
} from "@ggui-ai/mcp-server-core";
import {
  createDeterministicBlueprintSelector,
  isTokenRegisteringAuthAdapter,
  mintSessionToken,
  mintWsToken,
  refreshWsToken,
  verifyToken,
} from "@ggui-ai/mcp-server-core";
import {
  createInMemoryBlueprintSearch,
  createInMemoryGeneratorRegistry,
  FixedWindowRateLimiter,
  InMemoryActiveConsumerRegistry,
  InMemoryAppMetadataStore,
  InMemoryAuthAdapter,
  InMemoryBlueprintIndex,
  InMemoryBlueprintStore,
  InMemoryKeyValueStore,
  InMemoryPairingService,
  InMemoryPendingEventConsumer,
  InMemoryQuotaStore,
  InMemoryGguiSessionStore,
  InMemoryGguiSessionStreamBuffer,
  InMemoryVectorStore,
  MockEmbeddingProvider,
  NoopAuditSink,
  NoopRateLimiter,
  NoopTelemetrySink,
} from "@ggui-ai/mcp-server-core/in-memory";
import type { HandlerContext, SharedHandler } from "@ggui-ai/mcp-server-handlers";
import {
  createGguiListGadgetsHandler,
  createGguiListThemesHandler,
  type ThemeCatalogEntry,
} from "@ggui-ai/mcp-server-handlers/app-discovery";
import {
  createDescribeBlueprintFormatHandler,
  createDescribeDataContractFormatHandler,
  createGetBlueprintBoilerplateHandler,
  createGetExampleBlueprintsHandler,
  createListAvailablePrimitivesHandler,
  createListFeaturedBlueprintsHandler,
  createRenderBlueprintHandler,
  createSearchBlueprintsHandler,
  createValidateBlueprintHandler,
} from "@ggui-ai/mcp-server-handlers/blueprints";
import {
  createGguiOpsDeleteBlueprintHandler,
  createGguiOpsGenerateBlueprintHandler,
  createGguiOpsListBlueprintsHandler,
  createGguiOpsRegisterBlueprintHandler,
  createGguiOpsUpdateBlueprintHandler,
} from "@ggui-ai/mcp-server-handlers/ops-blueprint";
import { setCacheTraceSink, setPayloadTraceSink } from "@ggui-ai/mcp-server-handlers/renders";
import type { OperatorConfig, ThemeConfig } from "@ggui-ai/project-config";
import type { DiscoveredPrimitiveCatalog, LoadedTheme } from "@ggui-ai/project-config/node";
import { loadTheme } from "@ggui-ai/project-config/node";
import type { Blueprint, GguiLifecyclePayload } from "@ggui-ai/protocol";
import { LIFECYCLE_CHANNEL } from "@ggui-ai/protocol";
import { setLlmTraceSink } from "@ggui-ai/ui-gen/harness/llm-trace-sink";
import { setValidatorTraceSink } from "@ggui-ai/ui-gen/harness/validator-trace-sink";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import express, { type Express, type Request } from "express";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { Server as NodeHttpServer } from "node:http";
import path from "node:path";
import type { ZodRawShape } from "zod";
import { BoundedCacheTraceSink, mountConsoleCacheRoutes } from "./console-cache.js";
import { applyDevtoolSecurityHeaders } from "./console-headers.js";
import { BoundedLlmTraceSink, mountConsoleLlmTraceRoutes } from "./console-llm-trace.js";
import { BoundedPayloadTraceSink, mountConsolePayloadsRoutes } from "./console-payloads.js";
import {
  mountDevtoolThemeRoutes,
  type ThemeFileUploader,
  type ThemeWriter,
} from "./console-theme-routes.js";
import { mountConsoleTimelineRoutes } from "./console-timeline.js";
import { BoundedValidatorTraceSink, mountConsoleValidatorRoutes } from "./console-validator.js";
// Operator-class MCP handlers — twelve `ggui_ops_*` handlers across
// four domains (apps / orgs / connector-keys / coupon). Every factory
// binds a deps seam; deployments that don't wire the seam simply
// don't register the tool (matching `ggui_ops_get_credit_balance`'s
// pattern).
import {
  createCreateAppHandler,
  createDeleteAppHandler,
  createListAppsHandler,
  createRenameAppHandler,
  createSetDefaultAppHandler,
  createUpdateAppSystemPromptHandler,
  type AppsSource,
  type UserDefaultAppSource,
} from "@ggui-ai/mcp-server-handlers/ops-apps";
import {
  createIssueConnectorKeyHandler,
  createListConnectorKeysHandler,
  createRevokeConnectorKeyHandler,
  type ConnectorKeysSource,
} from "@ggui-ai/mcp-server-handlers/ops-connector-keys";
import {
  createRedeemCouponHandler,
  type CouponRedeemSource,
} from "@ggui-ai/mcp-server-handlers/ops-coupon";
import {
  createCreateOrgHandler,
  createInviteToOrgHandler,
  createListOrgsHandler,
  createRevokeInviteHandler,
  type OrgInvitesSource,
  type OrgsSource,
} from "@ggui-ai/mcp-server-handlers/ops-orgs";
import {
  createGguiConsumeHandler,
  createGguiDeclareToolCatalogHandler,
  createGguiEmitHandler,
  createGguiGetSessionHandler,
  createGguiHandshakeHandler,
  createGguiListSessionsHandler,
  createGguiRefreshWsTokenHandler,
  createGguiRenderHandler,
  createGguiSubmitActionHandler,
  createGguiSyncContextHandler,
  createGguiUpdateHandler,
  InMemoryToolIdentityCatalogStore,
  createInMemoryProvisionalPreviewRegistry,
  type ChannelNotifier,
  type GenerationCredentials,
  type GenerationDeps,
  type BlueprintPool,
  type HandshakeNegotiator,
  type PropsUpdateNotifier,
  type ProvisionalPreviewConfig,
  type ProvisionalPreviewDeps,
  type ProvisionalPreviewEmitter,
  type ProvisionalPreviewOutcome,
  type ToolIdentityCatalogStore,
} from "@ggui-ai/mcp-server-handlers/renders";
import type { UiRegistry } from "@ggui-ai/ui-registry";
import {
  DEFAULT_ADMIN_BLUEPRINTS_PATH,
  mountAdminBlueprintsTransport,
} from "./admin-blueprints-transport.js";
import { mountAdminOAuthProvidersTransport } from "./admin-oauth-providers-transport.js";
import { DEFAULT_BUILDER_APP_ID, defaultAppIdFromIdentity } from "./auth.js";
import type { BuildMcpServerOptions, ServerInfo } from "./build-mcp.js";
import { mountMcpEndpoints } from "./mcp-endpoint-routes.js";
import { mountApiRendersRoutes } from "./api-renders-routes.js";
import { mountConsoleBlueprintRoutes } from "./console-blueprint-routes.js";
import { mountConsoleChatRoutes } from "./console-chat-routes.js";
import { mountConsoleConfigRoutes } from "./console-config-routes.js";
import { mountConsoleKeysRoutes } from "./console-keys-routes.js";
import { mountConsoleLlmKeysRoutes } from "./console-llm-keys-routes.js";
import { mountConsoleInfoRoutes } from "./console-info-routes.js";
import { mountConsoleMcpToolsRoutes } from "./console-mcp-tools-routes.js";
import { mountConsoleRegistryRoutes } from "./console-registry-routes.js";
import { mountConsoleSessionRoutes } from "./console-session-routes.js";
import { mountConsoleStaticRoutes } from "./console-static-routes.js";
import { mountConsoleSessionsRoutes } from "./console-sessions-routes.js";
import { mountCodeRoutes } from "./code-routes.js";
import { mountHealthRoutes } from "./health-routes.js";
import { mountOAuthAuthorizationServerRoutes } from "./oauth-as-routes.js";
import { mountOAuthClientsRoutes } from "./oauth-clients-routes.js";
import { mountRuntimeBundleRoute } from "./runtime-bundle-route.js";
import { createCsrfMiddleware, mountCsrfTokenRoute } from "./csrf-middleware.js";
import { mountEmailLoginRoutes, type EmailSender, type MagicLinkStore } from "./email-login.js";
import { resolveMcpInstructions, type McpInstructionsValue } from "./instructions-presets.js";
import { buildLlmCaller, createLlmBackedHandshakeNegotiator } from "./llm-backed-negotiator.js";
import { createConsoleLogger, type Logger } from "./logger.js";
import { installMcpAppsInbound } from "./mcp-apps-inbound.js";
import {
  composeHandlersWithMounts,
  validateMcpServices,
  type McpServerMount,
  type McpService,
} from "./mcp-mounts.js";
import type { OAuthLoginProvider } from "./oauth-login-types.js";
import { mountOAuthLoginRoutes } from "./oauth-login.js";
import { createOAuthProvidersStore } from "./oauth-providers-store.js";
import { githubLoginProvider } from "./oauth-providers/github.js";
import { googleLoginProvider } from "./oauth-providers/google.js";
import { InMemoryOAuthStorage, type OAuthConfig, type OAuthStorage } from "./oauth.js";
import {
  DEFAULT_PAIRING_ADMIN_INIT_PATH,
  DEFAULT_PAIRING_PATH,
  mountPairingTransport,
} from "./pairing-transport.js";
import { createPairLoginRateLimitMiddleware } from "./rate-limit-middleware.js";
import {
  createGguiSessionChannelServer,
  type GguiSessionChannelServer,
} from "./ggui-session-channel.js";
import { buildRequestContextMiddleware, resolveRuntimeUrl } from "./request-context.js";
import { composePreviewReservedValidator, mergeReservedValidators } from "./reserved-validators.js";
import {
  checkRenderSchemaCompat,
  DEFAULT_SCHEMA_COMPAT_MODE,
  type SchemaCompatMode,
} from "./schema-compat.js";
import { createSecurityHeadersMiddleware } from "./security-headers-middleware.js";
import {
  DEFAULT_THREADS_PATH,
  mountThreadTransport,
  type ThreadOwnerResolver,
} from "./thread-transport.js";
import { cookieAuthMiddleware } from "./user-session-auth.js";

/**
 * Default server identity. Callers override via `info:` when embedding.
 */
const DEFAULT_INFO: ServerInfo = {
  name: "ggui-mcp-server",
  version: "0.0.1",
  description:
    "Open self-hosted MCP server for the ggui protocol. Powered by @ggui-ai/mcp-server-handlers.",
};

/**
 * Canonical default handler set. Every `@ggui-ai/mcp-server-handlers`
 * family the OSS server ships with lands here, bound to the caller-
 * supplied deps. Use this when you want to EXTEND the defaults rather
 * than replace them wholesale:
 *
 * ```ts
 * const server = createGguiServer({
 *   vectors, embedding,
 *   handlers: [
 *     ...defaultHandlers({ vectors, embedding }),
 *     myCustomHandler,
 *   ],
 * });
 * ```
 *
 * Without this helper, `handlers:` replaces the full list — callers
 * lose the defaults unless they copy-paste them. Keeping `defaultHandlers`
 * named means the default set stays discoverable + testable in one place.
 *
 * `render` is opt-in via `deps.render` — it's only useful when the server
 * was booted with `mcpApps: true` (so `ui://ggui/render` is served)
 * and pairs a real GguiSessionStore. Callers get the choice explicitly.
 */
/**
 * Assemble the `opsBlueprint` dep bundle for `defaultHandlers`.
 *
 * Encapsulates the in-memory-store-narrowing logic at one site so the
 * call site stays clean. When the store is `InMemoryBlueprintStore`,
 * we wire its `putCode` + `listAllForApp` hooks. External
 * `BlueprintStore` adapters omit both — their `put` writes code to
 * durable storage directly, and their `BlueprintSearch` impl owns the
 * per-app enumeration.
 */
function buildOpsBlueprintDeps(input: {
  readonly registry: GeneratorRegistry;
  readonly blueprintStore: BlueprintStore;
  readonly blueprintSearch: BlueprintSearch;
  readonly resolveLlm?: (
    ctx: HandlerContext
  ) => Promise<GenerationCredentials | null> | GenerationCredentials | null;
  readonly blueprints?: BlueprintProvider;
  /**
   * Cache-registry bundle for the ops dual-write mirror. When bound,
   * `ggui_ops_generate_blueprint` also writes the produced blueprint
   * into the cache vectorStore via `registerBlueprint` so the
   * agent-facing matchBlueprint exact-key probe (handshake + render)
   * finds operator-authored blueprints. Same bundle the handshake
   * negotiator + render handler already consume — single source of
   * truth for the cache identity.
   */
  readonly cacheRegistry?: {
    readonly embedding: EmbeddingProvider;
    readonly vectorStore: VectorStore;
    readonly index: BlueprintIndex;
  };
}): {
  readonly opsBlueprint: {
    readonly registry: GeneratorRegistry;
    readonly blueprintStore: BlueprintStore;
    readonly blueprintSearch: BlueprintSearch;
    readonly putCode?: (codeHash: string, body: string) => void | Promise<void>;
    readonly listAllForApp?: (appId: string) => Promise<readonly Blueprint[]>;
    readonly resolveLlm?: (
      ctx: HandlerContext
    ) => Promise<GenerationCredentials | null> | GenerationCredentials | null;
    readonly blueprints?: BlueprintProvider;
    readonly cacheRegistry?: {
      readonly embedding: EmbeddingProvider;
      readonly vectorStore: VectorStore;
      readonly index: BlueprintIndex;
    };
  };
} {
  const { blueprintStore } = input;
  const inMemoryHooks =
    blueprintStore instanceof InMemoryBlueprintStore
      ? {
          putCode: (codeHash: string, body: string) => {
            blueprintStore.putCode(codeHash, body);
          },
          listAllForApp: (appId: string) => blueprintStore.listAllForApp(appId),
        }
      : {};
  return {
    opsBlueprint: {
      registry: input.registry,
      blueprintStore: input.blueprintStore,
      blueprintSearch: input.blueprintSearch,
      ...inMemoryHooks,
      ...(input.resolveLlm ? { resolveLlm: input.resolveLlm } : {}),
      ...(input.blueprints ? { blueprints: input.blueprints } : {}),
      ...(input.cacheRegistry ? { cacheRegistry: input.cacheRegistry } : {}),
    },
  };
}

export function defaultHandlers(deps: {
  readonly embedding: EmbeddingProvider;
  readonly vectors: VectorStore;
  /**
   * Per-app tool-identity catalog store (write side). When bound,
   * registers `ggui_runtime_declare_tool_catalog` — the host runtime's
   * `{ bareToolName -> canonical serverInfo }` declaration is persisted
   * here under `ctx.appId`. The SAME instance the handshake negotiator's
   * `toolIdentityCatalog` resolver reads, so a reused blueprint's tool
   * `serverInfo` is canonicalized before keying. Absent ⇒ the declaration
   * tool is NOT registered (zero-config OSS without the round-trip wired
   * stays clean).
   */
  readonly toolIdentityCatalogStore?: ToolIdentityCatalogStore;
  /**
   * Optional blueprint catalog source. When bound,
   * `ggui_list_featured_blueprints` enumerates the provider's
   * catalog; absent = the handler returns an empty list (the
   * zero-config OSS default).
   *
   * `createGguiServer` constructs a `ManifestBlueprintProvider`
   * from `ggui.json#blueprints.include` at boot and threads it in
   * here — that's how manifest-declared UIs surface through the MCP
   * tool.
   */
  readonly blueprints?: BlueprintProvider;
  /**
   * UI registry consulted by `ggui_render_blueprint`. When bound,
   * the render handler is registered and resolves every call through
   * this registry's `get(id)` + `getBundle(id)` pair. Absent = the
   * render handler is omitted from the handler array (no deprecation
   * shim, no throwing stub — operator sees "tool unavailable" only
   * if a caller tries to invoke it).
   *
   * `createGguiServer` threads `opts.uiRegistry` through when
   * present. OSS `ggui serve` binds
   * `@ggui-ai/dev-stack::LocalUiRegistry`.
   */
  readonly uiRegistry?: UiRegistry;
  /**
   * Handshake-state KV store. When bound, `ggui_handshake` is
   * registered and the paired `ggui_render({handshakeId})` consume
   * path is enabled. Both handlers share the same instance so the
   * write + read sit on one source of truth.
   *
   * Absent = handshake handler is NOT registered AND
   * `ggui_render({handshakeId})` falls back to a rejection shape.
   */
  readonly handshake?: {
    readonly kvStore: KeyValueStore;
    /**
     * Optional render store. When bound, `ggui_handshake` validates
     * the wire render id against this store (existence + tenant
     * ownership) before negotiating. This server sets it to the same
     * store the render-commit handler uses so the handshake catches
     * unknown / cross-tenant ids at the earliest boundary; deployments
     * that omit it validate at render-commit time instead.
     */
    readonly renderStore?: GguiSessionStore;
    /**
     * Optional negotiator binding. Absent = `ggui_handshake` stamps
     * `action: 'create'` + honest no-negotiator reason on the record
     * (the seam is still real; persistence + consumption still
     * anchor the round-trip).
     */
    readonly negotiator?: HandshakeNegotiator;
    /**
     * Optional per-app metadata resolver. When bound, the handshake
     * handler reads `app.gadgets` and threads the catalog to
     * the negotiator so synth knows which gadget bindings the app
     * exposes. Defaults to the same `appMetadataStore` the
     * `ggui_list_gadgets` tool uses.
     */
    readonly appMetadataStore?: AppMetadataStore;
    /**
     * Optional resolver for the `serverCapabilities` field on
     * every handshake response. Composition wires this so iframes
     * learn which `streamSpec[ch].source.tool` channels they can WS-
     * subscribe-for vs. must iframe-poll directly. Returning
     * `undefined` omits the field (universal iframe-polling fallback).
     */
    readonly serverCapabilities?: () => import("@ggui-ai/protocol").ServerCapabilities | undefined;
  };
  readonly render?: {
    readonly renderStore: GguiSessionStore;
    /**
     * Optional bootstrap-credential minter. When present, `ggui_render`
     * (the renamed render-commit tool) results carry the
     * `ai.ggui/render` slice meta. When absent, they don't —
     * non-MCP-Apps hosts read `{sessionId}` off structuredContent and
     * resolve the render-resource themselves.
     */
    readonly mintBootstrap?: (
      sessionId: string,
      appId: string
    ) => { wsUrl: string; token: string; expiresAt: string };
    /**
     * URL of the renderer bundle the thin-shell HTML should fetch
     * (C8 — plan §C8). Padded onto
     * {@link McpAppAiGguiRenderMeta.runtimeUrl} at `resultMeta` time.
     * Same-origin default is `/_ggui/iframe-runtime.js`; hosted cloud
     * operators override to a CDN URL. Required when `mintBootstrap`
     * is set (the thin shell depends on it); otherwise ignored.
     *
     * Function form: callers passing a getter let the handler
     * resolve the URL per request — auto-derive from
     * `X-Forwarded-Host` when the TCP peer is loopback so tunnel/
     * reverse-proxy setups produce absolute URLs that work under
     * srcdoc iframes (claude.ai). Static `publicBaseUrl` config
     * still wins.
     */
    readonly runtimeUrl?: string | (() => string | undefined);
    /**
     * Theme preset id resolved from `ggui.json#theme`. Forwarded onto
     * the `ai.ggui/render.themeId` slice field in the `ggui_render`
     * resultMeta so MCP Apps hosts (claude.ai, Claude Desktop)
     * propagate the operator's theme into the iframe.
     */
    readonly themeId?: string;
    /** Theme color mode resolved from `ggui.json#theme.mode`. */
    readonly themeMode?: "light" | "dark";
    /**
     * Live theme getter — resolved per-render. When set, supersedes
     * the static `themeId` / `themeMode` for every render's bootstrap.
     * Pair with the same getter passed into `createGguiServer({
     * themeProvider })` and a closure that reads from the shared
     * mutable cell `mountDevtoolThemeRoutes`'s POST handler updates.
     * Forwarded onto `deps.render.themeProvider` so the handler reads
     * the live theme each call.
     */
    readonly themeProvider?: () =>
      | {
          readonly id?: string;
          readonly mode?: "light" | "dark";
        }
      | undefined;
    /**
     * Optional connector registry — required for accepting
     * `shortcuts.mcpApps` render payloads (inbound MCP Apps hosting).
     * Omitted = inbound path is rejected with a clear error.
     */
    readonly connectors?: ConnectorRegistry;
    /**
     * Optional admission-control limiter. When present, `ggui_render`
     * gates every call through `rateLimiter.check({key:
     * 'ggui_render:<appId>', cost:1})` before doing any work; denial
     * surfaces as a `RateLimitedError`. Omitted = unlimited (the
     * `NoopRateLimiter` server default).
     */
    readonly rateLimiter?: RateLimiter;
    /**
     * Optional shortCode → render binding index. When present,
     * `ggui_render` records every minted `shortCode` so console's
     * `/s/<shortCode>` viewer (via the render-cookie endpoint) can
     * resolve it back to the right render. Absent = hosted cloud
     * flow (DynamoDB side-table owns lookups), or console not
     * enabled.
     */
    readonly shortCodeIndex?: ShortCodeIndex;
    /**
     * Optional provisional-preview wiring. When present, `ggui_render`
     * kicks off the configured emitter on every qualifying render (the
     * `evaluateProvisionalPreviewGate` predicate filters MCP Apps
     * renders + storyless calls automatically). Absent = no preview
     * channel traffic.
     *
     * Constructed by `createGguiServer` from `opts.provisionalPreview`
     * plus the late-bound `GguiSessionChannelServer.sendToGguiSession`
     * closure; callers threading their own handler set can build
     * `ProvisionalPreviewDeps` directly.
     */
    readonly provisionalPreview?: ProvisionalPreviewDeps;

    /**
     * Optional generation wiring. When present, `ggui_render` invokes
     * the supplied {@link UiGenerator} on every story-path call and
     * commits the generated `GguiSession` before returning `codeReady:
     * true`. Absent = render stays in placeholder mode (render +
     * shortCode + preview still work, but no componentCode is
     * produced).
     *
     * Callers compose the `GenerationDeps` directly via the
     * `@ggui-ai/mcp-server-handlers` export — `defaultHandlers`
     * simply threads the bundle through to `createGguiRenderHandler`.
     */
    readonly generation?: GenerationDeps;

    /**
     * Optional live-subscriber render-commit notifier.
     * When present, every successful `renderStore.commit` inside `ggui_render`
     * fan-outs a `{type:'render', payload:{render}}` live-channel frame to
     * every live subscriber on the affected render. Forwarded as-is
     * to `createGguiRenderHandler`.
     *
     * Hosts without a render channel (programmatic embedding, Lambda
     * one-shot) leave this absent — there are no live subscribers to
     * notify, and the render handler's own no-op-on-absent posture
     * keeps the path intact.
     */
    readonly channelNotifier?: ChannelNotifier;

    /**
     * Optional F4 schema compat check hook. When present,
     * `ggui_render` invokes it immediately
     * before every `renderStore.commit` — if the pending GguiSession's
     * `actionSpec` / `streamSpec` references a tool whose schemas
     * disagree, the hook throws `SchemaCompatError` and the handler
     * converts the rejection into an error render + `codeReady:
     * false`. Forwarded as-is to `createGguiRenderHandler`.
     *
     * `createGguiServer` binds this closure against the composed
     * `handlers` list + `opts.schemaCompatCheck` (default `'reject'`)
     * automatically; callers composing their own render handler via
     * `defaultHandlers` wire the hook themselves.
     */
    readonly checkRenderContracts?: (shape: {
      readonly actionSpec?: import("@ggui-ai/protocol").ActionSpec;
      readonly streamSpec?: import("@ggui-ai/protocol").StreamSpec;
    }) => void;

    /**
     * Optional content-addressable code store. When present together
     * with {@link codeBaseUrl}, `ggui_render` writes generated
     * componentCode to the store and surfaces `codeUrl` + `codeHash`
     * on the response — the sole static-component delivery channel
     * post-T3-1 (2026-05-13).
     *
     * Absent: `ggui_render.resultMeta` omits `codeUrl`. The iframe boots
     * via live-mode (wsUrl+token) and receives the render via the
     * live-channel WS subscribe. `/r/<shortCode>` (HTML default; JSON branch on `Accept: application/json`)
     * routes ALSO mint `codeUrl` when `codeStore` is set — they derive
     * the base URL from `req.protocol + req.host` when `codeBaseUrl`
     * isn't explicit (works for local dev + tunnel deployments).
     * Forwarded as-is to `createGguiRenderHandler`.
     */
    readonly codeStore?: CodeStore;

    /**
     * Base URL the code-blob route resolves to. Required when
     * `codeStore` is present so the handler can compose
     * `<base>/code/<hash>.js`. Forwarded as-is to
     * `createGguiRenderHandler`.
     */
    readonly codeBaseUrl?: string;
    /**
     * Resolver for the bootstrap field
     * `streamWebSocketLocalTools`. Mirrors the handshake's
     * `serverCapabilities.streamWebSocketLocalTools` so iframe-runtime
     * can pick WS-subscribe vs iframe-poll per channel. Composing
     * `createGguiServer` wires both from the SAME
     * `streamWebSocketLocalTools` option — so a server that advertises
     * a tool on the handshake also surfaces it on the bootstrap.
     *
     * Returns undefined ⇒ field omitted from bootstrap ⇒ legacy
     * "iframe polls everything" path. Returns an empty array ⇒
     * "WS transport supported but no tool is local" (still useful —
     * lets the iframe know the server is transport-aware).
     */
    readonly streamWebSocketLocalTools?: () => readonly string[] | undefined;
    /**
     * Optional bootstrap-refresh seam for the
     * `ggui_runtime_refresh_ws_token` tool (G14, 2026-05-23). When
     * supplied, the tool registers and validates each refresh request
     * via this seam's HMAC check + refresh-window arithmetic. Typically
     * wired against the SAME `channelBootstrap.refresh` the
     * render-channel server uses for WS upgrade validation, so both
     * paths share one HMAC secret and one refresh-window policy.
     *
     * Absent: the tool is NOT registered on this deployment. iframes
     * fall back to the historical "fresh handshake on every reconnect"
     * posture — fast via the matcher cache, but more wire traffic than
     * a stateless refresh.
     *
     * `createGguiServer` wires this from the `mcpAppsEnabled` branch's
     * `channelBootstrap.refresh` so the factory's behavior matches the
     * tool-side composition every deployment of this server family
     * uses.
     */
    readonly bootstrapRefresh?: import("@ggui-ai/mcp-server-handlers/renders").WsTokenRefreshSeam;
  };
  /**
   * `ggui_update` wiring. When present, register the OSS update
   * handler against the supplied GguiSessionStore + optional live-channel
   * props_update notifier. The handler reads `sessionId` from wire
   * input today, but a future in-process dispatcher can populate it
   * on the canonical context.
   *
   * Absent = `ggui_update` is NOT registered on this server. Hosts
   * that don't expose props mutation keep the smaller surface (e.g.,
   * static-blueprint demos, MCP-Apps-only deployments).
   */
  readonly update?: {
    readonly renderStore: GguiSessionStore;
    /**
     * Optional live-subscriber `props_update` notifier — typically a
     * thin closure over `GguiSessionChannelServer.sendPropsUpdate`.
     * Forwarded as-is to `createGguiUpdateHandler`. Hosts without a
     * render channel leave this absent; the handler still persists
     * via `renderStore.commit` on every successful patch.
     */
    readonly propsUpdateNotifier?: PropsUpdateNotifier;
    /**
     * Bootstrap-credential minter (live trio). When wired, the
     * `ggui_update` resultMeta emits the `ai.ggui/render` slice
     * so MCP Apps hosts that re-post
     * `ui/notifications/tool-result` via postMessage can re-apply
     * patched props on the live mount without re-subscribing. Mirrors
     * the same field on `render` deps; composing hosts wire both from
     * the same minter.
     */
    readonly mintBootstrap?: (
      sessionId: string,
      appId: string
    ) => { wsUrl: string; token: string; expiresAt: string };
    /** Iframe-runtime bundle URL forwarded onto the
     *  `ai.ggui/render.runtimeUrl` slice field.
     *  Function form mirrors the `render` deps' `runtimeUrl`. */
    readonly runtimeUrl?: string | (() => string | undefined);
    /** Theme preset id forwarded onto the `ai.ggui/render.themeId` slice field. */
    readonly themeId?: string;
    /** Theme color mode forwarded onto the `ai.ggui/render.themeMode` slice field. */
    readonly themeMode?: "light" | "dark";
    /** Live theme getter — overrides static themeId/themeMode per-update. */
    readonly themeProvider?: () =>
      | {
          readonly id?: string;
          readonly mode?: "light" | "dark";
        }
      | undefined;
    /** Resolver for bootstrap.streamWebSocketLocalTools. */
    readonly streamWebSocketLocalTools?: () => readonly string[] | undefined;
  };
  /**
   * Pending-events consumer wiring for `ggui_consume`. When `render`
   * is bound, the handler registers automatically with an in-memory
   * default; pass `consume.pendingEventConsumer` to override (e.g.,
   * SQLite-backed for persistent dev or a Dynamo adapter on cloud).
   *
   * `defaultRenderTtlSeconds` controls the activity-bump TTL the
   * handler forwards to `consumeAndClear` on every read. Falls back
   * to 1 day when omitted.
   */
  readonly consume?: {
    readonly pendingEventConsumer?: PendingEventConsumer;
    readonly defaultRenderTtlSeconds?: number;
  };
  /**
   * Stream channel wiring for `ggui_emit`. When `render` is bound, the
   * handler registers automatically; its `sendEnvelope` closes over
   * `stream.channelProvider`, a lazy getter that resolves the
   * `GguiSessionChannelServer` at emit time (the channel is constructed
   * AFTER `defaultHandlers` runs, so a static reference would always
   * be null on the OSS in-process boot).
   *
   * Absent / returns null = no live receiver. Emit still succeeds at
   * the protocol level; the envelope just isn't fanned out. Matches
   * cloud's `ggui_emit_accepted_no_receiver` posture.
   *
   * The getter pattern lets the OSS server bind once at boot, then
   * mutate the cell after `createGguiSessionChannelServer` runs.
   */
  readonly stream?: {
    readonly channelProvider?: () => GguiSessionChannelServer | null;
  };
  /**
   * Structured-event logger threaded into handlers that emit
   * protocol-adherence telemetry — `ggui_consume` fires the yellow-
   * flag `action_consume_slow` info-event when an event sat in the
   * pipe past the latency threshold. Absent = silent; the handler's
   * drain semantics are unaffected.
   */
  readonly logger?: Logger;
  /**
   * Operational-signal sink. Threaded into handlers that emit named
   * events (`ggui_render` emits `ui.created` / `ui.committed`;
   * `ggui_handshake` emits `handshake.minted`). Absent =
   * NoopTelemetrySink semantic. Lossy + non-throwing per the
   * {@link TelemetrySink} contract.
   */
  readonly telemetry?: TelemetrySink;
  /**
   * Per-app metadata store backing `ggui_list_gadgets`.
   * Absent = `createGguiServer` constructs a fresh
   * `InMemoryAppMetadataStore` seeded with `STDLIB_GADGETS` per app
   * on first access (sandbox-app permitted-error path inside the
   * handler also falls back to stdlib, so omitting the store still
   * yields a working tool).
   *
   * Hosted deployments inject an `AppMetadataStore` backed by their per-app
   * metadata table (cloud's DDB-backed adapter applies the
   * default-on-read pattern inside `getApp` directly).
   */
  readonly appMetadataStore?: AppMetadataStore;
  /**
   * Global theme-catalog resolver consumed by `ggui_list_themes` AND by
   * `ggui_render`'s opt-in `requestThemeList` projection. Returns
   * the full registry every call (kept as a function so additions to
   * the catalog at runtime — e.g. operator-defined themes in a future
   * slice — surface without a server restart). When BOTH this and
   * `appMetadataStore` are bound, `ggui_list_themes` registers; either
   * absent ⇒ the tool is omitted from the handler array (zero-config
   * OSS behavior: a deployment that hasn't wired themes simply doesn't
   * advertise theme picking).
   *
   * The CLI binds this to `@ggui-ai/design`'s `listThemes()`; hosted
   * deployments may project a different shape so this stays
   * design-package-agnostic at the handler layer.
   */
  readonly themes?: () => readonly ThemeCatalogEntry[];
  /**
   * Operator-class blueprint tool wiring. When
   * `generators` + `blueprintStore` + `blueprintSearch` are all
   * bound, `defaultHandlers` registers the four `ggui_ops_*`
   * blueprint tools on `/ops`:
   *
   *   - `ggui_ops_generate_blueprint` (requires `resolveLlm` +
   *     `blueprints` too — same deps the render generation path
   *     reads).
   *   - `ggui_ops_list_blueprints`
   *   - `ggui_ops_update_blueprint`
   *   - `ggui_ops_delete_blueprint`
   *
   * Absent = the ops tools are not registered (operator UX falls
   * back to whatever surface the cloud pod exposes, or the deployment
   * runs without operator authorship). The list/update/delete trio
   * registers even when `generate` deps are absent — read-only
   * operations on an existing store can be useful for inspection.
   */
  readonly opsBlueprint?: {
    readonly registry: GeneratorRegistry;
    readonly blueprintStore: BlueprintStore;
    readonly blueprintSearch: BlueprintSearch;
    /**
     * Hook into the store's code-body path. When the bound
     * `blueprintStore` is an `InMemoryBlueprintStore`, pass
     * `(codeHash, body) => store.putCode(codeHash, body)` so the
     * generated body is reachable via `getCode(codeHash)`. Cloud
     * adapters that persist code inside `BlueprintStore.put` omit
     * this.
     */
    readonly putCode?: (codeHash: string, body: string) => void | Promise<void>;
    /**
     * Per-app blueprint enumerator — used for the persona near-dup
     * warning on the generate path. Optional; when omitted the
     * check is skipped.
     */
    readonly listAllForApp?: (appId: string) => Promise<readonly Blueprint[]>;
    /**
     * Resolver for LLM credentials on the generate path. Same shape
     * as `render.generation.resolveLlm` — typically wired to the same
     * closure. When absent, the generate handler is NOT registered
     * (list/update/delete still register).
     */
    readonly resolveLlm?: (
      ctx: import("@ggui-ai/mcp-server-handlers").HandlerContext
    ) => Promise<GenerationCredentials | null> | GenerationCredentials | null;
    /**
     * BlueprintProvider passed to the generator (same instance
     * `defaultHandlers`'s blueprint search reads). Required when
     * `resolveLlm` is set — generate needs this on its
     * UiGenerateInput.
     */
    readonly blueprints?: BlueprintProvider;
    /**
     * Cache-registry mirror for `ggui_ops_generate_blueprint`. When
     * bound, operator-authored blueprints are dual-written to the
     * cache vectorStore via `registerBlueprint` so the agent-facing
     * matchBlueprint exact-key probe (handshake + render) finds them.
     * Same bundle the render handler reads/writes.
     */
    readonly cacheRegistry?: {
      readonly embedding: EmbeddingProvider;
      readonly vectorStore: VectorStore;
      readonly index: BlueprintIndex;
    };
  };
  /**
   * Per-domain dep bundles for the twelve operator-class `ggui_ops_*`
   * handlers covering apps + orgs + connector-keys + coupons. Each
   * domain is independently optional:
   * deployments that don't wire the seam simply don't register that
   * domain's tools (matching `ggui_ops_get_credit_balance`'s pattern).
   *
   * OSS deployments (no AppSync, no Cognito) leave these all
   * undefined and the surface stays narrow. Cloud pods bind
   * AppSync-backed adapters in a follow-up slice; the handlers ship
   * here with deps seams only.
   */
  readonly opsApps?: {
    readonly apps: AppsSource;
    readonly userDefaultApp: UserDefaultAppSource;
  };
  readonly opsOrgs?: {
    readonly orgs: OrgsSource;
    readonly invites: OrgInvitesSource;
  };
  readonly opsConnectorKeys?: {
    readonly connectorKeys: ConnectorKeysSource;
  };
  readonly opsCoupon?: {
    readonly coupons: CouponRedeemSource;
  };
}): ReadonlyArray<SharedHandler<ZodRawShape, ZodRawShape>> {
  // Single shared pending-events pipe (Model C, sessionId-keyed).
  // render opens (`markCreated`), submit_action appends, consume drains,
  // pop/close clean up. Every handler that touches the pipe MUST get
  // the same instance — separate instances would mean the pipe render
  // opened is invisible to consume's drain. Operators override via
  // `deps.consume.pendingEventConsumer` (e.g. SqlitePendingEventConsumer
  // for persistence).
  const pendingEventConsumer: PendingEventConsumer =
    deps.consume?.pendingEventConsumer ?? new InMemoryPendingEventConsumer();
  // Single shared active-consumer registry. consume.ts enters at the top
  // of its long-poll, submit-action.ts queries `hasActive` after a
  // successful append; both MUST see the same instance for the fast-path
  // signal to flow. In-process only (Map-backed) — multi-pod cloud
  // deployments override via a shared-state implementation.
  const activeConsumerRegistry = new InMemoryActiveConsumerRegistry();

  const handlers: Array<SharedHandler<ZodRawShape, ZodRawShape>> = [
    // Thread `deps.blueprints` into the search handler so
    // manifest-declared blueprints merge into the search results
    // alongside the semantic `VectorStore` matches. Zero-config OSS
    // boots without a provider (the spread-pick below collapses
    // `blueprints: undefined` out of the object) — the search handler
    // then runs in semantic-only mode, matching the pre-merge shape.
    createSearchBlueprintsHandler({
      embedding: deps.embedding,
      vectors: deps.vectors,
      ...(deps.blueprints ? { blueprints: deps.blueprints } : {}),
    }) as SharedHandler<ZodRawShape, ZodRawShape>,
    createListFeaturedBlueprintsHandler(
      deps.blueprints ? { blueprints: deps.blueprints } : {}
    ) as SharedHandler<ZodRawShape, ZodRawShape>,
    // Spec / discovery handlers — zero-deps. These may be tagged
    // `audience: ['protocol']` and mounted on `/protocol`; today they
    // ship on `/mcp` next to runtime tools.
    createDescribeBlueprintFormatHandler() as SharedHandler<ZodRawShape, ZodRawShape>,
    createDescribeDataContractFormatHandler() as SharedHandler<ZodRawShape, ZodRawShape>,
    createGetBlueprintBoilerplateHandler() as SharedHandler<ZodRawShape, ZodRawShape>,
    createGetExampleBlueprintsHandler() as SharedHandler<ZodRawShape, ZodRawShape>,
    createListAvailablePrimitivesHandler() as SharedHandler<ZodRawShape, ZodRawShape>,
    createValidateBlueprintHandler() as SharedHandler<ZodRawShape, ZodRawShape>,
    // `ggui_runtime_submit_action` — wired-action receiver. Registered
    // as app-visible (`_meta.ui.visibility: ['app']`) per MCP Apps
    // spec §401 so iframe-issued `tools/call` invocations land here
    // instead of being rejected. Dual-writes every dispatch to BOTH
    // `pendingEventConsumer` (wakes `ggui_consume`) AND `renderStore`
    // (audit ledger for RenderInspector + cross-process replay) —
    // restores the audit visibility the pre-spec-mig WS handler
    // (`handleInboundAction`) used to provide. `renderStore` is
    // optional — passed through from `deps.render.renderStore` when
    // bound; absent → ledger write is skipped, queue still fires.
    createGguiSubmitActionHandler({
      pendingEventConsumer,
      activeConsumerRegistry,
      ...(deps.render?.renderStore ? { renderStore: deps.render.renderStore } : {}),
      ...(deps.logger ? { logger: deps.logger } : {}),
    }) as SharedHandler<ZodRawShape, ZodRawShape>,
    // `ggui_list_gadgets` — per-app discovery. Returns the registered
    // gadget catalog (stdlib seed by default). Reads `app.gadgets`
    // off the bound `AppMetadataStore`; falls back to `STDLIB_GADGETS`
    // when the row is absent (sandbox-app permitted-error path).
    createGguiListGadgetsHandler({
      appMetadataStore: deps.appMetadataStore ?? new InMemoryAppMetadataStore(),
    }) as SharedHandler<ZodRawShape, ZodRawShape>,
  ];
  // `ggui_list_themes` — per-app theme catalog discovery. Registered
  // only when BOTH a per-app metadata source AND a global theme
  // resolver are bound. Either absent ⇒ the tool is omitted (zero-
  // config OSS without theming wired stays clean; tools/list doesn't
  // advertise a tool the handler can't fulfill).
  if (deps.appMetadataStore && deps.themes) {
    handlers.push(
      createGguiListThemesHandler({
        appMetadataStore: deps.appMetadataStore,
        themes: deps.themes,
      }) as SharedHandler<ZodRawShape, ZodRawShape>
    );
  }
  // `ggui_runtime_declare_tool_catalog` — WRITE side of cross-runtime
  // tool-identity canonicalization. The host runtime declares its
  // `{ bareToolName -> canonical serverInfo }` catalog on connect; it is
  // persisted under `ctx.appId` in the SAME store the handshake
  // negotiator's `toolIdentityCatalog` resolver reads, so a reused
  // blueprint's tool `serverInfo` is canonicalized before keying.
  // Registered only when the store is wired (zero-config OSS without the
  // round-trip stays clean — tools/list doesn't advertise a write tool
  // with nowhere to persist).
  if (deps.toolIdentityCatalogStore) {
    handlers.push(
      createGguiDeclareToolCatalogHandler({
        catalogStore: deps.toolIdentityCatalogStore,
      }) as SharedHandler<ZodRawShape, ZodRawShape>
    );
  }
  // ggui_runtime_sync_context — runtime → server contextSpec snapshot mirror.
  // Same `_meta.ui.visibility: ['app']` channel as ggui_runtime_submit_action;
  // claude.ai (and any MCP Apps host) routes iframe-issued
  // `tools/call` here. Wired only when a renderStore is bound (render
  // is on) — the handler's whole job is upserting the snapshot onto
  // the active GguiSession, which requires the same store render writes
  // to. Without render, there's no render to mutate.
  if (deps.render) {
    handlers.push(
      createGguiSyncContextHandler({
        renderStore: deps.render.renderStore,
      }) as SharedHandler<ZodRawShape, ZodRawShape>
    );
    // `ggui_runtime_refresh_ws_token` — G14 (2026-05-23) signed-
    // envelope refresh tool. Registered only when a refresh seam is
    // wired (typically `channelBootstrap.refresh` from the
    // mcpAppsEnabled branch). Without the seam, the tool would always
    // return BOOTSTRAP_NOT_SUPPORTED, which is honest but useless on
    // tools/list — skip registration entirely.
    if (deps.render.bootstrapRefresh) {
      handlers.push(
        createGguiRefreshWsTokenHandler({
          refreshSeam: deps.render.bootstrapRefresh,
        }) as SharedHandler<ZodRawShape, ZodRawShape>
      );
    }
    // Phase B (flatten-render-identity): the session lifetime entry
    // point (`ggui_new_session`) was deleted. The render-commit handler
    // (`ggui_render`, previously `ggui_push`) is the sole entry — it
    // mints a render id on its own first call and the agent uses that
    // id directly without a prior session-mint round-trip.
  }
  if (deps.uiRegistry) {
    // Register the render handler ONLY when a UiRegistry is wired.
    // Previous behavior shipped a deprecation-shim that threw on
    // every call — shipping a tool with no functionality confused
    // agents more than the absence. Absent registry ⇒ absent tool.
    handlers.push(
      createRenderBlueprintHandler({ uiRegistry: deps.uiRegistry }) as SharedHandler<
        ZodRawShape,
        ZodRawShape
      >
    );
  }
  // Generation-progress lifecycle emitter — shared by handshake/render/
  // consume so the three handlers publish to the reserved
  // `_ggui:lifecycle` channel through one binding. Lazy-resolves the
  // channel provider because `createGguiSessionChannelServer` runs after
  // `defaultHandlers`; a static reference would always be null on first
  // emit. Mirrors the pattern `ggui_emit`'s `sendEnvelope` uses below.
  //
  // Fire-and-forget: a slow / failing publish degrades client-side
  // progress indicators (no state change for that signal) but MUST NOT
  // impact the handler's primary result.
  const lifecycleChannelProvider = deps.stream?.channelProvider;
  const lifecycleEmitter = lifecycleChannelProvider
    ? {
        emit(sessionId: string, payload: GguiLifecyclePayload): void {
          const channel = lifecycleChannelProvider();
          if (!channel) return;
          void channel
            .sendToGguiSession({
              sessionId,
              channel: LIFECYCLE_CHANNEL,
              mode: "append",
              payload,
            })
            .catch(() => undefined);
        },
      }
    : undefined;

  if (deps.handshake) {
    // App store priority: handshake-explicit > server-level deps.appMetadataStore
    // > undefined. The `ggui_list_gadgets` tool already
    // falls back to `new InMemoryAppMetadataStore()` when `deps.appMetadataStore` is
    // unset, but here we leave it `undefined` so the handler's
    // optional-lookup behavior fires (only invokes the store when bound).
    const resolvedAppMetadataStore = deps.handshake.appMetadataStore ?? deps.appMetadataStore;
    handlers.push(
      createGguiHandshakeHandler({
        kvStore: deps.handshake.kvStore,
        ...(deps.handshake.negotiator ? { negotiator: deps.handshake.negotiator } : {}),
        ...(resolvedAppMetadataStore ? { appMetadataStore: resolvedAppMetadataStore } : {}),
        ...(deps.handshake.serverCapabilities
          ? { serverCapabilities: deps.handshake.serverCapabilities }
          : {}),
        ...(lifecycleEmitter ? { lifecycleEmitter } : {}),
      }) as SharedHandler<ZodRawShape, ZodRawShape>
    );
  }
  if (deps.update) {
    handlers.push(
      createGguiUpdateHandler({
        renderStore: deps.update.renderStore,
        ...(deps.update.propsUpdateNotifier
          ? { propsUpdateNotifier: deps.update.propsUpdateNotifier }
          : {}),
        // Bootstrap-emission deps mirror render so MCP Apps hosts that
        // forward `ui/notifications/tool-result` via postMessage can
        // re-apply patched props on the live mount without a WS round-trip.
        ...(deps.update.mintBootstrap ? { mintWsToken: deps.update.mintBootstrap } : {}),
        ...(deps.update.runtimeUrl !== undefined ? { runtimeUrl: deps.update.runtimeUrl } : {}),
        ...(deps.update.themeId !== undefined ? { themeId: deps.update.themeId } : {}),
        ...(deps.update.themeMode !== undefined ? { themeMode: deps.update.themeMode } : {}),
        ...(deps.update.themeProvider !== undefined
          ? { themeProvider: deps.update.themeProvider }
          : {}),
        ...(deps.update.streamWebSocketLocalTools !== undefined
          ? { streamWebSocketLocalTools: deps.update.streamWebSocketLocalTools }
          : {}),
      }) as SharedHandler<ZodRawShape, ZodRawShape>
    );
  }
  // ggui_consume registers whenever render is bound (it shares the
  // GguiSessionStore for sessionId resolution + tenancy checks).
  // Default backing is in-memory; operators override via
  // `deps.consume.pendingEventConsumer` for SQLite / Dynamo adapters.
  // Without this registration the `nextStep → consume` hint that
  // every render response carries would resolve to a not-found tool.
  if (deps.render) {
    // Drain-ack fan-out + telemetry. Both consume and
    // claim-pending share the same channelProvider seam: consume
    // emits drain_ack frames after each pop; claim-pending emits
    // action_claim_timeout warn-events on rescue drains. The
    // channelProvider lookup is lazy so a non-channel-bound deployment
    // (no WS server) still registers the handlers cleanly — the
    // notifiers just no-op.
    const drainAckNotifier = (() => {
      const provider = deps.stream?.channelProvider;
      if (!provider) return undefined;
      return {
        sendDrainAck(args: {
          readonly sessionId: string;
          readonly appId: string;
          readonly eventId: string;
          readonly drainedAt: string;
        }): void {
          provider()?.sendDrainAck(args);
        },
      };
    })();
    const drainTelemetryLogger = {
      info(event: string, fields: Record<string, unknown>): void {
        deps.logger?.info(event, fields);
      },
      warn(event: string, fields: Record<string, unknown>): void {
        deps.logger?.warn(event, fields);
      },
      debug(event: string, fields: Record<string, unknown>): void {
        deps.logger?.debug?.(event, fields);
      },
    };
    handlers.push(
      createGguiConsumeHandler({
        pendingEventConsumer,
        renderStore: deps.render.renderStore,
        activeConsumerRegistry,
        ...(deps.consume?.defaultRenderTtlSeconds !== undefined
          ? { defaultRenderTtlSeconds: deps.consume.defaultRenderTtlSeconds }
          : {}),
        ...(drainAckNotifier ? { drainAckNotifier } : {}),
        logger: drainTelemetryLogger,
        ...(lifecycleEmitter ? { lifecycleEmitter } : {}),
      }) as SharedHandler<ZodRawShape, ZodRawShape>
    );
    // 2026-05-14 — `ggui_runtime_claim_pending` retired alongside the
    // iframe-side 10s claim timer. The pipe is the single source of
    // truth: when no consumer is registered for a render, the server
    // reports `consumerPresent: false` on the submit_action response and
    // the iframe emits the `ai.ggui/userAction` pure doorbell on a
    // `ui/message` (`kind === 'user-action'`, carrying a prepared
    // `ggui_consume` nextStep + the imperative directive in the message
    // text). No timer, no rescue drain, no inline payload, no race
    // between two atomic-pop callers.
    // ggui_get_session is a pure read off the GguiSessionStore, registered
    // alongside the render-commit handler. (ggui_get_stack was deleted
    // — a render IS the addressable unit; there is no stack to read.
    // The former companion `ggui_close` tool was also retired: renders
    // decay implicitly via TTL, so there is no terminal write to make.)
    handlers.push(
      createGguiGetSessionHandler({
        renderStore: deps.render.renderStore,
      }) as SharedHandler<ZodRawShape, ZodRawShape>
    );
    // ggui_list_sessions — host-scoped render enumeration for resume.
    // Folds the ws-token mint into the same call so the host doesn't
    // round-trip twice (list, then mint-per-render). Reuses the
    // already-wired `deps.render.mintBootstrap` seam so both code paths
    // share one HMAC secret and one TTL policy. Absent seam (rare —
    // every deployment that has render wired also has mintBootstrap)
    // ⇒ summaries omit wsToken and the caller must mint elsewhere.
    const renderMintBootstrap = deps.render.mintBootstrap;
    handlers.push(
      createGguiListSessionsHandler({
        renderStore: deps.render.renderStore,
        ...(renderMintBootstrap !== undefined
          ? {
              mintWsToken: {
                mint: ({ sessionId, appId }) => {
                  const { token, expiresAt } = renderMintBootstrap(sessionId, appId);
                  return { token, expiresAt };
                },
              },
            }
          : {}),
      }) as SharedHandler<ZodRawShape, ZodRawShape>
    );
    // `ggui_emit` routes outbound stream envelopes through the active
    // `GguiSessionChannelServer.sendToGguiSession`
    // (which records into the bound `GguiSessionStreamBuffer` + fans out
    // to subscribers). When no channel is bound, the handler accepts
    // the envelope and returns silently — mirrors cloud's
    // `ggui_emit_accepted_no_receiver` posture.
    //
    // `channelProvider` is lazy because `createGguiSessionChannelServer`
    // runs AFTER `defaultHandlers`; a static reference would always
    // be null on first emit. The OSS server's outer scope mutates
    // `channelForHealth` on listen() and points the provider at it.
    const channelProvider = deps.stream?.channelProvider;
    handlers.push(
      createGguiEmitHandler({
        renderStore: deps.render.renderStore,
        async sendEnvelope(envelope) {
          const channel = channelProvider?.() ?? null;
          if (!channel) {
            // No live receiver. Accept at the protocol boundary; no
            // fan-out happens. `seq` is unset because no buffer
            // recorded the envelope.
            return {};
          }
          const { seq } = await channel.sendToGguiSession({
            sessionId: envelope.sessionId,
            channel: envelope.channel,
            mode: envelope.mode,
            payload: envelope.payload,
            ...(envelope.complete === true ? { complete: true as const } : {}),
          });
          // `sendToGguiSession` plumbs the stamped seq out of fanOut so
          // ggui_emit's wire output carries ordering info — matches
          // cloud's `RedisGguiSessionStreamBuffer.record` returning seq
          // and being threaded onto the response. Agents that want to
          // correlate "I just emitted on channel X" with a specific
          // wire frame have a stable handle.
          return { seq };
        },
      }) as SharedHandler<ZodRawShape, ZodRawShape>
    );
  }
  if (deps.render) {
    handlers.push(
      createGguiRenderHandler({
        renderStore: deps.render.renderStore,
        // Plugin slice Commit 3 — render reads App.gadgets to
        // gate `clientCapabilities.gadgets[*].hook` references via
        // `assertGadgetsRegistered`. Same instance the
        // handshake handler reads from so both seams enforce the
        // same registry membership.
        ...(deps.appMetadataStore ? { appMetadataStore: deps.appMetadataStore } : {}),
        pendingEventConsumer,
        ...(deps.render.streamWebSocketLocalTools !== undefined
          ? { streamWebSocketLocalTools: deps.render.streamWebSocketLocalTools }
          : {}),
        ...(deps.render.mintBootstrap ? { mintWsToken: deps.render.mintBootstrap } : {}),
        ...(deps.render.runtimeUrl !== undefined ? { runtimeUrl: deps.render.runtimeUrl } : {}),
        ...(deps.render.themeId !== undefined ? { themeId: deps.render.themeId } : {}),
        ...(deps.render.themeMode !== undefined ? { themeMode: deps.render.themeMode } : {}),
        ...(deps.render.themeProvider !== undefined
          ? { themeProvider: deps.render.themeProvider }
          : {}),
        ...(deps.render.connectors ? { connectors: deps.render.connectors } : {}),
        ...(deps.render.rateLimiter ? { rateLimiter: deps.render.rateLimiter } : {}),
        ...(deps.render.shortCodeIndex ? { shortCodeIndex: deps.render.shortCodeIndex } : {}),
        ...(deps.render.provisionalPreview
          ? { provisionalPreview: deps.render.provisionalPreview }
          : {}),
        ...(deps.render.generation ? { generation: deps.render.generation } : {}),
        // Live-subscriber render-commit notifier. Forwarded as-is
        // when present so the render handler can fan out
        // `renderStore.commit` deltas to already-subscribed
        // live-channel clients. Hosts without a render channel pass
        // nothing; the handler's own no-op-on-absent posture keeps
        // the path intact.
        ...(deps.render.channelNotifier ? { channelNotifier: deps.render.channelNotifier } : {}),
        // F4 schema compat hook. Forwarded as-is; the render handler
        // wraps it in try/catch
        // on the generation + cache-hit paths so a thrown
        // SchemaCompatError converts to an error render.
        ...(deps.render.checkRenderContracts
          ? { checkRenderContracts: deps.render.checkRenderContracts }
          : {}),
        // Content-addressable code store. Both fields are forwarded
        // together; the render handler
        // requires both to emit `codeUrl`. Absent or partial =
        // inline-base64 fallback (see render.ts handler body).
        ...(deps.render.codeStore && deps.render.codeBaseUrl
          ? {
              codeStore: deps.render.codeStore,
              codeBaseUrl: deps.render.codeBaseUrl,
            }
          : {}),
        // Share the handshake KV store between the two handlers so
        // the write (ggui_handshake) + read (ggui_render) sit on one
        // source of truth. The caller can also pass a different
        // handshakeStore to render if they split minting + consuming
        // across processes, but the defaults wire them to the same
        // instance.
        ...(deps.handshake ? { handshakeStore: deps.handshake.kvStore } : {}),
        ...(lifecycleEmitter ? { lifecycleEmitter } : {}),
      }) as SharedHandler<ZodRawShape, ZodRawShape>
    );
  }
  // Operator-class blueprint tools. Registered
  // on /ops via `audience: ['ops']`. Three read-mutating tools land
  // whenever the blueprint store + search seam is bound; the
  // `generate` tool additionally requires `resolveLlm` +
  // `blueprints` (same deps the render generation path reads). Cloud
  // pods wire all four through their own composition layer.
  if (deps.opsBlueprint) {
    if (deps.opsBlueprint.resolveLlm && deps.opsBlueprint.blueprints) {
      handlers.push(
        createGguiOpsGenerateBlueprintHandler({
          registry: deps.opsBlueprint.registry,
          blueprintStore: deps.opsBlueprint.blueprintStore,
          resolveLlm: deps.opsBlueprint.resolveLlm,
          blueprints: deps.opsBlueprint.blueprints,
          ...(deps.opsBlueprint.putCode ? { putCode: deps.opsBlueprint.putCode } : {}),
          ...(deps.opsBlueprint.listAllForApp
            ? { listAllForApp: deps.opsBlueprint.listAllForApp }
            : {}),
          ...(deps.opsBlueprint.cacheRegistry
            ? { cacheRegistry: deps.opsBlueprint.cacheRegistry }
            : {}),
          ...(deps.telemetry ? { telemetry: deps.telemetry } : {}),
        }) as SharedHandler<ZodRawShape, ZodRawShape>
      );
    }
    // `ggui_ops_register_blueprint` — sibling of `_generate_*` that
    // accepts pre-built componentCode bytes. No LLM dispatch, so it
    // registers whenever the ops dep bundle is bound (no resolveLlm
    // / blueprints gate). Operator UX entry point for fixture
    // seeding + export/reimport round-trips.
    handlers.push(
      createGguiOpsRegisterBlueprintHandler({
        blueprintStore: deps.opsBlueprint.blueprintStore,
        ...(deps.opsBlueprint.putCode ? { putCode: deps.opsBlueprint.putCode } : {}),
        ...(deps.opsBlueprint.listAllForApp
          ? { listAllForApp: deps.opsBlueprint.listAllForApp }
          : {}),
        ...(deps.opsBlueprint.cacheRegistry
          ? { cacheRegistry: deps.opsBlueprint.cacheRegistry }
          : {}),
        ...(deps.telemetry ? { telemetry: deps.telemetry } : {}),
      }) as SharedHandler<ZodRawShape, ZodRawShape>
    );
    handlers.push(
      createGguiOpsListBlueprintsHandler({
        blueprintStore: deps.opsBlueprint.blueprintStore,
        blueprintSearch: deps.opsBlueprint.blueprintSearch,
      }) as SharedHandler<ZodRawShape, ZodRawShape>
    );
    handlers.push(
      createGguiOpsUpdateBlueprintHandler({
        blueprintStore: deps.opsBlueprint.blueprintStore,
      }) as SharedHandler<ZodRawShape, ZodRawShape>
    );
    handlers.push(
      createGguiOpsDeleteBlueprintHandler({
        blueprintStore: deps.opsBlueprint.blueprintStore,
      }) as SharedHandler<ZodRawShape, ZodRawShape>
    );
  }
  // Operator-class per-domain handlers for the console's apps + orgs
  // + connector-keys + coupon surfaces. Each domain registers
  // independently when its deps seam is bound; OSS deployments
  // without these wired keep the smaller surface.
  if (deps.opsApps) {
    handlers.push(
      createListAppsHandler({
        apps: deps.opsApps.apps,
      }) as SharedHandler<ZodRawShape, ZodRawShape>
    );
    handlers.push(
      createCreateAppHandler({
        apps: deps.opsApps.apps,
      }) as SharedHandler<ZodRawShape, ZodRawShape>
    );
    handlers.push(
      createRenameAppHandler({
        apps: deps.opsApps.apps,
      }) as SharedHandler<ZodRawShape, ZodRawShape>
    );
    handlers.push(
      createDeleteAppHandler({
        apps: deps.opsApps.apps,
      }) as SharedHandler<ZodRawShape, ZodRawShape>
    );
    handlers.push(
      createSetDefaultAppHandler({
        apps: deps.opsApps.apps,
        userDefaultApp: deps.opsApps.userDefaultApp,
      }) as SharedHandler<ZodRawShape, ZodRawShape>
    );
    handlers.push(
      createUpdateAppSystemPromptHandler({
        apps: deps.opsApps.apps,
      }) as SharedHandler<ZodRawShape, ZodRawShape>
    );
  }
  if (deps.opsOrgs) {
    handlers.push(
      createListOrgsHandler({
        orgs: deps.opsOrgs.orgs,
      }) as SharedHandler<ZodRawShape, ZodRawShape>
    );
    handlers.push(
      createCreateOrgHandler({
        orgs: deps.opsOrgs.orgs,
      }) as SharedHandler<ZodRawShape, ZodRawShape>
    );
    handlers.push(
      createInviteToOrgHandler({
        invites: deps.opsOrgs.invites,
      }) as SharedHandler<ZodRawShape, ZodRawShape>
    );
    handlers.push(
      createRevokeInviteHandler({
        invites: deps.opsOrgs.invites,
      }) as SharedHandler<ZodRawShape, ZodRawShape>
    );
  }
  if (deps.opsConnectorKeys) {
    handlers.push(
      createListConnectorKeysHandler({
        connectorKeys: deps.opsConnectorKeys.connectorKeys,
      }) as SharedHandler<ZodRawShape, ZodRawShape>
    );
    handlers.push(
      createIssueConnectorKeyHandler({
        connectorKeys: deps.opsConnectorKeys.connectorKeys,
      }) as SharedHandler<ZodRawShape, ZodRawShape>
    );
    handlers.push(
      createRevokeConnectorKeyHandler({
        connectorKeys: deps.opsConnectorKeys.connectorKeys,
      }) as SharedHandler<ZodRawShape, ZodRawShape>
    );
  }
  if (deps.opsCoupon) {
    handlers.push(
      createRedeemCouponHandler({
        coupons: deps.opsCoupon.coupons,
      }) as SharedHandler<ZodRawShape, ZodRawShape>
    );
  }
  return handlers;
}

export interface CreateGguiServerOptions {
  /**
   * Server identity broadcast to MCP clients. Defaults to
   * `{name: 'ggui-mcp-server', version: '0.0.1', ...}`.
   */
  readonly info?: Partial<ServerInfo>;

  /**
   * Operator-mode hint that gates the `/devtools/*` namespace.
   *
   *   - `'prod'` (default for `ggui serve`): only `/admin/*` mounts.
   *   - `'dev'` (default for `ggui dev`): `/devtools/*` mounts in
   *     addition to `/admin/*` and the SPA shows the dev-mode link
   *     in the TopNav. The dev surfaces are admin-cookie gated, same
   *     as `/admin/*` — `mode: 'dev'` only changes WHAT mounts, not
   *     who can reach it.
   *
   * When omitted, resolves from `process.env.GGUI_MODE` (`'dev'` →
   * dev, anything else including unset → prod). Pass an explicit
   * value to override the env in test fixtures and embedders.
   */
  readonly mode?: "dev" | "prod";

  /**
   * Shared handler set to expose. Defaults to the blueprint-read family
   * (search + list_featured + render). Pass your own list to add / remove
   * tools — handlers MUST be `SharedHandler` instances from
   * `@ggui-ai/mcp-server-handlers` (or shape-compatible custom ones).
   */
  readonly handlers?: ReadonlyArray<SharedHandler<ZodRawShape, ZodRawShape>>;

  /**
   * Identity-kind allowlist for tool registration. When set, handlers
   * whose `allowedFor` field declares a non-overlapping audience are
   * skipped at registration time. Handlers without `allowedFor` register
   * unconditionally.
   *
   *   - agent-builder posture sets `['app']` — skips hypothetical
   *     `['user']`-only handlers without affecting the existing toolset
   *     (which is all `['app', 'builder']`).
   *   - end-user / Connector posture sets `['user']` — skips all
   *     agent-builder writes (render / handshake / update) while keeping
   *     the read-only blueprint surface visible.
   *   - OSS local omits this option — every handler registers; OSS
   *     callers resolve to `kind: 'builder'` and the filter never fires.
   *
   * See `packages/mcp-server-handlers/src/types.ts`
   * (`SharedHandler.allowedFor`).
   */
  readonly allowedKinds?: ReadonlyArray<"app" | "user" | "builder">;

  /**
   * Auth adapter. Defaults to `InMemoryAuthAdapter({devAllowAll: true})`
   * — accepts any non-empty bearer token as the `builder` identity.
   * Every real deployment SHOULD override this (e.g. with a
   * `PairingService`-backed adapter).
   */
  readonly auth?: AuthAdapter;

  /**
   * Vector store for blueprint search. Defaults to `InMemoryVectorStore`.
   */
  readonly vectors?: VectorStore;

  /**
   * Blueprint identity index — resolves `(scope, exactKey) → blueprintId`
   * without a scope scan. Defaults to `InMemoryBlueprintIndex`. Operators
   * who wire a persistent `vectors` store SHOULD pass a matching
   * persistent index (e.g. `SqliteBlueprintIndex`) so the binding survives
   * a restart. Threaded into the generation cache + every
   * `BlueprintRegistryDeps` the server builds so the matcher + registry
   * share one instance.
   */
  readonly index?: BlueprintIndex;

  /**
   * Embedding provider for blueprint search. Defaults to `MockEmbeddingProvider`
   * — produces deterministic but NOT semantically meaningful vectors.
   * Swap for a real provider (OpenAI / Bedrock / Voyage / local) in
   * production.
   */
  readonly embedding?: EmbeddingProvider;

  /**
   * Per-app metadata source. When bound, threaded into
   * `defaultHandlers` so `ggui_list_gadgets`,
   * `ggui_list_themes`, `ggui_render({themeId?})`, and the
   * handshake's `app.gadgets` lookup all read from the same
   * store. The CLI binds an `InMemoryAppMetadataStore` seeded from
   * `ggui.json#theme.preset` (so every appId picks up the operator's
   * chosen default theme without an explicit `register()`); hosted
   * deployments bind a multi-tenant adapter.
   *
   * Absent ⇒ `defaultHandlers` constructs a fresh
   * `InMemoryAppMetadataStore` per request site that needs one (no
   * cross-handler sharing) and `ggui_list_themes` is NOT registered.
   */
  readonly appMetadataStore?: AppMetadataStore;

  /**
   * Per-app tool-identity catalog store — the shared persistence seam
   * for cross-runtime tool-identity canonicalization. The SAME instance
   * is wired into BOTH sides of the round-trip:
   *   - WRITE: the `ggui_runtime_declare_tool_catalog` handler (the host
   *     runtime declares `{ bareToolName -> canonical serverInfo }` on
   *     connect).
   *   - READ: the handshake decision adapter's `toolIdentityCatalog`
   *     resolver, so a reused blueprint's tool `serverInfo` is rewritten
   *     to the canonical identity before keying (framework-invariant
   *     reuse).
   *
   * Absent ⇒ `createGguiServer` constructs a single shared
   * `InMemoryToolIdentityCatalogStore` and threads it into both sides
   * (mirrors the `appMetadataStore` default). Hosted deployments bind a
   * multi-tenant adapter.
   */
  readonly toolIdentityCatalogStore?: ToolIdentityCatalogStore;

  /**
   * Global theme-catalog resolver. When bound alongside
   * `appMetadataStore`, registers `ggui_list_themes` and projects the
   * same catalog into `ggui_render({requestThemeList: true})`
   * outputs. Read each call so additions to the registry at runtime
   * (operator-defined themes in a future slice) surface without a
   * restart.
   *
   * The OSS CLI binds this to `@ggui-ai/design`'s `listThemes()`;
   * hosted deployments may project a different shape. Kept as a
   * resolver function so this surface stays design-package-agnostic.
   */
  readonly themes?: () => readonly ThemeCatalogEntry[];

  /**
   * Blueprint catalog source consulted by
   * `ggui_list_featured_blueprints`. Omitted = the handler returns
   * an empty list (zero-config default). The `ggui-cli` binding
   * constructs a `ManifestBlueprintProvider` from the declared
   * `ggui.json#blueprints.include` manifests and passes it here,
   * so `ggui serve` surfaces every authored UI through the MCP tool
   * without any code change per deployment.
   *
   * Passing `blueprintProvider:` is what makes the `ggui.json`
   * manifest's blueprint declarations take effect — the manifest
   * shape stops being inert once a provider is wired.
   */
  readonly blueprintProvider?: BlueprintProvider;

  /**
   * Admin-blueprints transport (`POST /admin/blueprints`) — runtime
   * manifest registration into the active {@link blueprintProvider}.
   *
   *   - `undefined` (default) or an object `{path?}` — mount the
   *     route at `/admin/blueprints` (override via `{path: '/x'}`).
   *     Only actually mounted when {@link blueprintProvider} is also
   *     wired; without a caller-supplied provider the default
   *     provider built inside `defaultHandlers` is unreachable from
   *     this scope and silently mounting would surprise operators.
   *   - `{path: null}` — disable the route explicitly while leaving
   *     the provider wired (operators who want the provider but not
   *     the HTTP admin surface).
   *   - `false` — same as `{path: null}`, but shorter.
   *
   * In-memory only: runtime-registered manifests survive until the
   * server process exits. Plan explicitly permits this choice; a
   * follow-up slice may add disk persistence if operators ask.
   *
   * Auth: builder-bearer, same gate as `/admin/pair/init`.
   */
  readonly adminBlueprints?: false | { readonly path?: string | null };

  /**
   * UI registry consulted by `ggui_render_blueprint`. When present, the
   * render handler is registered on the MCP wire and resolves every
   * call through this registry's `get(id)` + `getBundle(id)` pair.
   * When absent, `ggui_render_blueprint` is NOT registered at all —
   * callers that attempted to invoke it get a clean "tool not
   * available" MCP response instead of a throwing shim.
   *
   * OSS `ggui serve` binds `@ggui-ai/dev-stack::LocalUiRegistry` here
   * (manifest-backed, compile-on-demand via esbuild). Hosted or
   * programmatic embedders plug in their own implementation (cloud
   * origin, S3-backed, etc.) — the handler is pure over the
   * `UiRegistry` interface.
   */
  readonly uiRegistry?: UiRegistry;

  /**
   * Primitive catalogs declared in `ggui.json#primitives.{packages,local}`
   * and resolved at boot by `discoverPrimitives()` in
   * `@ggui-ai/project-config/node`. Threaded through here so future
   * consumers (generator wiring, capability introspection) can
   * enumerate every declared primitive source without re-reading the
   * manifest.
   *
   * The server itself does NOT yet thread these into the generation
   * pipeline. Making the catalogs visible at boot is the minimum
   * honest "capability is consumed" signal: the declaration is no
   * longer inert; any in-process host can read
   * `server.primitiveCatalogs`.
   *
   * Omitted = the zero-config default (the CLI passes the single
   * shipped `@ggui-ai/design/primitives` catalog; programmatic hosts
   * may pass whatever they discovered themselves).
   */
  readonly primitiveCatalogs?: readonly DiscoveredPrimitiveCatalog[];

  /**
   * Theme resolved at boot from `ggui.json#theme` by
   * `loadTheme()` in `@ggui-ai/project-config/node`. Threaded through
   * here so future consumers (console bootstrap, render endpoint,
   * MCP apps iframe) can pull the token tree + pre-rendered CSS block
   * without re-reading the manifest.
   *
   * The server itself does NOT yet inject theme CSS into console
   * or bake it into MCP responses. Making the theme visible at boot
   * is the minimum honest "capability is consumed" signal: the
   * declaration stops being inert; any in-process host can read
   * `server.theme`.
   *
   * Omitted = the zero-config default (the server builds a
   * `LoadedTheme` backed by `@ggui-ai/design`'s shipped `lightTheme`
   * internally; `server.theme.source === 'default'`).
   */
  readonly theme?: LoadedTheme;

  /**
   * Optional callback that persists a theme selection back to disk.
   *
   * The console `/theme` route mutates `ggui.json#theme` via this
   * callback. The server never touches the filesystem itself — the
   * caller (typically `@ggui-ai/cli`'s serve command) provides a
   * writer that knows where `ggui.json` lives and how to rewrite
   * just the `theme` field while preserving formatting + comments.
   *
   * Signature: receives the new {@link ThemeConfig} (or `null` to
   * clear the field and fall back to defaults). Returns a promise
   * that resolves once the write is durable. Throwing surfaces as
   * a 500 from `POST /ggui/console/theme` with the error message
   * forwarded to the operator.
   *
   * Omitted = `POST /ggui/console/theme` returns 501
   * (`writer_not_configured`). The picker stays browsable; clicking
   * "save" surfaces the missing-writer error instead of silently
   * writing nowhere.
   */
  readonly themeWriter?: ThemeWriter;

  /**
   * Optional callback that writes an uploaded DTCG theme document to a
   * file alongside `ggui.json`. Pairs with {@link themeWriter}: the
   * `POST /ggui/console/theme/upload` route invokes this first, then
   * calls `themeWriter` with `{ file: './<filename>', mode }`.
   *
   * Omitted = the upload route returns 501 and the picker hides its
   * "Upload theme.json" button. Provided alone (without a writer) is
   * also treated as "not configured" — both side-effects must land for
   * an upload to be meaningful.
   */
  readonly themeFileUploader?: ThemeFileUploader;

  /**
   * Live-theme getter. When set, the `ggui_render` handler reads this
   * on every result-meta computation and embeds the returned `id` /
   * `mode` into the `ai.ggui/render` slice meta. Pair with
   * {@link onThemeConfigChange} so a console save updates the
   * shared state cell the closure reads from. The cell pattern
   * closes the parallel-state-stores bug where the render handler
   * captured `themeId` at boot from the static `theme` opt and
   * silently ignored every subsequent ggui.json edit until restart.
   *
   * Returning `undefined` means "no theme override" — the static
   * `theme` opt's resolved id/mode (if any) take effect. Returning
   * `{ id, mode? }` always wins over the static path.
   */
  readonly themeProvider?: () =>
    | {
        readonly id?: string;
        readonly mode?: "light" | "dark";
      }
    | undefined;

  /**
   * Optional change notifier — fires when the operator's theme
   * selection changes via `POST /ggui/console/theme` (or the
   * `/upload` variant). Forwarded onto
   * `mountDevtoolThemeRoutes({onConfigChange})`. Pair with a
   * `themeProvider` closure that reads from the same shared cell
   * the callback writes to so a console save reaches the next render
   * without restarting the server.
   *
   * `next` matches `ThemeConfig` from `@ggui-ai/project-config` —
   * one of: a string shorthand (`'indigo'`), a preset object
   * (`{ preset, mode?, overrides? }`), a file object
   * (`{ file, mode? }`), or `null` (cleared).
   */
  readonly onThemeConfigChange?: (
    next:
      | string
      | { preset: string; mode?: "light" | "dark"; overrides?: Record<string, string> }
      | { file: string; mode?: "light" | "dark" }
      | null
  ) => void;

  /**
   * Map a resolved identity to the `appId` used by handlers for tenant
   * scoping. Defaults to `defaultAppIdFromIdentity` — single-user
   * `'builder'` for builder-kind identities, `userId`/`workspaceId`
   * for user-kind.
   */
  readonly appIdFromIdentity?: (result: AuthResult) => string;

  /**
   * Path the universal MCP endpoint mounts at. Defaults to `/mcp` per
   * Streamable HTTP convention. A deployment on a dedicated MCP
   * domain may override to `/` (bare root) so URLs stay short — the
   * domain already says "mcp", no need to repeat it in the path.
   *
   * Threaded into the well-known protected-resource metadata so OAuth
   * clients discover the right resource URL, and into the route table
   * so `app.post(${path})` / `app.get/delete(${path})` mount on it.
   */
  readonly universalMcpPath?: string;

  /**
   * Per-tenant URL routing. When set, the factory
   * additionally mounts `${pathPrefix}/:${paramName}`
   * alongside the universal path. The shared handler reads
   * `req.params[paramName]` and uses it as `ctx.appId`, overriding
   * `appIdFromIdentity` for that request.
   *
   * A multi-tenant deployment passes e.g. `{paramName: 'appId',
   * paramPattern: '[A-Za-z0-9]{8}', pathPrefix: '/apps'}` so URLs
   * like `example.com/apps/aB3kP9xY` route to a session scoped to
   * that specific app. The `/apps/` prefix segments the
   * namespace cleanly — no risk of an 8-char appId colliding with a
   * bare-root system route like `/health` or `/settings`.
   *
   * Without `pathPrefix`, the route mounts at the bare
   * `/:${paramName}` — useful only when the deployment owns the
   * entire URL space and the pattern guarantees no collision
   * (e.g. UUIDs).
   *
   * Pattern is a JS regex source (no slashes, no flags). `path-to-
   * regexp` v8 (express@5) dropped inline `:param(pattern)` route
   * syntax, so the factory enforces `paramPattern` with an `app.param`
   * validator (anchored full-match) rather than baking it into the
   * route string; a malformed appId 404s before reaching the handler.
   *
   * `authorize` is the deployment-specific access check. After auth
   * resolves but before session work begins, the handler invokes it
   * with the URL-supplied appId + identity. Throw to deny — the
   * handler converts to a 403 response and skips MCP processing.
   * Multi-tenant deployments use this to verify the resolved identity
   * owns the URL-addressed app — this is the boundary that prevents
   * cross-user blueprint reads when downstream stores don't enforce
   * ownership themselves. Deployments that opt in to per-app routing
   * without an authorize callback are TRUSTED — every authenticated
   * caller can scope to any URL appId.
   */
  readonly perAppRouting?: {
    readonly paramName: string;
    readonly paramPattern: string;
    /**
     * Optional path prefix prepended to the per-app route. Cloud
     * `mcp.ggui.ai` uses `'/apps'` so URLs are
     * `mcp.ggui.ai/apps/<appId>` — leaves the bare root for system
     * routes (`/health`, `/oauth/*`, `/.well-known/*`) without
     * collision concerns. Omit when the pattern alone guarantees
     * non-collision (e.g. UUIDs, opaque hex of fixed length).
     */
    readonly pathPrefix?: string;
    readonly authorize?: (urlAppId: string, identity: AuthResult) => Promise<void>;
  };

  /** Structured logger. Defaults to `createConsoleLogger()`. */
  readonly logger?: Logger;

  /**
   * Optional error-to-HTTP mapper invoked on any handler / transport
   * exception that surfaces past the MCP SDK. When the mapper returns
   * a `{status, code, message}` triple the factory writes that JSON-RPC
   * error response instead of the default `500 / -32603 'Internal
   * server error'`. Returning `undefined` (or omitting the option)
   * preserves the default.
   *
   * Use case: hosted closed-runtime deployments throw domain errors from
   * tool handlers (e.g. `GguiSessionAccessError` "this render doesn't belong
   * to you") that should map to HTTP 404 so callers can distinguish
   * tenancy violations from real server bugs. OSS deployments don't
   * need this seam — every domain error is a 500 unless they say
   * otherwise.
   *
   * The mapper MUST NOT throw. It runs inside the factory's outer
   * `catch (err)` block; any throw from the mapper itself is treated
   * as if it returned `undefined` (default 500).
   */
  readonly errorMapper?: (
    err: unknown
  ) => { readonly status: number; readonly code: number; readonly message: string } | undefined;

  /**
   * BYOK provider-key store consumed by the operator-facing
   * `/ggui/console/llm-keys` admin API and (today, transparently
   * via `ggui-cli`'s `ByokResolver`) by the generation pipeline.
   *
   * When set, the gated route block mounts:
   *   - `GET    /ggui/console/llm-keys`           — list providers + presence
   *   - `POST   /ggui/console/llm-keys`           — set a provider's key
   *   - `DELETE /ggui/console/llm-keys/:provider` — clear (idempotent)
   *
   * The store is the SAME instance backing the CLI's `ByokResolver`
   * second-step lookup (`~/.ggui/credentials.json` by default) — writing
   * via this API has immediate effect on subsequent generations because
   * `PlaintextFileProviderKeyStore` re-reads the file on every `get()`.
   *
   * Omitted (default): the route block is NOT mounted. Operators
   * who want the /settings UI to work pass a store explicitly. The
   * CLI binding does so for personal-mode `ggui serve`; programmatic
   * embedders (test suites, custom hosts) can omit it.
   */
  readonly providerKeys?: ProviderKeyStore;

  /**
   * Map an authenticated request to the BYOK scope key the
   * `/ggui/console/llm-keys` endpoints write under (and that the
   * generation pipeline reads via `ProviderKeyStore.get(scope, provider)`).
   *
   * Default depends on {@link providerKeysGate}:
   *   - `'admin-token'` (default): scope is always `'global'` — the
   *     OSS-personal posture: every caller who clears the admin gate
   *     operates on the single global keyset stored in
   *     `~/.ggui/credentials.json`.
   *   - `'auth-adapter'`: scope is derived from the authenticated
   *     identity — `userId` for `kind: 'user'`, `appId` for `kind: 'app'`,
   *     and `'global'` for `kind: 'builder'` (which under multi-tenant
   *     is rejected at the gate before this fires anyway).
   *
   * Operators with composite scopes (`${appId}:${userId}` for per-app-
   * per-user keysets) override this; the underlying store treats the
   * value as opaque. The `identity` arg is `null` under the
   * `'admin-token'` gate (no auth-adapter call happens) and the
   * resolved `AuthResult` under the `'auth-adapter'` gate.
   */
  readonly providerKeyScope?: (req: Request, identity: AuthResult | null) => string;

  /**
   * Which gate guards the `/ggui/console/llm-keys` plane.
   *
   *   - `'admin-token'` (default — OSS-personal posture): the gate
   *     accepts the admin bearer (Authorization header or
   *     `ggui_console_admin` cookie). Single global keyset; the
   *     /settings UI lets the operator paste keys that everyone uses.
   *   - `'auth-adapter'` (multi-tenant posture): the gate calls the
   *     server's configured `AuthAdapter` (same path as `/mcp`). Each
   *     authenticated end-user manages their OWN keys, scoped by
   *     {@link providerKeyScope} (default: `userId` / `appId`).
   *     `kind: 'builder'` identities are rejected at the gate — the
   *     posture is meaningless without a real per-caller identifier.
   *
   * Both gates require `providerKeys` to be set; route block is
   * unmounted otherwise. Under `'admin-token'`, the route block is
   * additionally unmounted when the server has no admin token wired
   * (e.g. embedding hosts that don't surface console routes). Under
   * `'auth-adapter'`, the admin token is irrelevant — the route is
   * mounted whenever `providerKeys` is set.
   */
  readonly providerKeysGate?: "admin-token" | "auth-adapter";

  /** Express body size limit. Defaults to `'4mb'`. */
  readonly bodyLimit?: string;

  /**
   * GguiSession store — backing plane for the live-channel render endpoint
   * (and OSS render-reading MCP tools). Defaults to
   * `InMemoryGguiSessionStore`, which is fine for OSS zero-config / dev.
   * SQLite / Postgres / Redis adapters bind via the same interface
   * when they land.
   */
  readonly renderStore?: GguiSessionStore;

  /**
   * Outbound stream replay buffer for the live-channel endpoint. Defaults
   * to a fresh `InMemoryGguiSessionStreamBuffer` — fine for OSS zero-config
   * / dev. Operators who need durability layer a different
   * `GguiSessionStreamBuffer` implementation behind this seam.
   *
   * Only used when `renderChannel` is enabled. Ignored otherwise.
   */
  readonly streamBuffer?: GguiSessionStreamBuffer;

  /**
   * Enable the OSS live-channel render endpoint at `/ws` (configurable).
   *
   *   - `false` (default): no render channel. `/mcp` is the only
   *     HTTP surface. Callers who only need the tool plane get the
   *     smallest shape.
   *   - `true`: mount the channel at the default path (`/ws`) with
   *     the default render store.
   *   - `{ path?: string }`: override the mount path.
   *
   * The live channel is where the live-contract enforcement point
   * lives. Enabling this makes the OSS server a second real consumer
   * of the shared `@ggui-ai/mcp-server-handlers/renders`
   * helpers.
   */
  readonly renderChannel?: boolean | { readonly path?: string };

  /**
   * Opt-in plumbing for `channel_subscribe` polling — the WS fan-out
   * path for `streamSpec[*].source.tool`. When present, the
   * render channel accepts `channel_subscribe` frames whose
   * `source.tool` is in `allowlist` and begins polling. When absent
   * (the OSS first-run zero-config posture), every `channel_subscribe`
   * rejects with `CHANNEL_NOT_LOCAL` so the iframe falls back to
   * direct polling via the MCP host proxy.
   *
   * The `allowlist` is also advertised on every successful
   * `ggui_handshake` response as
   * `serverCapabilities.streamWebSocketLocalTools` so `@ggui-ai/wire`
   * agrees with the server on which channels use WS fan-out.
   *
   * Only consulted when `renderChannel` is enabled. Forwarded
   * verbatim to `createGguiSessionChannelServer` (see
   * `GguiSessionChannelOptions.streamWebSocketLocalTools`).
   */
  readonly streamWebSocketLocalTools?: import("./ggui-session-channel.js").GguiSessionChannelLocalToolsOptions;
  /**
   * Hook fired when the local subscriber count for `sessionId`
   * transitions 0 → 1 on the live channel. Forwarded verbatim to
   * `createGguiSessionChannelServer`. Used by cloud adapters for per-render
   * cross-pod pubsub channel scoping; OSS callers leave this undefined.
   *
   * Only consulted when `renderChannel` is enabled. See
   * `GguiSessionChannelOptions.onFirstSubscriber` for the full contract.
   */
  readonly onFirstSubscriber?: (sessionId: string) => void;
  /**
   * Hook fired when the local subscriber count for `sessionId`
   * transitions 1 → 0 on the live channel. Forwarded verbatim to
   * `createGguiSessionChannelServer`.
   *
   * Only consulted when `renderChannel` is enabled. See
   * `GguiSessionChannelOptions.onLastSubscriberGone` for the full contract.
   */
  readonly onLastSubscriberGone?: (sessionId: string) => void;
  /**
   * Extra reserved-channel payload validators merged with the
   * server's default A2UI preview validator before being passed to
   * the render channel (Item 4 injection pattern). Caller-provided
   * entries WIN on key conflict — the pattern is "server supplies
   * defaults, operator may replace by key".
   *
   * Absent = the server binds only the A2UI validator for
   * `_ggui:preview` by default. `_ggui:lifecycle` is validated
   * via the protocol-shipped builtin regardless of this option.
   *
   * Pass `new Map()` (explicitly empty) to DISABLE the A2UI default —
   * useful in tests that want to assert `validateStreamData`'s
   * fall-through behavior on `_ggui:preview` without the adapter
   * running.
   */
  readonly extraReservedValidators?: ReadonlyMap<
    string,
    import("@ggui-ai/protocol").ReservedChannelValidator
  >;

  /**
   * Protocol-version handshake policy for the render channel. Forwarded
   * verbatim to `createGguiSessionChannelServer` (see
   * `GguiSessionChannelOptions.versionPolicy`). Defaults to `'reject'` —
   * mismatched `SubscribePayload.supportedVersions` emits
   * UPGRADE_REQUIRED and closes the connection. Legacy opt-out
   * `'advisory'` keeps the connection open after the error frame for
   * controlled migration windows.
   *
   * Only consulted when `renderChannel` is enabled.
   */
  readonly versionPolicy?: "advisory" | "reject";

  /**
   * Policy for the schema compat check. Checks that every
   * `actionSpec[name]` tool ref points at a tool whose
   * `inputSchema` is a superset of the
   * action's declared `schema`, and that every
   * `streamSpec[channel].tool` ref points at a tool whose return
   * schema fits inside the channel's declared `schema`.
   *
   *   - `'reject'` (default) — violations throw before the render
   *     commits (or before blueprint registration completes).
   *     Canonical enforcement posture for launch.
   *   - `'warn'` — violations log through the server's structured
   *     logger (`schema_compat_warn` event with the full report
   *     attached). Caller's flow continues. Used for controlled
   *     migration windows.
   *   - `'off'` — check is skipped entirely. Test / opt-out
   *     convenience.
   *
   * Applies to both check points wired by this server:
   *
   *   1. The console `POST /ggui/console/blueprint/:id/try`
   *      endpoint (blueprint registration — fires when a manifest
   *      blueprint's pre-declared `actionSpec` / `streamSpec`
   *      references a tool mounted on this server).
   *   2. The `ggui_render` generation path (render-time — defensive
   *      wiring for when the generator starts emitting
   *      actionSpec / streamSpec on its `UIGenerationResponse`;
   *      current generators emit only componentCode, but the
   *      hook is in place so the check fires automatically when
   *      generator outputs widen).
   *
   * See `./schema-compat.ts` for the check helper contract, and
   * `@ggui-ai/protocol/validation/{schema-subset,zod-to-json-schema}`
   * for the underlying primitives.
   */
  readonly schemaCompatCheck?: SchemaCompatMode;

  /**
   * Enable OAuth 2.1 + PKCE + Dynamic Client Registration on this
   * server (per MCP spec 2025-06-18+).
   *
   *   - `false` / omitted (default): OAuth routes NOT mounted;
   *     `WWW-Authenticate` header NOT set on 401 responses. Pure-bearer
   *     clients (CLI tools shipping `Authorization: Bearer ggui_user_*`)
   *     still work; OAuth-discovery clients (Claude Desktop, claude.ai,
   *     Goose, etc.) bail with "couldn't reach" / "couldn't authenticate".
   *   - `true`: enable with defaults. Mounts:
   *       GET  /.well-known/oauth-protected-resource (RFC 9728)
   *       GET  /.well-known/oauth-authorization-server (RFC 8414)
   *       POST /oauth/register (RFC 7591 DCR)
   *       GET  /oauth/authorize (paste-key form)
   *       POST /oauth/authorize (form submit)
   *       POST /oauth/token (code → access_token)
   *     Adds `WWW-Authenticate: Bearer realm=mcp, resource_metadata=…`
   *     header to 401 responses on `/mcp`. Storage defaults to
   *     {@link InMemoryOAuthStorage}.
   *   - `{ issuerUrl?, storage? }`: explicit config. `issuerUrl` is the
   *     public origin the server advertises in metadata + redirects
   *     (defaults to derivation from `X-Forwarded-Proto`/`Host`);
   *     `storage` swaps the in-memory map for a Redis/DDB-backed
   *     implementation when multi-replica deployments need stateless
   *     token exchange.
   *
   * The OAuth flow is a one-time ceremony per Claude Desktop install:
   * the user pastes their `ggui_user_*` API key once, the server hands
   * it back as the `access_token`. Subsequent `/mcp` calls hit the
   * existing {@link AuthAdapter} (e.g. `ApiKeyAuthAdapter`) unchanged.
   * See `./oauth.ts` for the full flow.
   */
  readonly oauth?: boolean | OAuthConfig;

  /**
   * Enable the MCP Apps outbound delivery path on this server.
   *
   *   - `false` / omitted (default): `ggui_render` is NOT registered;
   *     `ui://ggui/render` is NOT served; `io.modelcontextprotocol/ui`
   *     is NOT advertised. Server looks identical to the pre-MCP-Apps
   *     surface.
   *   - `true`: enable with sensible defaults. Requires
   *     `renderChannel: true` so the iframe has a WebSocket to open;
   *     throws at construction otherwise.
   *   - `{ shellHtml?, wsUrl? }`: explicit config.
   *
   * When enabled, FOUR things happen on every fresh per-request
   * `McpServer`:
   *   1. `ggui_render` tool is registered, carrying `_meta.ui.resourceUri:
   *      "ui://ggui/render"` and `_meta.ui.visibility: ["model"]` on
   *      its declaration.
   *   2. `ui://ggui/render` is served via `resources/read`.
   *   3. `io.modelcontextprotocol/ui` is advertised in the server's
   *      `initialize` capabilities (under `experimental`).
   *   4. Each `ggui_render` result carries the `ai.ggui/render` slice
   *      with wsUrl + short-TTL token + expiresAt. The render-channel
   *      server accepts that token on `subscribe` and issues a
   *      longer-TTL `sessionToken` in the ack for iframe reconnects.
   */
  readonly mcpApps?:
    | boolean
    | {
        readonly shellHtml?: string;
        /**
         * External WebSocket URL the iframe should open, visible to
         * MCP Apps hosts. Defaults to `"ws://localhost:<port>/ws"`
         * — only sensible for local dev. Production operators pass
         * their public URL (`wss://mcp.example.com/ws`).
         */
        readonly wsUrl?: string;
      };

  /**
   * Iframe-runtime bundle mount (C8 — plan §C8).
   *
   * The thin-shell HTML served from `ui://ggui/render` dynamic-
   * script-loads the renderer bundle from this URL. The server needs
   * to either (a) serve the bundle itself (default), or (b) publish
   * the operator-owned URL on the `ai.ggui/render.runtimeUrl` slice
   * field so the shell knows where to look.
   *
   *   - `true` / omitted (default when `mcpApps` is on): serve the
   *     bundle via `express.static` at `/_ggui/iframe-runtime.js` from the
   *     `@ggui-ai/iframe-runtime` package's built `dist/iframe-runtime.js`.
   *     `runtimeUrl` on the bootstrap becomes `/_ggui/iframe-runtime.js`.
   *   - `false`: no static mount. Operator MUST supply
   *     `runtime.url` so the bootstrap still carries a valid URL
   *     (or the shell will fail `MALFORMED_BOOTSTRAP`).
   *   - `{ path?, distDir?, url? }`: explicit config. `path` is the
   *     HTTP route under which the bundle is served (default
   *     `/_ggui/iframe-runtime.js`); `distDir` overrides the
   *     {@link @ggui-ai/iframe-runtime/server!RUNTIME_BUNDLE_FILE} auto-
   *     resolution for advanced embeddings; `url` overrides the URL
   *     written onto the bootstrap (useful when a CDN / proxy fronts
   *     the bundle — mount here for local verification, publish the
   *     external URL to clients).
   *
   * Ignored entirely when `mcpApps` is disabled.
   */
  readonly runtime?:
    | boolean
    | {
        readonly path?: string;
        readonly distDir?: string;
        readonly url?: string;
      };

  /**
   * Connector registry for external MCP servers. Required to accept
   * inbound MCP Apps render payloads (`shortcuts.mcpApps`) and for the
   * `/mcp-apps/resource` proxy route to resolve source-server
   * endpoints. Absent = inbound MCP Apps hosting disabled.
   */
  readonly connectors?: ConnectorRegistry;

  /**
   * HMAC secret used to sign bootstrap + session tokens. When the MCP
   * Apps outbound path is enabled and no secret is passed, the server
   * mints a random 32-byte secret at boot — fine for dev + a single
   * long-running process, wrong for multi-host deployments (each host
   * would reject the others' tokens). Production operators MUST pass
   * a deterministic secret (typically from env / secrets manager).
   *
   * Ignored entirely when MCP Apps is disabled.
   */
  readonly wsTokenSecret?: string;

  /**
   * Enable the pairing transport. Adds `POST /pair` (public, completes a
   * pairing handshake) and by default `POST /admin/pair/init` (builder-
   * authenticated, mints a one-shot code).
   *
   *   - `false` / omitted (default): pairing routes are NOT mounted.
   *     `GguiServer.pairingService` is `null`. The server is still a
   *     valid MCP server; pairing is simply not part of its surface.
   *   - `true`: enable with defaults. Constructs an
   *     `InMemoryPairingService` and bridges its `onTokenIssued` /
   *     `onTokenRevoked` callbacks into the configured {@link auth}
   *     adapter. Requires the adapter to implement
   *     `registerToken`/`unregisterToken` (see
   *     `isTokenRegisteringAuthAdapter`); throws at construction
   *     otherwise.
   *   - `{ service?, serverName?, path?, adminInitPath? }`: explicit
   *     config. When `service` is omitted, the default
   *     `InMemoryPairingService` + auth-adapter bridge is constructed
   *     as above. When `service` is provided, the caller owns the
   *     service's lifecycle AND the auth bridge — `createGguiServer`
   *     mounts the HTTP routes only.
   *
   * Pairing-minted tokens authenticate subsequent `/mcp` and live-channel
   * requests through the normal bearer path — the bridge registers them
   * into the active AuthAdapter, NOT a parallel pairing-only store.
   */
  /**
   * Enable the persistent-chat HTTP transport. Mounts six routes under
   * the configured path (defaults to `/threads`):
   *
   *   POST   /threads                  — createThread
   *   GET    /threads                  — listThreads
   *   GET    /threads/:id              — getThread
   *   PATCH  /threads/:id              — applyThreadAction
   *   GET    /threads/:id/messages     — listMessages
   *   POST   /threads/:id/messages     — appendMessage
   *
   *   - Omitted / undefined (default): no thread routes. The server is
   *     still a valid MCP server + optional live-channel host; persistent
   *     chat simply isn't part of its surface.
   *   - `{ store: ThreadStore }`: enable with the supplied store. OSS
   *     dev callers pass `new InMemoryThreadStore()`. SQLite binding
   *     (Step 6 of the slice) plugs in the same way.
   *   - Extra fields (`path`, `ownerFromIdentity`) are power-user
   *     overrides — sensible defaults otherwise.
   *
   * SSE observe endpoint (`GET /threads/:id/stream`) is Step 5 of the
   * same slice; it lands behind this option but in a separate route.
   */
  readonly threads?: {
    readonly store: ThreadStore;
    /**
     * URL prefix. Defaults to `/threads`. Operators who already have
     * another server mounted under `/threads` override here.
     */
    readonly path?: string;
    /**
     * Identity → ownerId mapping override. Defaults to
     * `defaultThreadOwnerFromIdentity` from `thread-transport.ts`:
     * pairing metadata → `paired_<pairingId>`; cognito → `cognito_<sub>`;
     * kind=user → `user_<workspaceId ?? userId>`; everything else →
     * `DEFAULT_BUILDER_OWNER_ID` ("builder").
     */
    readonly ownerFromIdentity?: ThreadOwnerResolver;
    /**
     * Durability advertisement for the thread store. Surfaced on
     * `GET /ggui/health` under `threads.durability` so Portal + other
     * clients can decide whether to display a non-durable caveat.
     *
     *   - `'durable'`: data survives server restart. `ggui serve`
     *     resolves this automatically when `storage.threads.driver ===
     *     'sqlite'` is declared in `ggui.json`.
     *   - `'ephemeral'` (default): in-memory or otherwise lost on
     *     restart. Safe default — overclaiming durability would mislead
     *     Portal into hiding its caveat.
     *
     * Embedded hosts that supply a custom `store` also supply the
     * right durability claim; the server doesn't inspect the store
     * instance to guess.
     */
    readonly durability?: "durable" | "ephemeral";
  };

  readonly pairing?:
    | boolean
    | {
        /**
         * Custom PairingService implementation. When present, the
         * caller owns the service's full lifecycle including any
         * `onTokenIssued` / `onTokenRevoked` bridging into their auth
         * adapter. When absent, a default `InMemoryPairingService`
         * is constructed and bridged automatically.
         */
        readonly service?: PairingService;
        /**
         * Server display name the default `InMemoryPairingService`
         * surfaces in `PairingInit.serverName` and `PairingCompletion
         * .serverName`. Defaults to `info.name`. Ignored when
         * {@link service} is provided.
         */
        readonly serverName?: string;
        /**
         * When set, the default `InMemoryPairingService` persists
         * its pairings + idCounter to this JSON file (atomic write,
         * `0600` perms) and restores them on subsequent boots —
         * tokens survive a `ggui serve` restart. Tokens are stored in
         * **plaintext**: assume the file lives on operator-controlled
         * disk (e.g. `~/.ggui/keys.json`). For multi-operator or
         * untrusted-host deployments swap to a hashed adapter.
         * Ignored when {@link service} is provided.
         */
        readonly persistencePath?: string;
        /**
         * URL path the `POST /pair` route is mounted at. Defaults to
         * `/pair`.
         */
        readonly path?: string;
        /**
         * URL path the `POST /admin/pair/init` route is mounted at.
         * Defaults to `/admin/pair/init`. Pass `null` to disable the
         * HTTP-triggered mint path — embedded hosts that call
         * `GguiServer.pairingService.initPairing()` programmatically
         * may not want the route.
         */
        readonly adminInitPath?: string | null;
        /**
         * URL-template the `POST /admin/pair/:pairingId/revoke` route
         * is mounted at. Defaults to `/admin/pair/:pairingId/revoke`.
         * Pass `null` to disable the HTTP-triggered revoke path —
         * embedded hosts that call `GguiServer.pairingService
         * .revokePairing()` programmatically may not want the route.
         */
        readonly adminRevokePath?: string | null;
      };

  /**
   * Operational / product-signal sink. Bound once at composition;
   * transports + handlers call `emit` for lossy counts / durations.
   * Defaults to {@link NoopTelemetrySink} — an OSS deployment that
   * doesn't care about metrics sees zero-cost no-op. Real adapters
   * (OTLP, CloudWatch, Datadog) plug in here.
   *
   * Sync, fire-and-forget, MUST NOT throw — see `TelemetrySink`.
   */
  readonly telemetry?: TelemetrySink;

  /**
   * Durable audit-log sink for privileged actions (pairing-token
   * lifecycle today; API-key lifecycle + admin mutations follow in
   * later slices). Bound once at composition; ingress points await
   * `record` and surface failure.
   *
   * Defaults to {@link NoopAuditSink} with a boot-time `warn` log —
   * same pattern as the missing-auth-adapter warning. Production
   * deployments MUST bind a durable implementation (DynamoDB /
   * Postgres journal / Kafka topic) because privileged actions
   * leaving no record is a compliance breach.
   */
  readonly audit?: AuditSink;

  /**
   * Admission-control limiter applied at the highest-cost handler
   * ingress — today just `ggui_render`. Defaults to
   * {@link NoopRateLimiter} (always allows). Per-handler wiring maps
   * denials from a `RateLimitedError` to HTTP 429 + `Retry-After` /
   * `X-RateLimit-*` headers at the transport boundary.
   *
   * For real policy (per-app or per-identity windows), bind a
   * `FixedWindowRateLimiter` over a durable
   * {@link import('@ggui-ai/mcp-server-core').QuotaStore} — or any
   * adapter that implements the same contract. Handlers never see the
   * policy shape; they just call `check` and honor the decision.
   *
   * Wiring only the highest-cost handler is intentional. Other
   * handlers (blueprint search, thread reads, pairing) follow as
   * individual slices when real policy signal demands it.
   */
  readonly rateLimiter?: RateLimiter;

  /**
   * CSRF secret used to HMAC-sign double-submit tokens for browser
   * POST/PUT/DELETE/PATCH endpoints. Production deployments pass a
   * stable value (so tokens survive a deploy); OSS dev defaults to a
   * fresh per-process random — pre-restart tokens won't validate
   * after restart, which is acceptable for dev where sessions don't
   * survive a restart anyway.
   */
  readonly csrfSecret?: string;

  /**
   * Trust the `X-Forwarded-For` header for per-IP rate limiting on
   * `/pair`. Operators behind a reverse proxy / load
   * balancer that strips and re-attaches a trusted client-IP header
   * pass `true`; localhost-only dev paths leave it falsy so requests
   * key on `req.socket.remoteAddress` instead.
   */
  readonly trustProxy?: boolean;

  /**
   * Public base URL the server is reachable at — REQUIRED for OAuth
   * login routes. Composes the `redirect_uri` registered
   * with each OAuth provider's console as
   * `${publicBaseUrl}/ggui/oauth-login/<providerId>/callback`. If
   * absent, OAuth login routes are NOT mounted (admin transport
   * still mounts so operators can paste credentials in advance).
   */
  readonly publicBaseUrl?: string;

  /**
   * Override path for `~/.ggui/oauth-providers.json`. Mainly for
   * tests + per-deployment isolation. Defaults to the home-relative
   * path resolved by `createOAuthProvidersStore`.
   */
  readonly oauthProvidersPath?: string;

  /**
   * Server-level instructions surfaced on the MCP `InitializeResult.
   * instructions` field. MCP hosts (Claude.ai web, Claude Desktop,
   * the MCP Inspector) inject this into the LLM's system prompt as a
   * top-level block, ABOVE per-tool descriptions — influencing
   * "how should I behave with this server's tools generally?"
   *
   *   - Omit (`undefined`): use the package default (`'default'`
   *     preset — sensible "ggui first when UI fits" nudge).
   *   - Preset name: `'default' | 'aggressive' | 'minimal' | 'off'`.
   *     `'aggressive'` matches a manual "always use ggui_*" custom
   *     instruction. `'off'` omits the field entirely.
   *   - Arbitrary string: used verbatim. Lets operators write
   *     deployment-specific copy without forking the package.
   *
   * Since OSS forks can edit `instructions-presets.ts` directly, the
   * preset enum is a convenience dial, not a contract — devs are
   * welcome to ship custom strings or tweak the presets to match
   * their fleet's voice.
   */
  readonly mcpInstructions?: McpInstructionsValue;

  /**
   * Email magic-link login config. When set, mounts
   * `POST /ggui/email-login/start`, `GET /ggui/email-login/verify`,
   * and `GET /ggui/email-login/config` so the `/login` UI can offer
   * a passwordless email path. Requires `publicBaseUrl` so the magic
   * link the user clicks resolves back to this server.
   *
   *   - `false` / omitted: no email login routes mounted. `/login`
   *     fetches `/ggui/email-login/config` → 404 → hides the form.
   *   - `{ sender, fromAddress, ... }`: opt-in. The `sender` is the
   *     transport (use `ConsoleEmailSender` for dev; SMTP / Resend /
   *     SES adapters for production). `fromAddress` is stamped on
   *     every outgoing message.
   *
   * Authentication: callbacks mint
   * `{ kind: 'user', userId: 'email:<lowercased-email>', roles: [] }`
   * via `auth.registerToken`. The configured `auth` adapter MUST
   * support `registerToken` — pairing-incompatible adapters
   * (Cognito/OIDC) can't accept email login.
   */
  readonly emailLogin?: {
    readonly sender: EmailSender;
    readonly fromAddress: string;
    readonly store?: MagicLinkStore;
    readonly subject?: string;
    readonly bodyText?: string;
    readonly bodyHtml?: string;
  };

  /**
   * Enable the `@ggui-ai/console` operator landing page. When
   * enabled, the server:
   *
   *   - Mounts `GET /ggui/console/info` — returns
   *     `{ server, version, description?, pairing: { enabled, pending } }`
   *     as JSON. Consumed by the landing-page SPA on first load.
   *   - Mounts `express.static` at the configured `path` (default `/`)
   *     pointing at the console's built `dist/`.
   *
   * Boundary lock:
   *
   *   - Same-origin ONLY — not a Portal replacement, not an MCP Apps
   *     iframe shell.
   *   - No same-origin cookie, no render viewer, no WebSocket
   *     wiring yet.
   *
   * Options:
   *
   *   - `false` / omitted (default): no console mount. The server
   *     is identical to the pre-console surface.
   *   - `true`: mount at `/` with the package's built-in `dist/`.
   *   - `{ path?, distDir? }`: override the URL path (`path`) and/or
   *     the filesystem dir that Express serves (`distDir`). `distDir`
   *     is primarily a test-fixture seam — production should leave it
   *     unset so the package-shipped bundle is served.
   *
   * If the resolved `distDir` does not exist on disk when the route is
   * hit, the server responds with 503 + a clear hint pointing operators
   * at `pnpm --filter @ggui-ai/console build`. Silent 404 would be
   * a worse failure mode — operators would think console was
   * broken rather than unbuilt.
   */
  readonly console?:
    | boolean
    | {
        /** URL path to mount at. Defaults to `/`. */
        readonly path?: string;
        /**
         * Override the filesystem dir Express serves. Defaults to the
         * package-shipped `dist/` (`CONSOLE_DIST_DIR`). Primarily a
         * test-fixture seam.
         */
        readonly distDir?: string;
        /**
         * Enable the Slice-2 same-origin session-cookie flow
         * (`POST /ggui/console/session-cookie` + render-channel
         * cookie-auth wiring). Defaults to OFF — the landing-page
         * static surface is useful on its own (pair-code display,
         * server identity); turning on the cookie flow is an
         * explicit step that pulls in additional deps.
         *
         * Enabling REQUIRES `renderChannel: true` — the cookie only
         * authenticates the live-channel WebSocket upgrade, so a cookie
         * flow without a channel to use it on would be pointless +
         * confusing. Throws at construction if that invariant fails.
         *
         * Enabling REQUIRES a configured {@link shortCodeIndex} — the
         * cookie endpoint resolves shortCode → sessionId by reading
         * it. Throws at construction if the index is absent.
         *
         * The cookie signing secret is the same {@link wsTokenSecret}
         * used by the MCP Apps bootstrap/render tokens — different
         * token `kind` claims make cross-kind confusion impossible
         * (see `console-auth.ts` isolation comment).
         */
        readonly sessionCookie?:
          | boolean
          | {
              /**
               * Cookie TTL in seconds. Defaults to 8 hours
               * (`DEFAULT_DEVTOOL_SESSION_TTL_SEC`).
               */
              readonly ttlSec?: number;
              /**
               * Add `Secure` to the Set-Cookie attributes. Explicit
               * because auto-detecting TLS through a reverse proxy
               * is unreliable — operators passing `true` when their
               * public URL is HTTPS is the safe contract.
               */
              readonly secure?: boolean;
            };
        /**
         * Admin bearer that gates the operator-only console routes
         * (`/ggui/console/keys*`, `/ggui/console/admin-login`). When
         * absent, `createGguiServer` mints `ggui_admin_<base64url(9)>`
         * at boot — surfaced on {@link GguiServer.adminToken} so the
         * CLI banner can print it. Operator passes `--admin-token <t>`
         * to pin a stable value across restarts.
         *
         * The gate accepts either an `Authorization: Bearer <token>`
         * header OR the `ggui_console_admin` cookie set by the
         * admin-login route. Other console routes (registry, renders,
         * cached blueprints, …) are NOT gated by this token — that's
         * a separate audit slice. The keys plane is the immediate
         * threat: plaintext bearer rendering + mint + revoke must not
         * be reachable to anyone who finds the URL over a tunnel.
         */
        readonly adminToken?: string;
        /**
         * Onboarding-redirect probe. Called per `GET /` request; if
         * it returns a non-null path, the server responds 302 to that
         * path instead of the SPA index. Use this to send first-run
         * operators (no LLM credentials configured) to the assistant-
         * connection flow before the chat playground is meaningful.
         *
         * The probe is recomputed every request — once the operator
         * sets a key, the next visit serves the SPA normally. Scoped
         * to the root path only; deep links bypass the redirect so
         * `/preview/<id>` / `/blueprints` / etc. continue to work.
         *
         * Return `null` to fall through to the SPA. Returning the
         * same path the request is already on is a no-op (the server
         * compares before redirecting to avoid loops).
         */
        readonly landingRedirect?: () => string | null;
      };

  /**
   * Public welcome page served at the console root (`/`) when the
   * console is mounted there.
   *
   * Resolved from `ggui.json#operator` + `ggui.json#app.name` by the
   * `ggui serve` CLI; programmatic embedders pass whatever values
   * fit their context. The page identifies who runs the server
   * (operator block — hidden entirely when nothing is configured)
   * and links to the public deep-link surfaces (`/preview/<id>`,
   * `/s/<shortCode>`) plus an "Operator login →" affordance pointing
   * at `/admin-login`.
   *
   * Posture: this page is the ONLY unauthenticated SPA-mount HTML
   * surface alongside `/admin-login`. Every other client-side route
   * (`/admin/*`, `/devtools/*`) requires the admin cookie/bearer.
   *
   * Omitted = the legacy SPA index handler runs at `/` (no welcome
   * page; the SPA handles its own root-route render).
   *
   * Ignored when `console.path !== '/'` — operators mounting console
   * on a non-root prefix already opted out of the welcome page surface.
   */
  readonly welcomePage?: {
    /** Operator-block input. Hidden entirely when omitted/empty. */
    readonly operator?: OperatorConfig;
    /**
     * Display name for the running app (typically `ggui.json#app.name`).
     * Falls back to the server identity name when omitted.
     */
    readonly appName?: string;
  };

  /**
   * Index for resolving `shortCode → { sessionId, appId }`. Required
   * when `console.sessionCookie` is enabled (the cookie endpoint
   * looks up the posted shortCode to find the render to bind).
   *
   * Pair this with a `render` handler so the agent's `ggui_render` writes
   * the shortCode into the same index that console later reads.
   * See `defaultHandlers` for the wiring seam.
   */
  readonly shortCodeIndex?: ShortCodeIndex;

  /**
   * Content-addressable code blob storage. When wired, this server
   * mounts `GET /code/<hash>.js` for the iframe runtime to fetch
   * compiled componentCode by content hash. The render handler writes
   * to the store before emitting `codeUrl` on the `ai.ggui/render`
   * slice.
   *
   * Defaults: when omitted the route is NOT mounted; the render
   * handler falls back to inline base64 `componentCode` on the
   * `ai.ggui/render` slice (legacy delivery channel).
   *
   * OSS dev wires `FileSystemCodeStore` (rooted at `~/.ggui/code-cache/`)
   * via `ggui-cli/buildMcpServerBackend`. Tests wire
   * `InMemoryCodeStore` from `@ggui-ai/mcp-server-core/in-memory`.
   * A hosted closed runtime wires a durable adapter (e.g. S3-backed)
   * from its own closed-source package. The wire format is identical
   * across deployments — only the storage adapter changes.
   */
  readonly codeStore?: CodeStore;

  /**
   * Provisional A2UI preview wiring for `ggui_render`. When the config
   * flag is on, every qualifying component render kicks off the
   * supplied emitter; frames land on the reserved `_ggui:preview`
   * channel of the render.
   *
   * The server owns the `sendEnvelope` + registry plumbing — only
   * the emitter + flag + optional observers are caller-facing.
   *
   * Requires `renderChannel: true` + `mcpApps` enabled (preview
   * needs a channel to emit on AND a render handler to attach to).
   * When the flag is on without those, `createGguiServer` throws —
   * silent drop would make "I enabled preview and nothing fires"
   * look like a generation bug instead of a wiring bug.
   *
   * `ggui-cli`'s `buildMcpServerBackend` passes the deterministic
   * emitter from `@ggui-ai/preview-a2ui/emitters` as the OSS
   * default; hosted + programmatic hosts inject their own.
   */
  readonly provisionalPreview?: {
    /** Global kill-switch. Default `false` (no preview fan-out). */
    readonly enabled: boolean;
    /**
     * Caller-supplied producer. Absent = no preview even when
     * `enabled` is true (guardrail: hosts opting in must be
     * explicit about the producer).
     */
    readonly emitter: ProvisionalPreviewEmitter;
    /** Per-render predicate. See {@link ProvisionalPreviewConfig}. */
    readonly isEnabledFor?: ProvisionalPreviewConfig["isEnabledFor"];
    /** Lifecycle observer. Fires sync — must not throw. */
    readonly onOutcome?: (outcome: ProvisionalPreviewOutcome) => void;
    /** Clock override for tests. Defaults to `Date.now`. */
    readonly now?: () => number;
  };

  /**
   * Handshake preflight wiring. When `mcpApps` is enabled, the
   * server defaults to an `InMemoryKeyValueStore` + no negotiator:
   * `ggui_handshake` is registered, `ggui_render({handshakeId})` is
   * consumable, and handshake records persist for 10 minutes before
   * single-use consumption.
   *
   * Explicit overrides:
   *
   *   - `{kvStore}` — swap the persistence backend (e.g., SQLite
   *     when it lands) while keeping the default "no negotiator"
   *     shape.
   *   - `{kvStore, negotiator}` — wire a real negotiator (e.g. RAG
   *     in a hosted closed runtime) so handshake records carry a
   *     decision the paired render echoes as `structuredContent.decision`.
   *   - `false` — explicitly disable: `ggui_handshake` is NOT
   *     registered and `ggui_render({handshakeId})` falls back to
   *     the rejection shape.
   *
   * Omitted entirely means "use the default in-memory store when
   * `mcpApps` is on". That matches how `renderStore` and
   * `streamBuffer` default — no opt-in required for the OSS
   * first-run path.
   *
   * Requires `mcpApps` to be enabled — handshake is paired with
   * `ggui_render`, which is only registered under MCP Apps. Throws
   * at construction when handshake is explicitly enabled without
   * MCP Apps.
   */
  readonly handshake?:
    | false
    | {
        /**
         * Persistence plane. Omit to accept the default
         * `InMemoryKeyValueStore`.
         */
        readonly kvStore?: KeyValueStore;
        /**
         * Optional negotiator. Omit = handshake records stamp
         * `action: 'create'` + no-negotiator-bound reason.
         */
        readonly negotiator?: HandshakeNegotiator;
      };

  /**
   * Generation wiring for the `ggui_render` story path. When present,
   * every component render invokes the bound `UiGenerator` and commits
   * the result as a real `GguiSession`. Absent = placeholder mode:
   * `ggui_render` on the story path returns `codeReady: false`
   * without writing componentCode.
   *
   * Requires `mcpApps` to be enabled — generation attaches to
   * `ggui_render`, which is only registered when MCP Apps is on.
   * Throws at construction otherwise so a misconfigured server
   * doesn't silently drop the generator binding.
   *
   * The `@ggui-ai/ui-gen` package ships the OSS default
   * implementation (`createUiGenerator({adapter})`); a hosted closed
   * runtime supplies its own generator binding through the same seam.
   * BYOK resolution (env → credentials file) is the CLI layer's
   * concern — at this boundary the caller hands in a closure that
   * returns resolved credentials per render.
   */
  readonly generation?: GenerationDeps;

  /**
   * Read-only shared/seed blueprint pools for cross-deployment reuse.
   * Threaded into the handshake negotiator's `seedPools`. Built by the
   * CLI from `--seed-pool` artifacts; absent ⇒ no shared pool.
   */
  readonly seedPools?: readonly BlueprintPool[];

  /**
   * Optional multi-generator registry. When present, exposes named
   * generators (e.g. `ui-gen-default-haiku-4-5`,
   * `ui-gen-advanced-opus-4-7`) for consumers such as the blueprint
   * matcher, `ggui_ops_generate_blueprint`, the LLM-driven variant
   * selector, the console blueprint UI, and the benchmark framework.
   *
   * When omitted, `createGguiServer` auto-seeds a registry containing
   * `generation.uiGenerator` (when `generation` is supplied) so
   * consumers observe a non-empty registry by default. When supplied,
   * the caller's registry is used as-is; the caller is responsible
   * for including their `generation.uiGenerator` if they want it
   * discoverable.
   */
  readonly generators?: GeneratorRegistry;

  /**
   * Optional multi-variant blueprint store. When present, `Blueprint`
   * rows persist via this seam so `ggui_ops_generate_blueprint` and
   * render-on-cache-miss can read + write through it. When omitted,
   * `createGguiServer` auto-seeds an {@link InMemoryBlueprintStore}.
   */
  readonly blueprintStore?: BlueprintStore;

  /**
   * Optional variant selector. When present, the handshake handler
   * calls `selectVariant(candidates)` against the candidate list
   * returned by `blueprintStore.list((appId, contractHash))`. When
   * omitted, `createGguiServer` defaults to
   * {@link createDeterministicBlueprintSelector} — a deterministic
   * fallback ladder.
   *
   * Operators MAY swap in an LLM-driven selector without touching the
   * handler composition.
   */
  readonly blueprintSelector?: BlueprintSelector;

  /**
   * Optional multi-axis blueprint search. When present, the
   * three-step handshake reads through this seam for the
   * parallel-search half of step 2 (cache vs agent vs synth
   * routing). When omitted, `createGguiServer` auto-seeds an
   * `createInMemoryBlueprintSearch` against the resolved
   * `blueprintStore`. The auto-seeded search wires the optional
   * `embedding` provider when set, so cached `contractEmbedding`
   * fields on Blueprint rows surface in the embed axis without
   * additional caller wiring.
   *
   * Operators MAY swap in a vector-DB-backed search (Pinecone,
   * pgvector, OpenSearch) without touching downstream handlers —
   * the seam is the contract; the implementation is fungible.
   */
  readonly blueprintSearch?: BlueprintSearch;

  /**
   * External tool-handler bundles aggregated onto this server's
   * `/mcp` surface. Every mount's handlers register alongside
   * ggui's native tools, so one MCP session sees both — `tools/list`
   * enumerates ggui-native tools plus every mount's tools, and
   * `tools/call` dispatches uniformly.
   *
   * Each mount is a `{ name, handlers }` bundle where `handlers` is
   * `SharedHandler[]` — the exact shape ggui-native handlers use.
   * A fixture, hosted adapter, or programmatic host builds handlers
   * against the same `@ggui-ai/mcp-server-handlers` seams + zod
   * shapes they'd use for any ggui-native tool, then passes them
   * here.
   *
   * Collision rules: mount tool names MUST NOT collide with a
   * ggui-native tool name OR with any other mount's tool name.
   * Composition throws on collision so misconfiguration surfaces
   * at server-construction time rather than as a surprising
   * "tools/call dispatched to the wrong handler" at runtime.
   *
   * Ignored when {@link handlers} is set — callers who pass a
   * custom handler list compose the final list themselves.
   */
  readonly mcpMounts?: ReadonlyArray<McpServerMount>;

  /**
   * Isolated MCP services — each mounted at its own HTTP path with
   * its own tool namespace. Unlike {@link mcpMounts} (which aggregates
   * tools onto the shared audience-filtered routes), every entry here
   * becomes a self-contained MCP server reachable at `app.post(path)`.
   *
   * Use a service when the handler set is conceptually a distinct MCP
   * server (`mcp.ggui.ai/docs`, `mcp.ggui.ai/playground/todos`). Use a
   * mount when the handlers should appear alongside ggui-native tools
   * on the shared `/mcp` surface.
   *
   * Compose-time invariants are enforced by `validateMcpServices`:
   * unique non-reserved paths, non-empty handler `outputSchema`, no
   * `audience` tags on service handlers, no within-service tool-name
   * collisions. Cross-service tool-name collisions ARE allowed.
   *
   * Empty / absent → no service routes mounted, no behavior change.
   */
  readonly mcpServices?: ReadonlyArray<McpService>;

  /**
   * Per-request resource registrars run against every fresh
   * `McpServer` instance, after the MCP-Apps outbound install (when
   * enabled) and before tool registration. The hook is the canonical
   * extension seam for hosts that mount cross-cutting MCP App UI
   * bundles (e.g. a `ui://`-scheme resource for system-level cards)
   * without baking the bundle's wiring into this OSS factory.
   *
   * Each registrar receives the per-request `McpServer`; misuse
   * (duplicate URI, malformed declaration) throws synchronously and
   * fails the request before tool dispatch, surfacing the
   * misconfiguration immediately. Idempotent in spirit — the
   * underlying SDK rejects duplicate registrations.
   */
  readonly extraResources?: ReadonlyArray<(server: McpServer) => void>;

  /**
   * Per-domain dep seams for the twelve operator-class `ggui_ops_*`
   * handlers covering the console's apps + orgs + connector-keys +
   * coupon surfaces. Each domain is independently optional —
   * `defaultHandlers` registers a domain's tools only when its seam
   * is bound here. OSS deployments leave these undefined (the smaller
   * surface); cloud pods bind AppSync-backed adapters.
   *
   * Mirrors `creditBalance` + `creditTransactions`'s pattern — the
   * shared-handler layer is the same code path everywhere, and the
   * deps interface is the boundary between the open handler and the
   * deployment-specific implementation.
   */
  readonly opsApps?: {
    readonly apps: AppsSource;
    readonly userDefaultApp: UserDefaultAppSource;
  };
  readonly opsOrgs?: {
    readonly orgs: OrgsSource;
    readonly invites: OrgInvitesSource;
  };
  readonly opsConnectorKeys?: {
    readonly connectorKeys: ConnectorKeysSource;
  };
  readonly opsCoupon?: {
    readonly coupons: CouponRedeemSource;
  };

  /**
   * Extra readiness checks merged into `GET /ggui/health`. Each check
   * is a `{name, check}` pair; `check()` returns a boolean (or a
   * Promise<boolean>) — `true` means "this dependency is ready".
   *
   * When ANY check returns `false` (or throws), `/ggui/health` answers
   * `503 Service Unavailable` with `status: 'degraded'` + a `checks`
   * map naming each failing dependency. The default `200 ok` shape is
   * preserved when every check passes (and when the option is unset).
   *
   * Use this when an embedder wires a stateful external dependency
   * (e.g. a pubsub subscriber connection, a vector-store reachability
   * probe, a worker-pool health view) and wants its K8s readinessProbe
   * to take the pod OUT OF SERVICE when that dependency fails. The
   * sibling `/ggui/live` endpoint is unaffected — that is the K8s
   * livenessProbe target and stays 200 regardless of readiness, so a
   * transient upstream blip removes the pod from rotation without
   * restarting the process. Wire the two probes separately:
   *
   *     livenessProbe:  { httpGet: { path: '/ggui/live',   port } }
   *     readinessProbe: { httpGet: { path: '/ggui/health', port } }
   *
   * Each check MUST complete within ~1s; the server enforces a 1s
   * per-check timeout so a hung dependency cannot block the probe.
   * A timeout is treated as a failed check.
   */
  readonly readinessChecks?: ReadonlyArray<{
    readonly name: string;
    readonly check: () => boolean | Promise<boolean>;
  }>;
}

export interface GguiServer {
  /**
   * The Express app. Mount it under your own parent router if you want
   * to add middleware, or call {@link listen} for the zero-config path.
   */
  readonly app: Express;
  /**
   * Bind the app to a port and return the underlying `node:http` server.
   * Resolves once the listener is accepting connections.
   */
  listen(port?: number, host?: string): Promise<NodeHttpServer>;
  /** Close every outstanding HTTP connection. Idempotent. */
  close(): Promise<void>;
  /**
   * Number of MCP tools registered on this server. Same value the
   * `GET /ggui/health` endpoint echoes. Useful for hosts (CLIs,
   * dashboards, tests) that want to surface a real count without
   * round-tripping over HTTP.
   */
  readonly toolCount: number;
  /**
   * The OSS live-channel render endpoint, when `renderChannel` was
   * enabled. `null` when disabled. Hosts can use this for
   * introspection (`.renderCount`, `.subscriberCount`) or for
   * composition with future mutation handlers that want to fan out
   * via `renderChannel.sendToGguiSession(sessionId, data)`.
   */
  readonly renderChannel: GguiSessionChannelServer | null;
  /**
   * The pairing service bound to this server, when the `pairing` option
   * was enabled. `null` when pairing is disabled. In-process hosts
   * (CLIs, embedded viewers) use this to call `initPairing()` directly
   * instead of POSTing to `/admin/pair/init`, and to list / revoke
   * pairings over a programmatic path.
   */
  readonly pairingService: PairingService | null;
  /**
   * Primitive catalogs resolved at boot from
   * `ggui.json#primitives.{packages,local}`. Empty array when the
   * operator passed nothing (programmatic hosts) or when the
   * declaration resolved to an empty set. Read-only; callers that
   * need to mutate the catalog should rebuild the server.
   *
   * After the CLI `discoverPrimitives()` walk, every declared source
   * surfaces here in boot-time order (packages first, locals after).
   * Generator integration (threading the catalog into
   * `buildSystemPrompt`) consumes this field.
   */
  readonly primitiveCatalogs: readonly DiscoveredPrimitiveCatalog[];
  /**
   * Theme resolved at boot from `ggui.json#theme`. Always populated
   * — the server falls back to `@ggui-ai/design`'s shipped
   * `lightTheme` when the caller omits `opts.theme`, so consumers
   * never have to null-check.
   *
   * Carries the parsed DTCG document + a pre-rendered
   * `:root { --ggui-*: value; }` CSS block. The server does not yet
   * inject this CSS into any HTTP response or console bootstrap;
   * downstream consumers read `server.theme.document` or
   * `server.theme.cssVariables` as they layer on.
   */
  readonly theme: LoadedTheme;
  /**
   * Admin bearer that gates the operator-only console routes
   * (`/ggui/console/keys*` + `/ggui/console/admin-login`). Either the
   * value the caller supplied via {@link CreateGguiServerOptions.console}
   * `.adminToken`, or a freshly minted `ggui_admin_*` token when the
   * caller didn't pass one. `null` when console is disabled (the gate
   * has no consumer).
   *
   * The CLI banner reads this and prints it next to PAIR_CODE so the
   * operator can paste it into the admin-login page on their first
   * visit to `/keys`.
   */
  readonly adminToken: string | null;
  /**
   * The composed generator registry. When the caller passed
   * `opts.generators`, this is that exact registry. Otherwise, when
   * `opts.generation` was supplied, this is an auto-seeded registry
   * containing `generation.uiGenerator` under its declared slug.
   * `null` when neither was supplied (no generators to expose).
   *
   * This field is a seam — consumers read it for blueprint matcher
   * dispatch, `ggui_ops_generate_blueprint`, the LLM-driven variant
   * selector, the console blueprint UI, and the benchmark framework.
   */
  readonly generators: GeneratorRegistry | null;
  /**
   * The composed multi-variant blueprint store. When the caller
   * passed `opts.blueprintStore`, this is that exact instance.
   * Otherwise an auto-seeded {@link InMemoryBlueprintStore}.
   */
  readonly blueprintStore: BlueprintStore;
  /**
   * The composed variant selector. When the caller passed
   * `opts.blueprintSelector`, this is that exact instance. Otherwise
   * {@link createDeterministicBlueprintSelector} — a deterministic
   * fallback ladder. Operators MAY swap in an LLM-driven selector.
   */
  readonly blueprintSelector: BlueprintSelector;
  /**
   * The composed multi-axis blueprint search. When the caller passed
   * `opts.blueprintSearch`, this is that exact instance. Otherwise
   * `createInMemoryBlueprintSearch` against the resolved
   * `blueprintStore`, wiring the optional `embedding` provider if one
   * was supplied.
   *
   * The three-step handshake reads this for its parallel search +
   * validate step. Hosts MAY introspect it for cache-warm runbooks
   * or observability.
   */
  readonly blueprintSearch: BlueprintSearch;
}

/**
 * Build a runnable OSS MCP server. Every option has a sensible default
 * so `createGguiServer()` with no arguments boots a working in-memory
 * server on demand.
 */
export function createGguiServer(opts: CreateGguiServerOptions = {}): GguiServer {
  const info: ServerInfo = { ...DEFAULT_INFO, ...opts.info };
  const logger = opts.logger ?? createConsoleLogger({ server: info.name });
  const bodyLimit = opts.bodyLimit ?? "4mb";

  // Operator mode: gates the `/devtools/*` namespace. Explicit option
  // wins; otherwise read GGUI_MODE env (`'dev'` opts in, anything else
  // including unset is `'prod'`). Surfaced via `/info` so the SPA
  // shows or hides the `/devtools` link without a build-time flag.
  const mode: "dev" | "prod" = opts.mode ?? (process.env.GGUI_MODE === "dev" ? "dev" : "prod");

  // Default adapters wire a fully in-memory OSS server — good for local
  // dev, tests, and zero-config demos. Production deployments swap these.
  const auth = opts.auth ?? new InMemoryAuthAdapter({ devAllowAll: true });
  if (!opts.auth) {
    logger.warn("dev_mode_auth_enabled", {
      hint: 'No auth adapter provided — any non-empty bearer token authenticates as "builder". Pass `auth:` for real deployments.',
    });
  }

  const vectors = opts.vectors ?? new InMemoryVectorStore();
  // Blueprint identity index — sibling of `vectors`. Defaults to
  // in-memory; operators wiring a persistent vector store pass a matching
  // persistent index. Threaded into the generation cache + every
  // `BlueprintRegistryDeps` below so the matcher + registry share one
  // instance.
  const index = opts.index ?? new InMemoryBlueprintIndex();
  const embedding = opts.embedding ?? new MockEmbeddingProvider();

  // Cross-cutting sinks. Telemetry defaults to a
  // silent no-op — lossy delivery is the contract and callers never
  // need to branch on "is a sink bound?". Audit defaults to a no-op
  // PLUS a boot-time warning: privileged actions leaving no record
  // is a compliance breach, and silent default would make that
  // invisible.
  const telemetry = opts.telemetry ?? new NoopTelemetrySink();
  const audit = opts.audit ?? new NoopAuditSink();
  // Admission control. No-op default = unlimited. Operators bind a
  // real limiter (fixed-window, token-bucket, sliding-window) by
  // passing `rateLimiter`. Handlers with a limiter slot always see
  // SOME limiter — never `undefined` — so call sites don't need
  // null-check branches.
  const rateLimiter = opts.rateLimiter ?? new NoopRateLimiter();
  if (!opts.audit) {
    logger.warn("audit_sink_missing", {
      hint: "No audit sink provided — privileged actions (pair / revoke / admin) will not be recorded. Pass `audit:` with a durable implementation for production.",
    });
  }

  // LLM trace sink — captures every Anthropic call the harness makes
  // and exposes it to the console SPA at `/devtools/llm-trace`.
  // Bounded ring buffer (default 200 events) — devtools-only, not for
  // billing or compliance. Module-level registration via
  // setLlmTraceSink because the harness constructs LLM agents per
  // call site and threading a sink through every level for a
  // devtools-only surface isn't worth the churn (see llm-trace-sink.ts).
  // A hosted closed runtime may swap in a durable adapter; OSS gets in-memory.
  const llmTraceSink = new BoundedLlmTraceSink();
  setLlmTraceSink(llmTraceSink);

  // Validator-trace sink — captures every runCheck() invocation the
  // harness performs and exposes it to the console SPA at
  // `/devtools/validator`. Same shape as the LLM trace sink (bounded
  // ring buffer, devtools-only, module-level registration via
  // setValidatorTraceSink). A hosted closed runtime may swap in a
  // durable adapter.
  const validatorTraceSink = new BoundedValidatorTraceSink();
  setValidatorTraceSink(validatorTraceSink);

  // Blueprint-cache trace sink — captures every matchBlueprint
  // decision (hit/miss with reason + top-k candidate scores) and
  // exposes it to the console SPA at `/devtools/cache`. Same shape as
  // the LLM trace sink. Module-level
  // registration so the matcher embedded inside ggui_render and the
  // cache-backed handshake negotiator both fan out to the same buffer
  // without per-handler threading.
  const cacheTraceSink = new BoundedCacheTraceSink();
  setCacheTraceSink(cacheTraceSink);

  // Payload trace sink — captures every `ggui_render` / `ggui_update`
  // payload that lands on the handlers and exposes it to the console
  // SPA at `/devtools/payloads`. Bounded ring buffer (default 100
  // events; tighter than llm-trace because each `ggui_render` may carry
  // full componentCode + base64 blobs). Module-level registration via
  // setPayloadTraceSink because the render + update factories are
  // constructed once per server boot and threading a sink for a
  // devtools-only surface isn't worth the churn (see payload-trace-
  // sink.ts). A hosted closed runtime may swap in a durable adapter;
  // OSS gets in-memory.
  const payloadTraceSink = new BoundedPayloadTraceSink();
  setPayloadTraceSink(payloadTraceSink);

  // MCP Apps outbound wiring gate.
  //
  // When enabled, the server advertises the `io.modelcontextprotocol/ui`
  // capability, serves the `ui://ggui/render` resource, and registers
  // `ggui_render` in the default handler set with declaration-level
  // `_meta.ui.*`. Requires `renderChannel` so the iframe has a
  // live-channel endpoint to connect to; without it the path is pointless.
  const mcpAppsEnabled = opts.mcpApps !== undefined && opts.mcpApps !== false;
  if (mcpAppsEnabled && !opts.renderChannel) {
    throw new Error(
      "createGguiServer: `mcpApps` requires `renderChannel: true`. The MCP Apps iframe has nowhere to connect to without a live-channel endpoint."
    );
  }
  const mcpAppsConfig =
    typeof opts.mcpApps === "object" && opts.mcpApps !== null ? opts.mcpApps : {};
  const wsUrl = mcpAppsConfig.wsUrl ?? "ws://localhost/ws";

  // Iframe-runtime bundle mount resolution (C8 — plan §C8).
  //
  //   runtimeEnabled: should we serve `/_ggui/iframe-runtime.js` ourselves?
  //   runtimeConfig:  narrowed object form or `{}`.
  //   runtimePath:    HTTP route under which the bundle is mounted.
  //   runtimeBootstrapUrl: the URL that lands on the
  //                   `ai.ggui/render.runtimeUrl` slice field. Usually
  //                   equal to `runtimePath`; overridden when a
  //                   CDN fronts the bundle.
  //
  // Default posture when `mcpApps` is on: runtime mount ON,
  // same-origin path `/_ggui/iframe-runtime.js`. Operators opt out by
  // passing `runtime: false` + a custom `runtimeBootstrapUrl`
  // (via `runtime.url`) — typical for production deployments
  // where the bundle rides a CDN.
  const runtimeConfig =
    typeof opts.runtime === "object" && opts.runtime !== null ? opts.runtime : {};
  const runtimeEnabled = mcpAppsEnabled && opts.runtime !== false;
  const runtimePath = runtimeConfig.path ?? RUNTIME_BUNDLE_URL_PATH;
  const runtimeBundleFile =
    runtimeConfig.distDir !== undefined
      ? path.join(runtimeConfig.distDir, "iframe-runtime.js")
      : RUNTIME_BUNDLE_FILE;
  const runtimeBootstrapUrl = runtimeConfig.url ?? runtimePath;

  // Lazy resolver: each render/update handler invocation looks up the
  // request-context-derived absolute base inside the request scope
  // (via AsyncLocalStorage). Static `publicBaseUrl` wins when set;
  // otherwise the tunnel/proxy's X-Forwarded-Host is honored only
  // when the TCP peer is loopback — see request-context.ts for the
  // trust rationale. Outside any request (background callers), the
  // resolver returns the raw runtimeBootstrapUrl unchanged.
  const resolveRuntimeUrlForResultMeta = (): string =>
    resolveRuntimeUrl({
      configuredPublicBaseUrl: opts.publicBaseUrl,
      runtimeUrl: runtimeBootstrapUrl,
    }) ?? runtimeBootstrapUrl;

  // GguiSession store is resolved here (not lazy-inside-renderChannel)
  // when mcpApps is on, because the render-commit handler needs it at
  // handler-factory time, BEFORE the render-channel factory runs.
  const renderStore: GguiSessionStore | undefined =
    opts.renderStore ??
    (mcpAppsEnabled || opts.renderChannel ? new InMemoryGguiSessionStore() : undefined);

  // Outbound stream replay buffer is hoisted here so the
  // `/ggui/console/timeline/*` mount can read its cursor alongside
  // GguiSessionStore events. Only constructed when the channel is
  // enabled; otherwise there's nothing to buffer and the timeline
  // routes report `streamSeq: 0` honestly.
  const streamBuffer: GguiSessionStreamBuffer | undefined = opts.renderChannel
    ? (opts.streamBuffer ?? new InMemoryGguiSessionStreamBuffer())
    : undefined;

  // Bootstrap-credential plumbing. Secret is process-local unless the
  // operator passes one — fine for single-process dev; production
  // operators pass a deterministic secret so multi-host mints verify
  // across instances. Replay cache is single-process; multi-host
  // deployments swap for a shared store later.
  // Live-mode minted credentials. wsUrl/token/expiresAt are optional
  // on the protocol's McpAppAiGguiMeta (they only apply to live
  // mode, not static-component / system-card modes), but THIS minter
  // always sets all three on a successful mint. Promote them
  // back to required at the return-type level so route consumers
  // (which always call this on the live-mode path) get clean strings
  // without per-callsite narrowing.
  let mintBootstrap:
    | ((sessionId: string, appId: string) => { wsUrl: string; token: string; expiresAt: string })
    | undefined;
  let channelBootstrap: import("./ggui-session-channel.js").GguiSessionChannelBootstrap | undefined;
  // Shared HMAC secret for server-minted creds (bootstrap tokens,
  // session tokens, console cookies). Distinct `kind` claims
  // prevent cross-kind confusion; sharing the secret keeps the
  // config surface small and means operators rotate ONE value.
  // Resolved here so both the MCP Apps block and the console
  // block below can reference the same string.
  let sharedTokenSecret: string | undefined = opts.wsTokenSecret;
  if (mcpAppsEnabled) {
    if (sharedTokenSecret === undefined) {
      sharedTokenSecret = randomBytes(32).toString("hex");
      logger.warn("bootstrap_secret_ephemeral", {
        hint: "No `wsTokenSecret` provided — minted a process-local random secret. Multi-host deployments MUST pass a deterministic value (env / secrets manager).",
      });
    }
    const secret = sharedTokenSecret;
    // G14 (2026-05-23): the `WsTokenReplayCache` is no longer
    // wired into the default verify path — bootstrap envelopes are
    // multi-use within their TTL so transient WS drops reconnect
    // without a fresh handshake. The replay cache class stays exported
    // from `@ggui-ai/mcp-server-core` for callers that need explicit
    // single-use semantics (one-time-link share, etc.).
    const syncMinter = (sessionId: string, appId: string) => {
      const { token, claims } = mintWsToken({ sessionId, appId }, secret);
      return {
        wsUrl,
        token,
        expiresAt: new Date(claims.exp * 1000).toISOString(),
      };
    };
    mintBootstrap = syncMinter;
    channelBootstrap = {
      verify: (token) => {
        const result = verifyToken(token, secret, "ws");
        if (result.ok) {
          return {
            ok: true,
            sessionId: result.claims.sessionId,
            appId: result.claims.appId,
          };
        }
        // Surface `expired` separately so the channel server can emit
        // `BOOTSTRAP_EXPIRED` instead of `BOOTSTRAP_INVALID` — drives
        // the iframe's refresh-vs-rehandshake branch.
        if (result.reason === "expired") {
          return { ok: false, reason: "expired" };
        }
        return { ok: false, reason: "invalid" };
      },
      issueSessionToken: (sessionId, appId) => {
        const { token } = mintSessionToken({ sessionId, appId }, secret);
        return token;
      },
      refresh: (token) => {
        const result = refreshWsToken(token, secret);
        if (result.ok) {
          return {
            ok: true,
            token: result.token,
            expiresAt: new Date(result.claims.exp * 1000).toISOString(),
          };
        }
        if (result.reason === "refresh_window_closed") {
          return { ok: false, reason: "window_closed" };
        }
        // Tamper / format / kind / shape failures collapse into a
        // single `invalid` — the iframe MUST re-handshake; the exact
        // breakage type is logged server-side, not surfaced on the
        // wire (would be useful only to attackers probing the surface).
        return { ok: false, reason: "invalid" };
      },
    };
  }

  // Live-channel render endpoint reference. Declared here (not at the
  // Express `app` block below) so the provisional-preview
  // `sendEnvelope` closure can late-bind to it. Assignment happens
  // during the render-channel factory run further down. Safe because
  // `ggui_render` can only fire after `listen()` binds HTTP, which is
  // strictly after that factory runs.
  let channelForHealth: GguiSessionChannelServer | null = null;

  // Provisional preview wiring. Must precede the default-handlers
  // construction so `render.provisionalPreview` is threaded through at
  // that point.
  //
  // Preconditions:
  //   - flag `enabled: true` requires `mcpApps` (ggui_render attached)
  //     + `renderChannel` (envelope transport). We already threw on
  //     `mcpApps` without `renderChannel` above, so this check only
  //     needs to guard the mcpApps side.
  //   - flag `enabled: false` / absent: no deps constructed.
  // Generation wiring precondition. Same rule as provisional preview
  // — the generator only matters for `ggui_render`, which is only
  // registered when MCP Apps is enabled. Silent drop would hide the
  // misconfiguration; throw so the operator sees it at composition
  // time rather than chasing a "why doesn't my BYOK fire?" ghost.
  if (opts.generation && !mcpAppsEnabled) {
    throw new Error(
      "createGguiServer: `generation` requires `mcpApps` (ggui_render must be registered for the generator to attach). Enable MCP Apps or leave generation unset."
    );
  }
  // Auto-wire the generation cache from the server's already-composed
  // `embedding` + `vectors` deps when the caller supplied `generation`
  // without an explicit `cache` bundle. Keeps the common case zero-
  // config while leaving a real opt-out: callers who explicitly set
  // `cache: undefined` on a custom `GenerationDeps` keep that shape —
  // `??` only fires on the `undefined` branch, and the spread below
  // preserves all other fields verbatim. The handler's cache branch
  // then reads this bundle whenever it fires on the story path.
  const generationWithCache = opts.generation
    ? {
        ...opts.generation,
        cache: opts.generation.cache ?? ({ embedding, vectorStore: vectors, index } as const),
        // Thread the shared/seed pools into the generation deps so the
        // render handler's §6 reuse point-read can fall back to them on a
        // per-app miss. Same `opts.seedPools` fed to the negotiator below;
        // without this, the handshake PROPOSES a seed-pool blueprint
        // (origin:'cache') but render reads only the per-app store, misses,
        // and cold-regenerates — defeating cross-deployment reuse.
        ...(opts.seedPools && opts.seedPools.length > 0 ? { seedPools: opts.seedPools } : {}),
      }
    : undefined;

  // Enforce the shared-instance contract for the
  // `installedBlueprints` bridge. The bridge writes
  // to `provider.deps.vectorStore`; the matcher reads from the
  // server's resolved `vectors`. These MUST be reference-equal or the
  // bridge silently writes to a store the matcher never reads —
  // silent drift, no Tier-1 hit. Same applies to `embedding`.
  //
  // CLI composition wires them correctly (see ggui-cli/mcp-backend.ts);
  // this guard catches programmatic embedders who construct a provider
  // with one vectorStore and pass a different one as `opts.vectors`.
  // Fail-loud at boot rather than fail-silent at first match.
  if (generationWithCache?.installedBlueprints !== undefined) {
    const bridgeDeps = generationWithCache.installedBlueprints.deps;
    if (bridgeDeps.vectorStore !== vectors) {
      throw new Error(
        "createGguiServer: `generation.installedBlueprints` provider was constructed with a different `vectorStore` than the server resolved. The bridge must share the same vectorStore the matcher reads — pass the same instance to both `vectors:` and the provider's `deps.vectorStore`."
      );
    }
    if (bridgeDeps.embedding !== embedding) {
      throw new Error(
        "createGguiServer: `generation.installedBlueprints` provider was constructed with a different `embedding` than the server resolved. The bridge must share the same embedding provider the matcher reads — pass the same instance to both `embedding:` and the provider's `deps.embedding`."
      );
    }
    if (bridgeDeps.index !== index) {
      throw new Error(
        "createGguiServer: `generation.installedBlueprints` provider was constructed with a different `index` than the server resolved. The bridge must share the same blueprint index the matcher reads — pass the same instance to both `index:` and the provider's `deps.index`."
      );
    }
  }

  // Resolve the generator registry. When the caller supplied a
  // registry, use it verbatim — they own composition. Otherwise auto-
  // seed a single-entry registry from `generation.uiGenerator` so
  // consumers (matcher, ops tools, console) observe a non-empty
  // registry by default. When `generation` is also absent, the
  // registry stays empty; consumers that depend on it construct their
  // own ad-hoc.
  const generators: GeneratorRegistry | undefined =
    opts.generators ??
    (opts.generation
      ? createInMemoryGeneratorRegistry({
          default: opts.generation.uiGenerator,
        })
      : undefined);
  // Resolve the multi-variant blueprint store + selector. The store
  // auto-seeds with an in-memory adapter so consumers observe a
  // non-empty seam by default; the selector defaults to the
  // deterministic fallback ladder. Operators MAY swap in their own
  // (DDB-backed store, LLM-driven selector) via opts.
  const blueprintStore: BlueprintStore =
    opts.blueprintStore ??
    new InMemoryBlueprintStore({
      embeddingProvider: opts.embedding,
    });
  const blueprintSelector: BlueprintSelector =
    opts.blueprintSelector ?? createDeterministicBlueprintSelector();
  // Auto-seed the multi-axis search against the resolved store.
  // Type-narrowed at the call site: when the caller passed
  // their own store we can't assume it implements `listAllForApp`,
  // so we only auto-seed when we constructed the InMemoryBlueprintStore
  // ourselves. Callers wiring a cloud `DynamoBlueprintStore` (which
  // exposes `listAllForApp` via the cloud-only adapter) MUST also
  // pass their own `blueprintSearch`.
  const blueprintSearch: BlueprintSearch =
    opts.blueprintSearch ??
    (blueprintStore instanceof InMemoryBlueprintStore
      ? createInMemoryBlueprintSearch({
          blueprintStore,
          embeddingProvider: opts.embedding,
        })
      : // Stub: caller wired their own non-InMemory store but didn't
        // wire their own search. Surface a clear error at call time
        // rather than silently returning empty results.
        {
          search: async () => {
            throw new Error(
              "createGguiServer: blueprintStore was provided but blueprintSearch was not. " +
                "Non-InMemoryBlueprintStore stores must be paired with an explicit blueprintSearch " +
                "implementation that knows how to scan the appId namespace."
            );
          },
        });
  // Handshake preflight wiring. Resolved here so `defaultHandlers`
  // below sees a single concrete shape.
  //   - Explicit `handshake: false` → never register the handshake
  //     handler; ggui_render reverts to the rejection path.
  //   - Explicit `handshake: { ... }` → caller-controlled store +
  //     negotiator. Throws if mcpApps is off (symmetric with
  //     `generation`'s precondition above — silent-drop would hide
  //     the misconfig).
  //   - Omitted → default-on when mcpApps is enabled (matches
  //     renderStore / streamBuffer default behavior).
  const handshakeExplicitlyDisabled = opts.handshake === false;
  const handshakeExplicit =
    typeof opts.handshake === "object" && opts.handshake !== null ? opts.handshake : undefined;
  if (handshakeExplicit && !mcpAppsEnabled) {
    throw new Error(
      "createGguiServer: `handshake` requires `mcpApps` (ggui_render must be registered for the paired consume path to attach). Enable MCP Apps or leave handshake unset."
    );
  }
  const handshakeEnabled = mcpAppsEnabled && !handshakeExplicitlyDisabled;
  const handshakeKvStore: KeyValueStore | undefined = handshakeEnabled
    ? (handshakeExplicit?.kvStore ?? new InMemoryKeyValueStore())
    : undefined;

  // ONE shared tool-identity catalog store wired into BOTH sides of the
  // cross-runtime canonicalization round-trip — the
  // `ggui_runtime_declare_tool_catalog` WRITE handler (registered in
  // `defaultHandlers` below) AND the handshake negotiator's READ-side
  // `toolIdentityCatalog` resolver. Default to a single in-memory store
  // (mirrors the `appMetadataStore` default); hosted deployments inject a
  // multi-tenant adapter via `opts.toolIdentityCatalogStore`.
  const toolIdentityCatalogStore: ToolIdentityCatalogStore =
    opts.toolIdentityCatalogStore ?? new InMemoryToolIdentityCatalogStore();

  // Auto-compose a `HandshakeNegotiator` so `ggui_handshake` returns
  // a real reuse-vs-create decision instead of the honest-but-shallow
  // "no-negotiator-bound" default. Cloud-aligned tier order:
  //
  //   1. Caller-supplied `handshake.negotiator` (explicit override)
  //   2. Cache-backed (when `generation.cache` is wired) — preserves
  //      the deterministic cache-hit lookup path; load-bearing for
  //      operators who already wired the cache and rely on its
  //      reuse-vs-create signal. Decision LLM is NOT invoked on the
  //      handshake — the paired `ggui_render` runs the full LLM-driven
  //      generation when cache misses.
  //   3. LLM-backed (when `generation.resolveLlm` is wired but no
  //      cache) — calls the decision LLM with no RAG candidates;
  //      returns a sensible create/update shape based on render
  //      state + agent prompt. RAG infrastructure (embedding +
  //      vectors) is degraded gracefully.
  //   4. `undefined` — handshake records action:'create' with the
  //      no-negotiator-bound message.
  //
  // Convergence invariant for the cache-backed tier: the negotiator
  // reads the SAME cache the render handler reads/writes — scope +
  // embedding + threshold are all shared. A `reuse` decision at
  // handshake time is the same outcome the paired render's cache
  // lookup would converge on; a `create` decision matches the render
  // missing the cache. No fabricated handshake signal.
  //
  // Operators preserve existing behavior: passing `handshake:
  // {negotiator}` directly keeps the explicit pass-through; passing
  // `handshake: false` disables registration entirely.
  // Negotiator selection cascade — prefer the highest-fidelity tier
  // for which we have deps:
  //   1. Explicit caller-supplied negotiator wins always.
  //   2. Registry-backed — uses contract-keyed Tier 1 +
  //      RAG/LLM Tier 2. Requires both cache deps (embedding +
  //      vectorStore) and resolveLlm. This is the default when
  //   2. LLM-backed — full negotiator pipeline; produces the
  //      `HandshakeSuggestion` shape with `origin: cache | agent | synth`
  //      routing. Used when LLM is available.
  //   3. undefined — handshake stamps an `origin: 'agent'` suggestion
  //      against the agent's draft verbatim (no negotiation).
  //
  // The LLM-backed negotiator is the sole entrypoint in the OSS
  // server.
  const handshakeNegotiator: HandshakeNegotiator | undefined = handshakeEnabled
    ? (handshakeExplicit?.negotiator ??
      (generationWithCache?.resolveLlm
        ? createLlmBackedHandshakeNegotiator({
            resolveLlm: generationWithCache.resolveLlm,
            // Pass through the cache bundle so the negotiator can
            // run matchBlueprint exact-key BEFORE the synth LLM
            // round-trip. Same bundle the paired render handler reads
            // / writes — handshake match decisions converge with
            // what render would do on the same draft. Absent →
            // negotiator falls back to the synth-only path (same
            // posture as deployments without RAG infrastructure).
            ...(generationWithCache.cache ? { cache: generationWithCache.cache } : {}),
            // Marketplace-install bridge. When wired, the
            // handshake's exact-key probe sees
            // installed blueprints too — the provider lazily
            // compiles + caches each installed entry on first
            // ensureCached per scope, so the handshake hits the
            // cache directly without a synth round-trip. Same
            // provider the paired render handler reads, so handshake
            // + render converge on the same blueprint pool.
            ...(generationWithCache.installedBlueprints
              ? { installedBlueprints: generationWithCache.installedBlueprints }
              : {}),
            // Seed pools threaded from the top-level server options.
            // Built by the CLI from `--seed-pool` artifacts; absent ⇒
            // no shared pool fed to the negotiator.
            ...(opts.seedPools && opts.seedPools.length > 0 ? { seedPools: opts.seedPools } : {}),
            // READ side of tool-identity canonicalization — the SAME
            // store the `ggui_runtime_declare_tool_catalog` handler
            // writes. The shared core runs `canonicalizeToolIdentity`
            // against `catalogStore.get(ctx.appId)` before keying.
            catalogStore: toolIdentityCatalogStore,
          })
        : undefined))
    : undefined;

  let provisionalPreviewDeps: ProvisionalPreviewDeps | undefined;
  if (opts.provisionalPreview?.enabled) {
    if (!mcpAppsEnabled) {
      throw new Error(
        "createGguiServer: `provisionalPreview.enabled` requires `mcpApps` (ggui_render must be registered for preview to attach). Enable MCP Apps or leave preview disabled."
      );
    }
    const previewRegistry = createInMemoryProvisionalPreviewRegistry();
    provisionalPreviewDeps = {
      config: {
        enabled: true,
        ...(opts.provisionalPreview.isEnabledFor
          ? { isEnabledFor: opts.provisionalPreview.isEnabledFor }
          : {}),
      },
      emitter: opts.provisionalPreview.emitter,
      // Late-binds to the GguiSessionChannelServer created further down.
      // `ggui_render` can only fire after `listen()` binds the HTTP
      // server, by which point `channelForHealth` is assigned.
      sendEnvelope: async (envelope) => {
        if (!channelForHealth) {
          // Safety net for programmatic hosts that construct +
          // invoke handlers without `listen()` (shouldn't happen,
          // but a silent no-op is strictly safer than a throw).
          return {};
        }
        await channelForHealth.sendToGguiSession({
          sessionId: envelope.sessionId,
          channel: envelope.channel,
          mode: envelope.mode,
          payload: envelope.payload,
          ...(envelope.complete === true ? { complete: true as const } : {}),
        });
        return {};
      },
      registry: previewRegistry,
      ...(opts.provisionalPreview.onOutcome
        ? { onOutcome: opts.provisionalPreview.onOutcome }
        : {}),
      ...(opts.provisionalPreview.now ? { now: opts.provisionalPreview.now } : {}),
    };
  }

  // Shared pending-events pipe — hoisted OUT of `defaultHandlers` so the
  // live channel can dual-write WS `data:submit` actions onto the SAME
  // instance `ggui_consume` drains (see
  // `GguiSessionChannelOptions.pendingEventConsumer`). Passed down via
  // `consume.pendingEventConsumer`, which `defaultHandlers` prefers over
  // its own in-memory fallback; threaded into
  // `createGguiSessionChannelServer` below ONLY when this server
  // composed the default handler set — a caller-supplied `opts.handlers`
  // list drains its own pipe (if any), and bridging the channel onto an
  // instance nobody drains would buffer gestures into the void.
  const pendingEventConsumer: PendingEventConsumer = new InMemoryPendingEventConsumer();
  const usingDefaultHandlers = opts.handlers === undefined;

  // Default handler set. Opts override entirely — we don't merge, so an
  // explicit `handlers: []` means "expose no tools" (a valid state).
  // Callers who want to EXTEND the defaults (not replace) should use
  // the exported `defaultHandlers` helper — see its JSDoc above.
  //
  // mcpMounts, when present, append to whichever base list resolves
  // (default or caller-supplied). Composition throws on tool-name
  // collision — surfacing at construction time rather than as a
  // `tools/call` dispatch surprise. See `./mcp-mounts.ts`.
  const baseHandlers: ReadonlyArray<SharedHandler<ZodRawShape, ZodRawShape>> =
    opts.handlers ??
    defaultHandlers({
      embedding,
      vectors,
      consume: { pendingEventConsumer },
      // WRITE side of tool-identity canonicalization — the SAME store
      // the handshake negotiator's `toolIdentityCatalog` resolver reads.
      // Registers `ggui_runtime_declare_tool_catalog`.
      toolIdentityCatalogStore,
      ...(opts.blueprintProvider ? { blueprints: opts.blueprintProvider } : {}),
      // UI registry for `ggui_render_blueprint`. Absent = render tool
      // is NOT registered on this server (defaultHandlers' own opt-in
      // rule). OSS CLI wires a `LocalUiRegistry` here so manifest
      // blueprints mount through their compiled bundles.
      ...(opts.uiRegistry ? { uiRegistry: opts.uiRegistry } : {}),
      // Register `ggui_handshake` + wire the paired render consume
      // path. Both handlers share the same KV instance so the write
      // + read sit on one source of truth. Negotiator is optional;
      // absent, the handshake stamps honest no-negotiator-bound on
      // the record.
      ...(handshakeKvStore
        ? {
            handshake: {
              kvStore: handshakeKvStore,
              // renderStore validation is OPT-IN at the handshake
              // layer. The OSS default trusts the wire sessionId and
              // surfaces validation downstream — render consumes the
              // record + create-if-missing semantics on
              // `renderStore.create({id})` keep render-per-chat
              // working without a pre-existing render. Operators that
              // want strict pre-handshake validation pass an explicit
              // `handshake.renderStore` on `deps`.
              // Caller-supplied negotiator wins; absent, fall back
              // to the cache-backed default auto-composed from the
              // same `{embedding, vectors}` deps the generation
              // cache uses. Undefined when no generation cache is
              // wired (keeps the pre-binding no-negotiator default
              // behavior visible to the handshake handler).
              ...(handshakeNegotiator ? { negotiator: handshakeNegotiator } : {}),
              // Advertise server-side stream-transport
              // capabilities on every handshake response. Threading
              // a resolver (read each call) rather than a static
              // value lets the same option flow through tests +
              // dev-mode reconfig without restarts. Returns the
              // shape iff:
              //   - renderChannel is enabled (something to subscribe
              //     against in the first place), AND
              //   - mcpApps was configured (so `wsUrl` resolves), AND
              //   - operator supplied `streamWebSocketLocalTools`
              //     (the allowlist is the load-bearing capability;
              //     without it, all `channel_subscribe` rejects with
              //     CHANNEL_NOT_LOCAL — no point in advertising).
              // Otherwise returns undefined ⇒ field omitted ⇒
              // iframe falls back to direct polling via the MCP
              // host proxy.
              serverCapabilities: () => {
                if (!opts.renderChannel) return undefined;
                if (!mcpAppsEnabled) return undefined;
                if (!opts.streamWebSocketLocalTools) return undefined;
                return {
                  streamWebSocket: { url: wsUrl },
                  streamWebSocketLocalTools: [...opts.streamWebSocketLocalTools.allowlist],
                };
              },
            },
          }
        : {}),
      ...(mcpAppsEnabled && renderStore
        ? {
            render: {
              renderStore,
              ...(mintBootstrap ? { mintBootstrap } : {}),
              // G14 (2026-05-23) refresh seam. Same `channelBootstrap`
              // the WS upgrade path uses — sharing it means one HMAC
              // secret + one refresh-window policy across the verify
              // path and the `ggui_runtime_refresh_ws_token` tool.
              // Absent when MCP Apps isn't enabled or no bootstrap
              // secret is wired; the tool isn't registered in that case.
              ...(channelBootstrap
                ? { bootstrapRefresh: { refresh: channelBootstrap.refresh } }
                : {}),
              // Iframe-runtime bundle URL — padded onto the
              // `ai.ggui/render.runtimeUrl` slice field by the render
              // handler's resultMeta. C8 made this required on
              // McpAppAiGguiRenderMeta; we always pass it so handlers
              // don't fall back to their hardcoded default.
              // Function form: resolves per-request so a tunnel/proxy
              // operator (X-Forwarded-Host from a loopback peer) gets
              // an absolute URL instead of the relative default that
              // breaks under srcdoc iframes (claude.ai).
              runtimeUrl: resolveRuntimeUrlForResultMeta,
              // Forward operator-picked theme onto every
              // `ai.ggui/render.themeId` slice field so MCP Apps hosts
              // (claude.ai, Claude Desktop) that mount via the
              // postMessage tool-result path propagate the theme into
              // the iframe. Same resolution as the `/r/...` route.
              ...(opts.theme !== undefined && opts.theme.source === "preset"
                ? { themeId: opts.theme.preset }
                : {}),
              ...(opts.theme !== undefined && opts.theme.source !== "default"
                ? { themeMode: opts.theme.mode }
                : {}),
              // Live-theme getter — when present, overrides static
              // `themeId` / `themeMode` per-render. Pair with the
              // mountDevtoolThemeRoutes onConfigChange callback so a
              // console "Save to ggui.json" reaches the next render
              // without restarting the server. CLI owns the shared
              // state cell; this getter just reads it.
              ...(opts.themeProvider !== undefined ? { themeProvider: opts.themeProvider } : {}),
              ...(opts.connectors ? { connectors: opts.connectors } : {}),
              // Only thread the limiter through when the operator
              // bound a real one — passing the NoopRateLimiter is a
              // wasted allocation and makes the wire-through noisy
              // for handlers that read deps.rateLimiter as "did the
              // operator opt in?".
              ...(opts.rateLimiter ? { rateLimiter } : {}),
              // Same "opt-in, not default" logic for the shortCode
              // index. Absent = hosted cloud (DDB side-table) / no
              // console consumer.
              ...(opts.shortCodeIndex ? { shortCodeIndex: opts.shortCodeIndex } : {}),
              // Provisional A2UI preview. When `opts.provisionalPreview.enabled`
              // flipped on above, the deps object owns
              // `sendEnvelope` (late-bound to the live channel) +
              // an in-memory registry. Absent = no preview path.
              ...(provisionalPreviewDeps ? { provisionalPreview: provisionalPreviewDeps } : {}),
              // Wire the UI generator into `ggui_render`. When bound,
              // every story-path render awaits
              // `uiGenerator.generate(...)`, commits the generated
              // GguiSession, and returns `codeReady:true`. Absent =
              // placeholder mode (no componentCode produced).
              //
              // `generationWithCache` enriches the caller-supplied
              // deps with `{cache:{embedding, vectorStore}}` composed
              // from the server's own already-resolved `embedding` +
              // `vectors` deps whenever `opts.generation.cache` is
              // undefined. The handler then runs a cache lookup on
              // every story-path render + emits `cache.hit /
              // similarity / cachedBlueprintId / llmCallsAvoided` on
              // structuredContent.
              ...(generationWithCache
                ? {
                    generation: {
                      ...generationWithCache,
                      // Thread an LLMCaller resolver into
                      // render so the registry-based three-tier matcher
                      // can fire its rerank step. Per-call resolution
                      // because BYOK creds depend on ctx.
                      resolveLlmCaller: async (ctx) => {
                        if (!generationWithCache.resolveLlm) return null;
                        const creds = await generationWithCache.resolveLlm(ctx);
                        if (!creds) return null;
                        return buildLlmCaller(creds.selection, creds.providerKey);
                      },
                    },
                  }
                : {}),
              // Live-subscriber notifier. Late-binds to the
              // GguiSessionChannelServer created further down (`channel`
              // / `channelForHealth`) — the channel doesn't exist yet
              // at handler-factory time, so we hand the render handler
              // a thin closure that forwards to whatever channel ends
              // up assigned to `channelForHealth`. Same late-bind
              // pattern as `provisionalPreviewDeps.sendEnvelope`.
              //
              // Absent channel → no-op closure: the notify drops on
              // the floor, which is correct for hosts that didn't
              // enable `renderChannel` (no live subscribers to
              // notify in the first place). The handler's own
              // `safelyNotifyGguiSessionCommit` swallows on absent notifier
              // anyway, but providing the closure unconditionally
              // keeps the typecheck simple — no per-config branching.
              channelNotifier: {
                notifyGguiSessionCommit: (sessionId, render, matchType) => {
                  if (!channelForHealth) return;
                  channelForHealth.notifyGguiSessionCommit(sessionId, render, matchType);
                },
              },
              // F4 schema compat check. Late-binds to the composed
              // `handlers` list + resolved schemaCompatMode — both
              // exist only after defaultHandlers returns, so we hand
              // the render handler a thin closure that captures them
              // by reference. Same late-bind pattern as
              // `channelNotifier` / `provisionalPreviewDeps.sendEnvelope`.
              //
              // Content-addressable code delivery. When the operator
              // wired `opts.codeStore`, forward it to the render
              // handler along with the base
              // URL the code-blob route resolves to. We prefer the
              // explicit `--public-base-url` (so the URL is reachable
              // from claude.ai's iframe sandbox); when absent we fall
              // back to "no codeUrl emission" — the inline-base64
              // path still mounts the iframe successfully via Path B.
              ...(opts.codeStore && opts.publicBaseUrl
                ? {
                    codeStore: opts.codeStore,
                    codeBaseUrl: opts.publicBaseUrl,
                  }
                : {}),
              // Bootstrap-side mirror of the handshake's
              // `serverCapabilities.streamWebSocketLocalTools`. Same
              // gating rules as the handshake resolver (above):
              // renderChannel + mcpApps + allowlist must all be set
              // for the field to surface. Threading a closure (not a
              // static value) so dev-mode reconfig propagates without
              // a restart, symmetric with the handshake side.
              streamWebSocketLocalTools: () => {
                if (!opts.renderChannel) return undefined;
                if (!mcpAppsEnabled) return undefined;
                if (!opts.streamWebSocketLocalTools) return undefined;
                return [...opts.streamWebSocketLocalTools.allowlist];
              },
              checkRenderContracts: (shape) => {
                // Shape carries the optional actionSpec / streamSpec
                // pair from either the authored DataContract (render
                // validation) or a GguiSession (gen / cache-hit backstops).
                // Both fit structurally; the helper handles missing
                // fields as a compatible no-op.
                const report = checkRenderSchemaCompat(
                  shape,
                  handlers,
                  schemaCompatMode,
                  "ggui_render"
                );
                // `warn` mode: helper returned the report without
                // throwing. Surface on the structured logger so the
                // operator has an observable signal of the mismatch —
                // matches the console endpoint's `schema_compat_warn`
                // log event for consistency across call sites.
                // (`reject` already threw; `off` returned a
                // `compatible: true` empty report.)
                if (!report.compatible) {
                  logger.warn("schema_compat_warn", {
                    site: "ggui_render",
                    findingCount: report.findings.length,
                    findings: report.findings.map((f) => ({
                      kind: f.kind,
                      specName: f.specName,
                      toolName: f.toolName,
                      reason: f.reason,
                      violationCount: f.violations.length,
                    })),
                  });
                }
              },
            },
          }
        : {}),
      // `ggui_update` handler. Registered alongside `render` because
      // both want the GguiSessionStore and
      // benefit from live-channel fan-out. Same late-bind pattern as
      // `channelNotifier` / `provisionalPreviewDeps.sendEnvelope`:
      // the handler factory captures a closure, the closure forwards
      // to `channelForHealth.sendPropsUpdate` once the render
      // channel is created further down.
      //
      // Absent channel → no-op closure: the props_update fan-out
      // drops on the floor, which is correct for hosts that didn't
      // enable `renderChannel` (no live subscribers to notify).
      // The handler's own try/catch swallows notifier rejections,
      // but providing the closure unconditionally keeps the
      // typecheck simple — no per-config branching.
      ...(renderStore
        ? {
            update: {
              renderStore,
              propsUpdateNotifier: {
                sendPropsUpdate: async (sessionId, props) => {
                  if (!channelForHealth) return;
                  await channelForHealth.sendPropsUpdate(sessionId, props);
                },
              },
              // Bootstrap-emission deps. Mirror render so MCP Apps hosts
              // that re-post `ui/notifications/tool-result` over postMessage
              // can re-apply patched props on the live mount without a WS
              // round-trip. Composing the same minter / runtimeUrl / theme
              // resolvers keeps the two transports byte-identical at the
              // bootstrap-projection boundary.
              ...(mintBootstrap ? { mintBootstrap } : {}),
              // Function form: matches render so ggui_update emits the
              // same absolute URL when the server sits behind a tunnel
              // / reverse proxy.
              runtimeUrl: resolveRuntimeUrlForResultMeta,
              ...(opts.theme !== undefined && opts.theme.source === "preset"
                ? { themeId: opts.theme.preset }
                : {}),
              ...(opts.theme !== undefined && opts.theme.source !== "default"
                ? { themeMode: opts.theme.mode }
                : {}),
              ...(opts.themeProvider !== undefined ? { themeProvider: opts.themeProvider } : {}),
            },
          }
        : {}),
      // Thread the composed TelemetrySink so emit-bearing handlers
      // (today: ggui_render + ggui_handshake) can record their
      // lifecycle events. Skipping the spread when the
      // operator didn't pass `opts.telemetry` keeps the Noop default
      // out of the handler dep — handlers can branch on `?` absence.
      ...(opts.telemetry ? { telemetry } : {}),
      // Per-app metadata store. Threaded through so the in-process
      // singleton is shared across `ggui_list_gadgets`,
      // `ggui_list_themes`, `ggui_render` (for theme default
      // resolution), and the handshake (for `app.gadgets`
      // lookup). Absent ⇒ `defaultHandlers` falls back to per-handler
      // ephemeral InMemoryAppMetadataStore instances (the pre-Phase-3
      // shape). The CLI seeds this from `ggui.json#theme.preset`.
      ...(opts.appMetadataStore ? { appMetadataStore: opts.appMetadataStore } : {}),
      // Theme catalog resolver. Read per-call so additions to the
      // registry surface without a restart. Wired alongside
      // `appMetadataStore` to register `ggui_list_themes`; absent ⇒
      // tool omitted from `tools/list`.
      ...(opts.themes ? { themes: opts.themes } : {}),
      // Operator-class blueprint tool wiring. Threads the
      // resolved blueprint store + search + generator registry into
      // defaultHandlers; the four `ggui_ops_*` tools land on /ops
      // via their `audience: ['ops']` tag. The `resolveLlm` +
      // `blueprints` deps come from the same source render reads, so
      // generate dispatches through the same credential + catalog
      // path as live agent traffic. listAllForApp wires only when
      // the resolved store is the in-memory adapter (which exposes
      // it); cloud adapters bind their own listAllForApp via the
      // search seam.
      // Wire only when we have a resolved generator
      // registry. Without `generators`, the ops `generate` path has
      // no dispatch target; the list/update/delete trio could
      // technically run without it but the operator UX expects all
      // four together, so we gate the whole block on the registry.
      ...(generators
        ? buildOpsBlueprintDeps({
            registry: generators,
            blueprintStore,
            blueprintSearch,
            ...(generationWithCache?.resolveLlm
              ? { resolveLlm: generationWithCache.resolveLlm }
              : {}),
            ...(generationWithCache?.blueprints
              ? { blueprints: generationWithCache.blueprints }
              : opts.blueprintProvider
                ? { blueprints: opts.blueprintProvider }
                : {}),
            // Mirror operator-authored blueprints into the cache
            // vectorStore so the agent-facing matchBlueprint exact-
            // key probe (handshake + render) finds them. Same bundle
            // the render handler + handshake negotiator already
            // consume.
            ...(generationWithCache?.cache ? { cacheRegistry: generationWithCache.cache } : {}),
          })
        : {}),
      // Forward each operator-class per-domain dep bundle from the
      // caller-supplied options. Domains land
      // independently: callers can wire the apps surface without the
      // orgs surface, and so on.
      ...(opts.opsApps ? { opsApps: opts.opsApps } : {}),
      ...(opts.opsOrgs ? { opsOrgs: opts.opsOrgs } : {}),
      ...(opts.opsConnectorKeys ? { opsConnectorKeys: opts.opsConnectorKeys } : {}),
      ...(opts.opsCoupon ? { opsCoupon: opts.opsCoupon } : {}),
      // ggui_emit resolves the channel via
      // a lazy getter so the handler captures whatever
      // `channelForHealth` ends up pointing at after
      // createGguiSessionChannelServer runs (which is AFTER
      // defaultHandlers). Same late-bind posture as channelNotifier /
      // provisionalPreviewDeps.sendEnvelope.
      stream: {
        channelProvider: () => channelForHealth,
      },
      // Thread the server's structured logger into ggui_consume so
      // its `action_consume_slow` yellow-flag telemetry lands in the
      // same sink as the rest of the server.
      logger,
    });

  const handlers = composeHandlersWithMounts(baseHandlers, opts.mcpMounts);

  // Isolated MCP services — validated at compose time so misconfig
  // (malformed path, reserved-path collision, empty outputSchema,
  // audience-tag-on-service-handler, within-service tool-name
  // collision, cross-service path collision) surfaces at server
  // construction instead of at first `tools/call`. The actual route
  // mounting happens below alongside the audience routes.
  const mcpServices = validateMcpServices(opts.mcpServices);

  // Schema compatibility check mode. Resolved once and
  // threaded into the console blueprint-try endpoint + the render
  // handler's `checkRenderContracts` closure above (which
  // late-binds to this constant via lexical capture).
  // See CreateGguiServerOptions.schemaCompatCheck.
  const schemaCompatMode: SchemaCompatMode = opts.schemaCompatCheck ?? DEFAULT_SCHEMA_COMPAT_MODE;

  const appIdFromIdentity = opts.appIdFromIdentity ?? defaultAppIdFromIdentity;

  const als = new AsyncLocalStorage<HandlerContext>();

  const app = express();
  // Per-request context (ALS-backed) — captures forwarded host/proto
  // when the TCP peer is loopback, so deps that build absolute URLs
  // (render/update resultMeta.runtimeUrl) can adapt to the tunnel host.
  // Trust gate lives inside the middleware — see request-context.ts.
  app.use(buildRequestContextMiddleware());
  app.use(express.json({ limit: bodyLimit }));
  // Form-urlencoded body parser for /oauth/token (RFC 6749 §4.1.3
  // requires application/x-www-form-urlencoded). JSON bodies still
  // work via the JSON parser above — handlers tolerate both.
  app.use(express.urlencoded({ extended: false, limit: "64kb" }));

  // End-user browser-session cookie bridge. When a request
  // arrives with `ggui_user_session` cookie but no `Authorization`
  // header, synthesize the header from the cookie value so every
  // downstream `resolveIdentity(auth, req)` works transparently for
  // browser-paired end-users. When an explicit Authorization header
  // is present (claude.ai's connector path), the cookie is ignored.
  // Mounted BEFORE any auth-checking gate so the synthesized header
  // is observable everywhere downstream. Same-origin only —
  // SameSite=Lax on the cookie blocks cross-site exploitation.
  app.use(cookieAuthMiddleware());

  // Browser-session security middleware. All three
  // mount AFTER cookieAuthMiddleware (so CSRF can read the
  // synthesized cookie bearer) and BEFORE any state-changing
  // route. Order matters:
  //   - Security headers first (cheap; sets X-Frame-Options DENY +
  //     Referrer-Policy + X-Content-Type-Options on every response).
  //   - GET /ggui/csrf-token next — read-only, must precede CSRF
  //     enforcement so SPAs can fetch the initial token.
  //   - CSRF enforcement last — 403s state-changing requests that
  //     don't carry an HMAC-bound X-Ggui-CSRF header. Skips /pair
  //     (pre-auth endpoint — no session bearer to bind a token to
  //     yet) and programmatic Bearer requests with no cookie
  //     (claude.ai's connector path).
  // The CSRF secret is per-process when not configured — fresh
  // server start → fresh token-mint domain. Production deployments
  // pass a stable `csrfSecret` so tokens survive a restart.
  app.use(createSecurityHeadersMiddleware());
  // Resolved once at boot — every per-request `buildMcpServer` call
  // receives the same string, so `tools/list` + `initialize` stay
  // consistent across the lifetime of the process. Operators tune
  // via `mcpInstructions: 'default' | 'aggressive' | 'minimal' | 'off'`
  // or a custom string. See `instructions-presets.ts` for full copy.
  const resolvedInstructions = resolveMcpInstructions(opts.mcpInstructions);
  if (resolvedInstructions) {
    logger.info("mcp_instructions_set", {
      preset:
        typeof opts.mcpInstructions === "string" &&
        (opts.mcpInstructions === "default" ||
          opts.mcpInstructions === "aggressive" ||
          opts.mcpInstructions === "always" ||
          opts.mcpInstructions === "minimal" ||
          opts.mcpInstructions === "off")
          ? opts.mcpInstructions
          : opts.mcpInstructions === undefined
            ? "default (no-preset fallback)"
            : "custom",
      length: resolvedInstructions.length,
    });
  } else {
    logger.info("mcp_instructions_off", {
      reason: opts.mcpInstructions === "off" ? "preset=off" : "empty custom string",
    });
  }
  const csrfSecret =
    opts.csrfSecret && opts.csrfSecret.length >= 32
      ? opts.csrfSecret
      : randomBytes(32).toString("base64url");
  if (!opts.csrfSecret) {
    logger.info("csrf_secret_ephemeral", {
      hint: "No csrfSecret provided — minted a per-process secret. Tokens are invalidated on every server restart. Pass `csrfSecret` ≥32 bytes for production.",
    });
  }
  mountCsrfTokenRoute(app, { secret: csrfSecret });
  app.use(
    createCsrfMiddleware({
      secret: csrfSecret,
      logger: logger.child({ middleware: "csrf" }),
    })
  );

  // OAuth 2.1 + PKCE + DCR (per MCP spec 2025-06-18+). When enabled,
  // mounts discovery + auth + token endpoints, and adds
  // `WWW-Authenticate` to /mcp 401 responses so OAuth-discovery
  // clients (Claude Desktop, claude.ai, Goose, etc.) can negotiate
  // auth. Without OAuth enabled, pure-bearer clients still work but
  // OAuth-discovery clients bail with "couldn't reach". See `./oauth.ts`.
  const oauthEnabled = opts.oauth !== undefined && opts.oauth !== false;
  const baseOauthConfig: OAuthConfig =
    typeof opts.oauth === "object" && opts.oauth !== null ? opts.oauth : {};
  // RFC 8707 resource-indicator validator. Built
  // here from the deployment shape (universalMcpPath + perAppRouting)
  // and threaded onto OAuthConfig so the OAuth handlers stay
  // deployment-agnostic. Operator-supplied validators on
  // `opts.oauth.validateResource` win — overrides cover advanced
  // deployments (e.g. multi-tenant pods that accept resources for
  // sibling pods on the same domain).
  const oauthConfig: OAuthConfig = {
    ...baseOauthConfig,
    validateResource:
      baseOauthConfig.validateResource ??
      buildResourceValidator({
        universalMcpPath: opts.universalMcpPath ?? "/mcp",
        perAppRouting: opts.perAppRouting,
      }),
  };
  const oauthStorage: OAuthStorage = oauthConfig.storage ?? new InMemoryOAuthStorage();
  if (oauthEnabled) {
    // Discovery + auth + token endpoints — see `./oauth-as-routes.ts`.
    // `getPairingService` late-binds: the pairing service is
    // constructed below this mount, and the consent-submit handler
    // only reads it per-request (after `listen()`).
    mountOAuthAuthorizationServerRoutes({
      app,
      oauthConfig,
      oauthStorage,
      universalMcpPath: opts.universalMcpPath ?? "/mcp",
      ...(opts.perAppRouting !== undefined
        ? {
            perAppRouting: {
              paramName: opts.perAppRouting.paramName,
              ...(opts.perAppRouting.pathPrefix !== undefined
                ? { pathPrefix: opts.perAppRouting.pathPrefix }
                : {}),
            },
          }
        : {}),
      auth,
      getPairingService: () => pairingService,
    });
  }

  // Live-channel render endpoint reference is declared earlier (above
  // the provisional-preview wiring) so the preview `sendEnvelope`
  // closure can late-bind to it. /ggui/health reads the same ref to
  // surface live subscriber / render counts.

  // Liveness / readiness / authenticated-probe routes — see
  // `./health-routes.ts` for the probe taxonomy (live vs health vs
  // auth-check) and the K8s wiring guidance.
  mountHealthRoutes({
    app,
    info,
    toolCount: handlers.length,
    readinessChecks: opts.readinessChecks ?? [],
    getChannel: () => channelForHealth,
    ...(opts.threads !== undefined
      ? {
          threads: {
            ...(opts.threads.durability !== undefined
              ? { durability: opts.threads.durability }
              : {}),
          },
        }
      : {}),
    auth,
    oauthEnabled,
    ...(oauthConfig.issuerUrl !== undefined ? { oauthIssuerUrl: oauthConfig.issuerUrl } : {}),
    logger,
  });

  // Per-boot `buildMcpServer` options — every input below is fixed at
  // composition time, so the bundle is assembled once and the MCP
  // endpoint family spreads a fresh copy per request.
  const buildMcpOptions: BuildMcpServerOptions = {
    mcpAppsOutbound: mcpAppsEnabled,
    // Caller-provided `shellHtml` overrides the default;
    // `installMcpAppsOutbound` falls back to its baked
    // `GGUI_RENDER_SHELL_HTML` constant when absent.
    ...(mcpAppsConfig.shellHtml !== undefined ? { shellHtml: mcpAppsConfig.shellHtml } : {}),
    // Forward the operator-supplied public origin so the static
    // `ui://ggui/render` resource declares `_meta.ui.csp` for
    // spec-compliant hosts (Claude Desktop / claude.ai Connector /
    // Claude Code). Without this the host's restrictive default
    // (`connect-src 'none'`) blocks the iframe from fetching the
    // runtime bundle and opening the WebSocket.
    ...(opts.publicBaseUrl !== undefined ? { publicBaseUrl: opts.publicBaseUrl } : {}),
    // Per-render self-contained shell registration. Only wired
    // when MCP Apps is on AND the render store is resolved —
    // both preconditions for `ggui_render.resultMeta` stamping a
    // per-call `ui://ggui/render/<sessionId>` URI a host can
    // resolve here. Absent either, we register only the legacy
    // static `ui://ggui/render` URI (postMessage shell).
    ...(mcpAppsEnabled && renderStore
      ? {
          selfContained: {
            renderStore,
            runtimeUrl: runtimeBootstrapUrl,
            // Forward operator-picked theme into the per-render
            // self-contained shell. Without this, MCP-Apps hosts
            // (claude.ai, Claude Desktop) that fetch the resource
            // via `resources/read` always get the runtime's baked
            // default theme — `ggui.json#theme: 'indigo'` would
            // only take effect on the direct-browser `/r/<shortCode>`
            // path. Same resolution as the `/r/...` route below.
            ...(opts.theme !== undefined && opts.theme.source === "preset"
              ? { themeId: opts.theme.preset }
              : {}),
            ...(opts.theme !== undefined && opts.theme.source !== "default"
              ? { themeMode: opts.theme.mode }
              : {}),
            // Resume contract — registry-only fallback. Wired
            // when the blueprint vector store is available so the
            // resource handler can render a render-evicted
            // rehydrate from the registered blueprint instead of
            // the dead loading shell. `defaultAppIdFallback`
            // bounds the registry lookup to the OSS single-tenant
            // identity; multi-tenant deployments leave this
            // undefined to fail-safe back to the loading shell
            // (no way to derive the right tenant from a missing
            // render).
            ...(vectors
              ? {
                  vectorStore: vectors,
                  // Shared blueprint index — same instance the
                  // matcher reads — so the registry-only rehydrate
                  // fallback resolves the resume URI's default-variant
                  // exact key to the cached row's UUID.
                  index,
                  defaultAppIdFallback: DEFAULT_BUILDER_APP_ID,
                }
              : {}),
            // T3-1 (2026-05-13) — content-addressable code delivery
            // for the MCP-resource shell. Without these the handler
            // emits the loading shell for compiled components; with
            // them, it inlines a `codeUrl` the iframe-runtime fetches.
            ...(opts.codeStore && opts.publicBaseUrl
              ? {
                  codeStore: opts.codeStore,
                  codeBaseUrl: opts.publicBaseUrl,
                }
              : {}),
            // Bind the app-metadata store so the resource
            // handler can resolve App.publicEnv
            // for the bootstrap projection. Symmetric with the
            // `/r/<shortCode>` route's lookup. Defaults to
            // `InMemoryAppMetadataStore` (created above) when
            // opts.appMetadataStore is undefined.
            ...(opts.appMetadataStore ? { appMetadataStore: opts.appMetadataStore } : {}),
            // Stamp `_meta.ui.csp.{connectDomains,resourceDomains}`
            // on every per-call resource response. Symmetric with
            // the declaration on the static `ui://ggui/render`
            // resource. Without it, claude.ai's cross-origin iframe
            // CSP applies the host default (`connect-src 'none'`)
            // and the `<script type="module" src=runtimeUrl>` tag
            // fails with a generic "script error" — the bug
            // diagnosed live on 2026-05-18 against the cloudflared
            // tunnel.
            ...(opts.publicBaseUrl !== undefined ? { publicBaseUrl: opts.publicBaseUrl } : {}),
            // Live-channel wsToken minter — when wired, every
            // per-render resource shell embeds `{wsUrl, wsToken}`
            // so the iframe-runtime opens a WebSocket on mount and
            // receives `props_update` frames for in-place
            // re-renders. Without this the resource path mounts
            // in static-component mode only — `ggui_update` server
            // mutations never visibly reach the live iframe.
            // Mirrors the per-tool `mintBootstrap` plumbed into
            // the handler factory above.
            ...(mintBootstrap ? { mintWsToken: mintBootstrap } : {}),
          },
        }
      : {}),
    ...(opts.allowedKinds !== undefined ? { allowedKinds: opts.allowedKinds } : {}),
    ...(resolvedInstructions !== undefined ? { instructions: resolvedInstructions } : {}),
    ...(opts.extraResources !== undefined ? { extraResources: opts.extraResources } : {}),
  };

  // MCP wire endpoints (universal / per-app / protocol / ops /
  // services) — see `./mcp-endpoint-routes.ts` for the shared request
  // pipeline (auth, per-app authorize, per-request McpServer +
  // transport) and the audience taxonomy.
  const universalMcpPath = opts.universalMcpPath ?? "/mcp";
  mountMcpEndpoints({
    app,
    logger,
    auth,
    info,
    handlers,
    mcpServices,
    als,
    appIdFromIdentity,
    universalMcpPath,
    ...(opts.perAppRouting !== undefined ? { perAppRouting: opts.perAppRouting } : {}),
    oauthEnabled,
    ...(oauthConfig.issuerUrl !== undefined ? { oauthIssuerUrl: oauthConfig.issuerUrl } : {}),
    ...(opts.errorMapper !== undefined ? { errorMapper: opts.errorMapper } : {}),
    buildMcpOptions,
  });

  // Inbound MCP Apps proxy routes — resource fetch + tools/call
  // visibility gate. Mounts only when a ConnectorRegistry is
  // configured; without it, the server has no way to resolve source
  // endpoints.
  if (mcpAppsEnabled && opts.connectors && renderStore) {
    installMcpAppsInbound(app, {
      connectors: opts.connectors,
      renderStore,
      logger: logger.child({ component: "mcp-apps-inbound" }),
    });
  }

  // Iframe-runtime bundle static mount (C8) — see
  // `./runtime-bundle-route.ts` for the route contract (cache, CORS,
  // dotfiles, missing-bundle 503 posture).
  //
  // `runtimeEnabled === false` (operator set `runtime: false` OR
  // `mcpApps` is off): NO mount. Operator is on the hook for serving
  // the bundle from elsewhere (CDN, proxy) + publishing that URL via
  // `runtime.url`. The bootstrap still carries a `runtimeUrl` so
  // the shell knows where to look — just not our HTTP listener.
  if (runtimeEnabled) {
    mountRuntimeBundleRoute({ app, runtimePath, runtimeBundleFile, logger });
  }

  // R6 /state snapshot + R7 /events cursor-replay reads — see
  // `./api-renders-routes.ts` for the wsToken auth posture, tenancy
  // gates, and response taxonomy. Mounted only when MCP Apps is on,
  // a render store is resolved, and a token secret exists (the same
  // preconditions the credential minter needs).
  if (mcpAppsEnabled && renderStore && sharedTokenSecret !== undefined) {
    mountApiRendersRoutes({
      app,
      renderStore,
      secret: sharedTokenSecret,
      ...(opts.appMetadataStore ? { appMetadataStore: opts.appMetadataStore } : {}),
      ...(opts.theme !== undefined && opts.theme.source === "preset"
        ? { themeId: opts.theme.preset }
        : {}),
      ...(opts.theme !== undefined && opts.theme.source !== "default"
        ? { themeMode: opts.theme.mode }
        : {}),
      ...(opts.codeStore ? { codeStore: opts.codeStore } : {}),
      ...(opts.publicBaseUrl !== undefined ? { publicBaseUrl: opts.publicBaseUrl } : {}),
      ...(mintBootstrap ? { mintBootstrap } : {}),
      resolveRuntimeUrl: resolveRuntimeUrlForResultMeta,
      logger,
    });
  }

  // Content-addressable code + contract-validator delivery — see
  // `./code-routes.ts` for the route contract (cache posture, CORS,
  // hash validation).
  if (opts.codeStore) {
    mountCodeRoutes({ app, codeStore: opts.codeStore, logger });
  }

  // Pairing transport + auth bridge. Opt-in via `opts.pairing`. When
  // enabled with defaults, we mint an `InMemoryPairingService` and wire
  // its `onTokenIssued` / `onTokenRevoked` callbacks through the active
  // AuthAdapter so pairing-minted tokens authenticate subsequent `/mcp`
  // and live-channel requests via the normal bearer path — no side-channel
  // auth store. When the caller provides their own `service:`, they
  // also own the bridge via their own service construction; this layer
  // only mounts the HTTP routes.
  const pairingEnabled = opts.pairing !== undefined && opts.pairing !== false;
  const pairingConfig: {
    service?: PairingService;
    serverName?: string;
    persistencePath?: string;
    path?: string;
    adminInitPath?: string | null;
    adminRevokePath?: string | null;
  } = typeof opts.pairing === "object" && opts.pairing !== null ? opts.pairing : {};
  let pairingService: PairingService | null = null;
  if (pairingEnabled) {
    if (pairingConfig.service) {
      // Caller owns the service AND its auth-bridge wiring. We only
      // mount the routes.
      pairingService = pairingConfig.service;
    } else {
      // Default path: mint an InMemoryPairingService and bridge into
      // the active AuthAdapter. Requires the adapter to implement
      // registerToken / unregisterToken — otherwise the tokens mint
      // fine but never authenticate, which is the exact silent bug the
      // bridge exists to prevent. Fail fast at construction instead.
      if (!isTokenRegisteringAuthAdapter(auth)) {
        throw new Error(
          "createGguiServer: `pairing: true` requires an AuthAdapter that implements `registerToken` + `unregisterToken` (e.g. InMemoryAuthAdapter). Pass `pairing: { service: yourPairingService }` to supply a pre-bridged service instead."
        );
      }
      const bridgedAuth = auth;
      pairingService = new InMemoryPairingService({
        serverName: pairingConfig.serverName ?? info.name,
        ...(pairingConfig.persistencePath
          ? { persistencePath: pairingConfig.persistencePath }
          : {}),
        onTokenIssued: (token, pairing) => {
          bridgedAuth.registerToken(token, {
            identity: { kind: "builder" },
            source: "pairing",
            metadata: {
              pairingId: pairing.pairingId,
              deviceName: pairing.deviceName,
            },
          });
          // Audit — durable record of the token-lifecycle event.
          // `pairing.token` itself is secret; NEVER log it. We record
          // pairingId + deviceName, both of which are already user-
          // facing in the pairings list UI.
          void audit
            .record({
              at: Date.now(),
              action: "pairing.token.issued",
              actor: { kind: "builder" },
              resource: { kind: "pairing", id: pairing.pairingId },
              metadata: {
                deviceName: pairing.deviceName,
                createdAt: pairing.createdAt,
              },
            })
            .catch((err: unknown) => {
              logger.error("audit_record_failed", {
                action: "pairing.token.issued",
                pairingId: pairing.pairingId,
                error: String(err),
              });
            });
          telemetry.emit({
            name: "pairing.token.issued",
            at: Date.now(),
          });
        },
        onTokenRevoked: (token) => {
          bridgedAuth.unregisterToken(token);
          // Audit — we don't have the pairingId here (the service
          // drops mapping once the token is gone), so record against
          // the opaque token prefix to keep entries joinable with
          // issued events via out-of-band correlation. Safe because
          // a revoked token is no longer a secret bearer.
          const prefix = token.slice(0, 8);
          void audit
            .record({
              at: Date.now(),
              action: "pairing.token.revoked",
              actor: { kind: "system" },
              resource: { kind: "pairing-token", id: prefix },
            })
            .catch((err: unknown) => {
              logger.error("audit_record_failed", {
                action: "pairing.token.revoked",
                error: String(err),
              });
            });
          telemetry.emit({
            name: "pairing.token.revoked",
            at: Date.now(),
          });
        },
      });
    }
    // Per-IP rate limit on `/pair` (5 attempts / 5 min). Mounted via
    // `app.use(path, ...)` BEFORE the route handlers so `next()`
    // reaches the pairing route only when allowed.
    const authRateLimiter = new FixedWindowRateLimiter({
      store: new InMemoryQuotaStore(),
      limit: 5,
      windowMs: 5 * 60 * 1000,
    });
    app.use(
      pairingConfig.path ?? DEFAULT_PAIRING_PATH,
      createPairLoginRateLimitMiddleware({
        limiter: authRateLimiter,
        logger: logger.child({ middleware: "rate-limit", route: "pair" }),
        quotaKey: "pair",
        ...(opts.trustProxy !== undefined ? { trustProxy: opts.trustProxy } : {}),
      })
    );

    mountPairingTransport(app, {
      pairing: pairingService,
      auth,
      logger: logger.child({ component: "pairing" }),
      path: pairingConfig.path ?? DEFAULT_PAIRING_PATH,
      adminInitPath:
        pairingConfig.adminInitPath === undefined
          ? DEFAULT_PAIRING_ADMIN_INIT_PATH
          : pairingConfig.adminInitPath,
      adminRevokePath:
        pairingConfig.adminRevokePath === undefined
          ? undefined // → pairing-transport default (`/admin/pair/:pairingId/revoke`)
          : pairingConfig.adminRevokePath,
    });
  }

  // OAuth login. Two layers:
  //
  //   - Admin transport at `/ggui/admin/oauth-providers` ALWAYS mounts
  //     when the server is reachable — operator can paste credentials
  //     in advance even before publicBaseUrl is set.
  //   - Login routes at `/ggui/oauth-login/:providerId/{start,callback}`
  //     mount only when `publicBaseUrl` is provided — without it the
  //     redirect_uri can't be composed.
  //
  // The provider list is resolved per request from the store so
  // operator paste-then-click works without a server restart. Provider
  // factories are baked in (Google + GitHub for v1; Anthropic deferred).
  const oauthStore = createOAuthProvidersStore({
    ...(opts.oauthProvidersPath ? { filePath: opts.oauthProvidersPath } : {}),
    logger: logger.child({ component: "oauth-providers-store" }),
  });
  mountAdminOAuthProvidersTransport(app, {
    store: oauthStore,
    auth,
    logger: logger.child({ component: "admin-oauth-providers" }),
    auditSink: audit,
  });
  if (opts.publicBaseUrl) {
    const oauthFactories: Record<
      string,
      (clientId: string, clientSecret: string) => OAuthLoginProvider
    > = {
      google: (clientId, clientSecret) => googleLoginProvider({ clientId, clientSecret }),
      github: (clientId, clientSecret) => githubLoginProvider({ clientId, clientSecret }),
    };
    mountOAuthLoginRoutes(app, {
      providers: async () => {
        const records = await oauthStore.list();
        const out: OAuthLoginProvider[] = [];
        for (const r of records) {
          if (!r.enabled) continue;
          const factory = oauthFactories[r.providerId];
          if (!factory) continue; // unknown providerId — silently skipped
          out.push(factory(r.clientId, r.clientSecret));
        }
        return out;
      },
      auth,
      logger: logger.child({ component: "oauth-login" }),
      stateSecret: csrfSecret,
      publicBaseUrl: opts.publicBaseUrl,
      auditSink: audit,
    });
    logger.info("oauth_login_mounted", { publicBaseUrl: opts.publicBaseUrl });
  } else {
    logger.info("oauth_login_skipped", {
      reason: "publicBaseUrl not set; admin transport still mounted",
    });
  }

  // Email magic-link login. Mounts the three routes when the operator
  // supplies a sender + fromAddress + publicBaseUrl. Without
  // publicBaseUrl the magic link can't resolve so we skip the mount
  // entirely and /login hides the email form (it fetches /config and
  // gets 404, falling through to the "no email" branch).
  if (opts.emailLogin && opts.publicBaseUrl) {
    mountEmailLoginRoutes(app, {
      sender: opts.emailLogin.sender,
      fromAddress: opts.emailLogin.fromAddress,
      auth,
      logger: logger.child({ component: "email-login" }),
      publicBaseUrl: opts.publicBaseUrl,
      ...(opts.emailLogin.store ? { store: opts.emailLogin.store } : {}),
      ...(opts.emailLogin.subject ? { subject: opts.emailLogin.subject } : {}),
      ...(opts.emailLogin.bodyText ? { bodyText: opts.emailLogin.bodyText } : {}),
      ...(opts.emailLogin.bodyHtml ? { bodyHtml: opts.emailLogin.bodyHtml } : {}),
      auditSink: audit,
    });
    logger.info("email_login_mounted", {
      publicBaseUrl: opts.publicBaseUrl,
      fromAddress: opts.emailLogin.fromAddress,
    });
  } else if (opts.emailLogin) {
    logger.warn("email_login_skipped", {
      reason: "publicBaseUrl required for email magic-link routes",
    });
  }

  // Admin-blueprints transport. Mounts `POST /admin/blueprints` so
  // runtime manifest registrations can land into the caller-supplied
  // provider (closes Q6 from the OSS full-generation port plan).
  // Same builder-bearer auth as `/admin/pair/init`; the transport
  // returns 501 Not Implemented per-request if the provider doesn't
  // expose `addManifest` (future external catalogs). Opt-out via
  // `adminBlueprints: false` or `{ path: null }`.
  //
  // Only mounted when the caller explicitly wired a
  // `blueprintProvider` — the default provider built inside
  // `defaultHandlers` is not reachable from this scope, and silently
  // mounting a route that registers onto an invisible provider would
  // be a surprise.
  if (opts.blueprintProvider && opts.adminBlueprints !== false) {
    const cfg =
      typeof opts.adminBlueprints === "object" && opts.adminBlueprints !== null
        ? opts.adminBlueprints
        : {};
    mountAdminBlueprintsTransport(app, {
      provider: opts.blueprintProvider,
      auth,
      logger: logger.child({ component: "admin-blueprints" }),
      path: cfg.path === undefined ? DEFAULT_ADMIN_BLUEPRINTS_PATH : cfg.path,
    });
  }

  // Persistent-chat transport. Mounted only when a ThreadStore is
  // supplied — no zero-config fallback, because threads are durable
  // and silently dropping them into an in-memory default at boot
  // would surprise operators the first time the process restarts.
  if (opts.threads) {
    mountThreadTransport(app, {
      store: opts.threads.store,
      auth,
      logger: logger.child({ component: "threads" }),
      path: opts.threads.path ?? DEFAULT_THREADS_PATH,
      ...(opts.threads.ownerFromIdentity
        ? { ownerFromIdentity: opts.threads.ownerFromIdentity }
        : {}),
    });
  }

  // Embedded-UI landing-page mount. Routes:
  //
  //   - `GET /ggui/console/info` — JSON describing this server
  //     (name + version + pairing block). Stable shape so the SPA
  //     client in `@ggui-ai/console` can fetch once on load.
  //   - `POST /ggui/console/session-cookie` — resolve shortCode
  //     → render and mint the same-origin HTTP-only cookie the
  //     viewer authenticates to the live channel with. Enabled only when
  //     `console.sessionCookie` is on AND `shortCodeIndex` +
  //     `renderChannel` are wired.
  //   - `<path>/*` — express.static over the package's built `dist/`
  //     (landing HTML + JS + CSS). Default `path` is `/`.
  //
  // Endpoints MUST be registered BEFORE the static handler —
  // Express's route table is order-sensitive; a root-mounted
  // express.static would otherwise intercept `/ggui/console/*`
  // paths if we register them reversed. Today the API paths don't
  // overlap (different prefix) but register-order is the robust
  // invariant.
  //
  // When the `distDir` doesn't exist on disk (e.g. operator forgot
  // to run `pnpm --filter @ggui-ai/console build`), the static
  // route is replaced with a 503 that points at the missing build —
  // silent 404 would be mistaken for "console is broken" rather
  // than "console wasn't built yet," which is a real debugging
  // trap for self-hosted operators.
  const consoleEnabled = opts.console !== undefined && opts.console !== false;
  // Cookie-auth binding into the render-channel. Populated inside
  // the console block below when `sessionCookie` is enabled, then
  // threaded into createGguiSessionChannelServer. Declared `let` here so
  // the declaration-order dance stays legible.
  let consoleCookieAuth:
    | import("./ggui-session-channel.js").GguiSessionChannelCookieAuth
    | undefined;
  // Admin token resolution. Surfaced on `GguiServer.adminToken` when
  // console is on; `null` when it's off (no consumer for the gate).
  // Operator-supplied wins; otherwise we mint a fresh
  // `ggui_admin_<base64url(9)>` (matches the `ggui_user_*` shape of
  // pair-minted tokens for visual consistency in CLI banners). The
  // token gates `/ggui/console/keys*` + `/ggui/console/admin-login` —
  // see `MintAdminGate` below.
  let resolvedAdminToken: string | null = null;
  if (consoleEnabled) {
    const consoleConfigForToken =
      typeof opts.console === "object" && opts.console !== null ? opts.console : {};
    resolvedAdminToken =
      consoleConfigForToken.adminToken ?? `ggui_admin_${randomBytes(9).toString("base64url")}`;
  }
  // Shared admin-auth check used by every operator-only console route.
  // Mirrors the Bearer-or-cookie pattern the keys/theme/llm-keys gates
  // use inline; lifting it here lets the read-side endpoints (/info,
  // /renders, /config) gate identically without redefining the logic.
  // Returns `null` when no admin token is configured — caller treats
  // the absence as "no gating needed" (console disabled).
  const requestHasAdminAuthShared: ((req: Request) => boolean) | null =
    resolvedAdminToken !== null
      ? (() => {
          const tok = resolvedAdminToken;
          return (req: Request): boolean => {
            const authHeader = req.headers["authorization"];
            if (typeof authHeader === "string") {
              const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
              if (m && m[1] === tok) return true;
            }
            const cookieHeader = req.headers["cookie"];
            if (typeof cookieHeader === "string") {
              for (const raw of cookieHeader.split(";")) {
                const trimmed = raw.trim();
                const eq = trimmed.indexOf("=");
                if (eq <= 0) continue;
                if (trimmed.slice(0, eq) !== "ggui_console_admin") continue;
                if (decodeURIComponent(trimmed.slice(eq + 1)) === tok) {
                  return true;
                }
              }
            }
            return false;
          };
        })()
      : null;
  if (consoleEnabled) {
    const consoleConfig =
      typeof opts.console === "object" && opts.console !== null ? opts.console : {};
    const consolePath = consoleConfig.path ?? "/";
    const consoleDistDir = consoleConfig.distDir ?? CONSOLE_DIST_DIR;

    // Cookie flow preconditions. Opt-in via explicit `sessionCookie`
    // truthy value — operators enabling only the landing page surface
    // don't need to wire renderChannel + shortCodeIndex. The feature
    // requires `renderChannel: true` (the cookie only authenticates
    // the live channel) and `shortCodeIndex` (the cookie endpoint resolves
    // shortCode → render through it). Fail fast at construction if
    // either is missing when the operator asked for the flow.
    const sessionCookieEnabled =
      consoleConfig.sessionCookie === true ||
      (typeof consoleConfig.sessionCookie === "object" && consoleConfig.sessionCookie !== null);
    if (sessionCookieEnabled) {
      if (!opts.renderChannel) {
        throw new Error(
          "createGguiServer: `console.sessionCookie` requires `renderChannel: true`. The cookie authenticates the live-channel WebSocket upgrade; without a channel it has no consumer."
        );
      }
      if (!opts.shortCodeIndex) {
        throw new Error(
          "createGguiServer: `console.sessionCookie` requires `shortCodeIndex`. The cookie endpoint resolves POSTed shortCodes through this index."
        );
      }
    }
    const sessionCookieConfig =
      typeof consoleConfig.sessionCookie === "object" && consoleConfig.sessionCookie !== null
        ? consoleConfig.sessionCookie
        : {};
    // The cookie reuses the shared HMAC secret — see
    // `console-auth.ts` isolation comment for why shared secrets
    // are safe (distinct `kind` claim prevents cross-kind verify).
    // When no secret has been resolved yet (neither operator-supplied
    // nor minted by the MCP Apps block), mint one here. Warn on
    // ephemeral secrets so multi-host deployments flip to an
    // explicit value.
    if (sessionCookieEnabled && sharedTokenSecret === undefined) {
      sharedTokenSecret = randomBytes(32).toString("hex");
      logger.warn("console_cookie_secret_ephemeral", {
        hint: "No `wsTokenSecret` provided — minted a process-local random secret for console cookies. Multi-host deployments MUST pass a deterministic value (env / secrets manager).",
      });
    }

    // Blueprint resolve + try-live routes — see
    // `./console-blueprint-routes.ts` for the gate taxonomy (registry
    // required; render store + shortCode index unlock try-live) and
    // the schema-compat posture.
    if (opts.uiRegistry) {
      mountConsoleBlueprintRoutes({
        app,
        uiRegistry: opts.uiRegistry,
        ...(renderStore ? { renderStore } : {}),
        ...(opts.shortCodeIndex ? { shortCodeIndex: opts.shortCodeIndex } : {}),
        handlers,
        schemaCompatMode,
        logger,
      });
    }

    // Catalog + cache + runtime-registry read/maintenance routes —
    // see `./console-registry-routes.ts` for the three-surface split
    // (/registry vs /blueprints/cached vs /blueprints/registry) and
    // the enumeration gate.
    mountConsoleRegistryRoutes({
      app,
      ...(opts.uiRegistry ? { uiRegistry: opts.uiRegistry } : {}),
      ...(opts.primitiveCatalogs ? { primitiveCatalogs: opts.primitiveCatalogs } : {}),
      vectors,
      logger,
    });

    // ──────────────────────────────────────────────────────────────────
    // Admin gate for the operator-info read endpoints (`/info`,
    // `/renders`, `/config`). These surfaces sit under `/admin/*`
    // in the SPA. Same Bearer-or-cookie shape as `/keys`, `/theme`,
    // `/llm-keys`.
    //
    // Threat model: `ggui serve` is routinely tunneled (e.g. via
    // Cloudflare) for claude.ai connector use. Without this gate
    // anyone with the tunnel URL can read live render shortCodes
    // (then walk `/s/<code>` to spy on rendered UIs), the active
    // pair-code window from `/info`, or the full `ggui.json` (which
    // can carry env-var-derived secrets in `mcpMounts`). Localhost-
    // only deployments lose nothing — admin token is auto-minted on
    // boot, so the cookie roundtrip costs the operator one paste.
    //
    // No-op when `resolvedAdminToken` is null (console disabled or
    // explicitly unset by an embedder); routes are simply unmounted
    // in that case so the gate has no consumers.
    if (requestHasAdminAuthShared) {
      const adminGuardForReadEndpoints = requestHasAdminAuthShared;
      for (const path of [
        "/ggui/console/info",
        "/ggui/console/sessions",
        "/ggui/console/config",
        "/ggui/console/llm-trace",
        "/ggui/console/validator",
        "/ggui/console/cache",
        "/ggui/console/payloads",
        "/ggui/console/timeline",
      ]) {
        app.use(path, (req, res, next) => {
          // The per-render meta route (`/ggui/console/sessions/:id/meta`)
          // gates on the same-origin console cookie, NOT the admin token —
          // its caller is a same-origin iframe that already proved cookie
          // possession. Exempt it from this admin-token middleware so
          // both gates compose cleanly (admin token for `/renders` list,
          // cookie for per-render meta).
          if (path === "/ggui/console/sessions" && /^\/[^/]+\/meta\/?$/.test(req.path)) {
            return next();
          }
          if (adminGuardForReadEndpoints(req)) return next();
          applyDevtoolSecurityHeaders(res);
          res.status(401).json({ error: "admin_auth_required" });
        });
      }
    }

    // LLM trace surfaces — `/devtools/llm-trace` reads recent events
    // on mount and subscribes to live events via SSE. Both routes
    // admin-gated by the loop above; this mount only installs the
    // handlers.
    mountConsoleLlmTraceRoutes(app, llmTraceSink);

    // Validator-tier trace surfaces — `/devtools/validator` reads
    // recent events on mount and subscribes via SSE. Same gate shape
    // as the LLM trace; the loop above adds
    // `/ggui/console/validator` to the admin path list.
    mountConsoleValidatorRoutes(app, validatorTraceSink);

    // Blueprint-cache trace surfaces — `/devtools/cache` mirrors the
    // llm-trace pattern: REST recent + SSE live, both admin-gated by
    // the same loop above.
    mountConsoleCacheRoutes(app, cacheTraceSink);

    // Payload trace surfaces — `/devtools/payloads` reads recent
    // `ggui_render` / `ggui_update` payloads on mount and subscribes
    // to live events via SSE. Both routes admin-gated by the loop
    // above; this mount only installs the handlers.
    mountConsolePayloadsRoutes(app, payloadTraceSink);

    // Timeline surfaces — `/devtools/timeline` reads the render
    // list and per-render GguiSessionStore.observe replay. REST
    // only — replay is a snapshot, not a live stream. Admin-gated by
    // the loop above. The hoisted `renderStore` + `streamBuffer` may
    // be undefined when neither `mcpApps` nor `renderChannel` is on;
    // the route handlers tolerate that and return empty bodies.
    mountConsoleTimelineRoutes(app, renderStore, streamBuffer);

    // Active-render list — see `./console-sessions-routes.ts` for the
    // active-only scope rationale + zero-config empty shape.
    mountConsoleSessionsRoutes({
      app,
      ...(renderStore ? { renderStore } : {}),
      ...(opts.shortCodeIndex ? { shortCodeIndex: opts.shortCodeIndex } : {}),
      logger,
    });

    // MCP-tool inventory — see `./console-mcp-tools-routes.ts` for
    // the projection shape + schema-conversion degradation rule.
    mountConsoleMcpToolsRoutes({ app, handlers, logger });

    // Manifest read surface — see `./console-config-routes.ts` for
    // the three-state source-resolution contract.
    mountConsoleConfigRoutes({ app, logger });

    // Server-info surface — see `./console-info-routes.ts` for the
    // pairing / capabilities / storage block contracts.
    mountConsoleInfoRoutes({
      app,
      info,
      mode,
      pairingEnabled,
      pairingService,
      toolCount: handlers.length,
      ...(opts.uiRegistry ? { uiRegistry: opts.uiRegistry } : {}),
      ...(opts.primitiveCatalogs ? { primitiveCatalogs: opts.primitiveCatalogs } : {}),
      mcpAppsEnabled,
      ...(opts.generation ? { generation: opts.generation } : {}),
      storage: {
        renderStore: opts.renderStore ? "custom" : "memory",
        vectorStore: opts.vectors ? "custom" : "memory",
      },
      logger,
    });

    // Dev-chat round-trip — see `./console-chat-routes.ts` for the
    // render-turn shape + honest text-only fallbacks. Handler lookup
    // is gated on `generationWithCache`: without a generator wired, a
    // render call would allocate a render + shortCode with empty
    // componentCode per turn without any visible UI.
    const renderHandlerForChat =
      generationWithCache !== undefined
        ? handlers.find((h) => h.name === "ggui_render")
        : undefined;
    const handshakeHandlerForChat =
      renderHandlerForChat !== undefined
        ? handlers.find((h) => h.name === "ggui_handshake")
        : undefined;
    mountConsoleChatRoutes({
      app,
      ...(renderHandlerForChat ? { renderHandler: renderHandlerForChat } : {}),
      ...(handshakeHandlerForChat ? { handshakeHandler: handshakeHandlerForChat } : {}),
      ...(sessionCookieEnabled && sharedTokenSecret !== undefined
        ? {
            sessionCookie: {
              secret: sharedTokenSecret,
              ...(sessionCookieConfig.ttlSec !== undefined
                ? { ttlSec: sessionCookieConfig.ttlSec }
                : {}),
              secure: sessionCookieConfig.secure === true,
            },
          }
        : {}),
      logger,
    });

    // Cookie-mint + render-viewer session routes — see
    // `./console-session-routes.ts` for the named parties + auth/scope
    // gates. Enabled only when `sessionCookie` is on (default when
    // `console` is otherwise enabled). The preconditions checked
    // earlier guarantee shortCodeIndex + renderChannel are present
    // and that the shared token secret was minted.
    if (sessionCookieEnabled && sharedTokenSecret !== undefined && opts.shortCodeIndex) {
      consoleCookieAuth = mountConsoleSessionRoutes({
        app,
        secret: sharedTokenSecret,
        shortCodeIndex: opts.shortCodeIndex,
        ...(sessionCookieConfig.ttlSec !== undefined
          ? { cookieTtlSec: sessionCookieConfig.ttlSec }
          : {}),
        cookieSecure: sessionCookieConfig.secure === true,
        ...(renderStore ? { renderStore } : {}),
        ...(mintBootstrap ? { mintBootstrap } : {}),
        runtimeBootstrapUrl,
        ...(opts.codeStore ? { codeStore: opts.codeStore } : {}),
        ...(opts.publicBaseUrl !== undefined ? { publicBaseUrl: opts.publicBaseUrl } : {}),
        logger,
      });
    }

    // Connected-Apps management surface — see
    // `./oauth-clients-routes.ts` for the list/revoke contract.
    if (oauthEnabled) {
      mountOAuthClientsRoutes({ app, oauthStorage, logger });
    }

    // Admin-gated keys plane — see `./console-keys-routes.ts` for the
    // threat model + gate scope discipline.
    if (resolvedAdminToken !== null && pairingService) {
      mountConsoleKeysRoutes({
        app,
        adminToken: resolvedAdminToken,
        pairing: pairingService,
        logger,
      });
    }

    // ──────────────────────────────────────────────────────────────────
    // Theme picker plane — gated /ggui/console/theme.
    //
    // Reads + (when a writer is supplied) persists the project-level
    // theme selection in ggui.json. Admin-only — same gate as LLM
    // keys; the value persists to the manifest, which is trusted
    // operator input.
    //
    // The current resolved selection is a tagged union:
    //   - undefined   → caller used createGguiServer without a CLI;
    //                   the picker shows "default theme" and allows
    //                   first-time selection
    //   - ThemeConfig → ggui.json#theme as parsed
    //
    // Reverse-engineered from `loadedTheme` for the initial value:
    // a `source: 'preset'` with overrides → a `{ preset, mode,
    // overrides }` config; a `source: 'file'` → a `{ file, mode }`
    // config; `source: 'default'` → null.
    {
      const resolvedAdminTokenForTheme = resolvedAdminToken;
      const requestHasAdminAuthForTheme = (req: Request): boolean => {
        if (resolvedAdminTokenForTheme === null) return false;
        const authHeader = req.headers["authorization"];
        if (typeof authHeader === "string") {
          const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
          if (m && m[1] === resolvedAdminTokenForTheme) return true;
        }
        const cookieHeader = req.headers["cookie"];
        if (typeof cookieHeader === "string") {
          for (const raw of cookieHeader.split(";")) {
            const trimmed = raw.trim();
            const eq = trimmed.indexOf("=");
            if (eq <= 0) continue;
            const name = trimmed.slice(0, eq);
            if (name !== "ggui_console_admin") continue;
            const value = decodeURIComponent(trimmed.slice(eq + 1));
            if (value === resolvedAdminTokenForTheme) return true;
          }
        }
        return false;
      };

      const initialThemeConfig: ThemeConfig | null =
        opts.theme === undefined || opts.theme.source === "default"
          ? null
          : opts.theme.source === "file"
            ? { file: opts.theme.path, mode: opts.theme.mode }
            : {
                preset: opts.theme.preset,
                mode: opts.theme.mode,
                ...(opts.theme.overrides ? { overrides: opts.theme.overrides } : {}),
              };

      mountDevtoolThemeRoutes({
        app,
        initialConfig: initialThemeConfig,
        ...(opts.themeWriter ? { themeWriter: opts.themeWriter } : {}),
        ...(opts.themeFileUploader ? { themeFileUploader: opts.themeFileUploader } : {}),
        ...(opts.onThemeConfigChange ? { onConfigChange: opts.onThemeConfigChange } : {}),
        requestHasAdminAuth: requestHasAdminAuthForTheme,
      });
    }

    // BYOK LLM-keys plane — see `./console-llm-keys-routes.ts` for the
    // two gate postures (admin-token vs auth-adapter) + the wire shape.
    const providerKeysGateMode: "admin-token" | "auth-adapter" =
      opts.providerKeysGate ?? "admin-token";
    const mountLlmKeysRoute =
      opts.providerKeys !== undefined &&
      (providerKeysGateMode === "auth-adapter" || resolvedAdminToken !== null);
    if (mountLlmKeysRoute && opts.providerKeys) {
      mountConsoleLlmKeysRoutes({
        app,
        providerKeys: opts.providerKeys,
        gateMode: providerKeysGateMode,
        adminToken: resolvedAdminToken,
        auth,
        ...(opts.providerKeyScope ? { scopeFromRequest: opts.providerKeyScope } : {}),
        logger,
      });
    }

    // Static bundle + SPA serving — see `./console-static-routes.ts`
    // for the mode-meta injection, welcome page, admin-HTML gate, and
    // SPA-fallback contracts.
    mountConsoleStaticRoutes({
      app,
      consolePath,
      consoleDistDir,
      mode,
      serverName: info.name,
      ...(opts.welcomePage !== undefined ? { welcomePage: opts.welcomePage } : {}),
      ...(consoleConfig.landingRedirect !== undefined
        ? { landingRedirect: consoleConfig.landingRedirect }
        : {}),
      requestHasAdminAuth: requestHasAdminAuthShared,
      logger,
    });
  }

  // Live-channel render endpoint. Defaults to disabled so consumers who
  // only want the tool plane get the smallest surface; CLIs (`ggui serve`,
  // hosted) enable it explicitly.
  //
  // Reserved-channel payload validators (Item 4 injection pattern): by
  // default the server binds the A2UI adapter for `_ggui:preview` so
  // malformed preview frames reject at the fan-out boundary instead of
  // landing in subscribers. `_ggui:lifecycle` is validated via
  // `@ggui-ai/protocol`'s built-in regardless of this composition.
  // Operators passing `extraReservedValidators` override the default A2UI
  // entry on key conflict — otherwise the two maps merge layer-wise.
  const composedReservedValidators = mergeReservedValidators(
    composePreviewReservedValidator(),
    opts.extraReservedValidators
  );
  const channel: GguiSessionChannelServer | null = opts.renderChannel
    ? createGguiSessionChannelServer({
        renderStore: renderStore ?? new InMemoryGguiSessionStore(),
        // WS action → consume bridge. Only when this server composed the
        // default handler set — that's when `ggui_consume` demonstrably
        // drains THIS pipe instance (see the hoist comment above
        // `baseHandlers`).
        ...(usingDefaultHandlers ? { pendingEventConsumer } : {}),
        auth,
        // Same identity → appId mapping the `/mcp` endpoint resolved
        // above — subscribes that omit `payload.appId` resolve their
        // identity-default through the identical rule (SPEC §12.2).
        appIdFromIdentity,
        logger: logger.child({ component: "render-channel" }),
        path: typeof opts.renderChannel === "object" ? opts.renderChannel.path : undefined,
        streamBuffer:
          streamBuffer ??
          new InMemoryGguiSessionStreamBuffer() /* hoist guarantees non-null when opts.renderChannel truthy; fallback only for TS narrowing */,
        ...(channelBootstrap ? { bootstrap: channelBootstrap } : {}),
        ...(consoleCookieAuth ? { cookieAuth: consoleCookieAuth } : {}),
        // Opt-in channel_subscribe polling. Same options
        // object is also surfaced on every handshake response's
        // `serverCapabilities.streamWebSocketLocalTools` (via the
        // resolver wired into `createGguiHandshakeHandler` below) so
        // the iframe + server agree on the WS-fan-out vs.
        // iframe-poll-direct split per channel.
        ...(opts.streamWebSocketLocalTools
          ? { streamWebSocketLocalTools: opts.streamWebSocketLocalTools }
          : {}),
        ...(composedReservedValidators
          ? { extraReservedValidators: composedReservedValidators }
          : {}),
        ...(opts.versionPolicy !== undefined ? { versionPolicy: opts.versionPolicy } : {}),
        ...(opts.onFirstSubscriber ? { onFirstSubscriber: opts.onFirstSubscriber } : {}),
        ...(opts.onLastSubscriberGone ? { onLastSubscriberGone: opts.onLastSubscriberGone } : {}),
        // Shared TelemetrySink — bound once at composition so future
        // live-channel operational signals land on the same sink as the
        // existing server.composed signal.
        telemetry,
      })
    : null;
  // Publish to the health endpoint closure. Declared separately so the
  // Express handler above can lazily read subscriber counts without
  // capturing the channel variable through a top-level reference that
  // would force declaration-order gymnastics.
  channelForHealth = channel;

  // Boot-time operational signal. Emitted once at the end of
  // composition so downstream metrics systems record "server
  // composed N tools, pairing=…, threads=…, renderChannel=…". Not
  // an audit event — it's a lossy health beacon, not a privileged
  // action.
  telemetry.emit({
    name: "server.composed",
    at: Date.now(),
    attributes: {
      serverName: info.name,
      toolCount: handlers.length,
      pairing: pairingEnabled,
      threads: opts.threads !== undefined,
      renderChannel: channel !== null,
      mcpApps: mcpAppsEnabled,
      console: consoleEnabled,
      primitiveCatalogs: opts.primitiveCatalogs?.length ?? 0,
      themeSource: opts.theme?.source ?? "default",
      // Named mount bundles aggregated onto `/mcp`. Zero by default;
      // surfaces the mount count so operators running `ggui serve`
      // with external fixtures can see the composition at boot.
      mcpMounts: opts.mcpMounts?.length ?? 0,
    },
  });

  // Snapshot the catalogs once so the returned handle + any future
  // read surfaces share one frozen-shape reference. Also normalizes
  // `undefined` → empty array so consumers don't need to null-check.
  const primitiveCatalogs: readonly DiscoveredPrimitiveCatalog[] = opts.primitiveCatalogs
    ? [...opts.primitiveCatalogs]
    : [];

  // Theme: accept the caller's `LoadedTheme` as-is; fall back to the
  // shipped default when absent. `loadTheme({ projectRoot: '/', ... })`
  // with an empty manifest always returns the default-branch result
  // (the default branch is triggered by `manifest.theme === undefined`
  // regardless of projectRoot), so the absolute-path invariant stays
  // happy with any concrete root — `'/'` is fine for the synthetic
  // manifest the fallback constructs.
  const theme: LoadedTheme =
    opts.theme ??
    (() => {
      const result = loadTheme({
        projectRoot: "/",
        manifest: {
          schema: "1",
          protocol: "1.1",
          app: { slug: "oss", name: "OSS" },
          blueprints: { include: [] },
          primitives: { packages: [], local: [] },
          // `mcpMounts` became required on the manifest type when
          // `@ggui-ai/project-config` commit 6665d478 landed. The
          // fallback-path synthetic manifest needs an empty array
          // to satisfy the type — loadTheme's default branch is
          // triggered by `manifest.theme === undefined` and never
          // reads mcpMounts.
          mcpMounts: [],
        },
      });
      if (!result.ok) {
        // Can't happen: the default path never reads from disk and
        // never touches the schema validator. If the invariant ever
        // breaks we want a hard crash at boot, not a silent fallback
        // to some third theme the rest of the code doesn't expect.
        throw new Error(`createGguiServer: default theme failed to load — ${result.issue.message}`);
      }
      return result.theme;
    })();

  let httpServer: NodeHttpServer | null = null;

  return {
    app,
    toolCount: handlers.length,
    renderChannel: channel,
    pairingService,
    primitiveCatalogs,
    theme,
    adminToken: resolvedAdminToken,
    generators: generators ?? null,
    blueprintStore,
    blueprintSelector,
    blueprintSearch,
    async listen(port = 0, host = "127.0.0.1"): Promise<NodeHttpServer> {
      return new Promise((resolve, reject) => {
        const server = app.listen(port, host, () => {
          const addr = server.address();
          const boundPort = addr && typeof addr !== "string" ? addr.port : port;
          logger.info("listening", {
            host,
            port: boundPort,
            tools: handlers.length,
            renderChannel: channel ? channel.path : null,
            ...(resolvedAdminToken !== null
              ? {
                  adminTokenHint: "console /keys gate — see banner for token value",
                }
              : {}),
          });
          httpServer = server;
          resolve(server);
        });
        server.on("error", reject);
        // Wire live-channel upgrade handling onto the same http server.
        // Only routes matching the channel path actually become WebSockets;
        // other paths (or a future second WS endpoint) are rejected.
        if (channel) {
          server.on("upgrade", (req, socket, head) => {
            const url = new URL(req.url ?? "/", "http://localhost");
            if (url.pathname !== channel.path) {
              socket.write("HTTP/1.1 404 Not Found\r\n" + "Connection: close\r\n\r\n");
              socket.destroy();
              return;
            }
            channel.handleUpgrade(req, socket, head);
          });
        }
      });
    },
    async close(): Promise<void> {
      if (channel) await channel.close();
      const server = httpServer;
      if (!server) return;
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      httpServer = null;
    },
  };
}

/**
 * Build the {@link OAuthConfig.validateResource} callback from the
 * deployment shape (RFC 8707).
 *
 * Two valid resource shapes are recognized:
 *   - **Universal** — exactly `${issuer}` when `universalMcpPath` is
 *     `/`, otherwise `${issuer}${universalMcpPath}`. Cloud
 *     `mcp.ggui.ai` collapses the bare-root case (the domain already
 *     says "mcp"); OSS keeps `/mcp`.
 *   - **Per-app** — `${issuer}${perAppRouting.pathPrefix}/<appId>`
 *     where `<appId>` matches `perAppRouting.paramPattern`. Cloud
 *     uses `/apps` prefix + `[A-Za-z0-9]{8}`.
 *
 * Anything else returns `false` → /authorize emits `invalid_target`
 * per RFC 8707 §2 before showing consent. Defense-in-depth — the
 * consent UI also reads the resource to display "which app" but it
 * can trust the value because it's already been validated.
 */
function buildResourceValidator(opts: {
  universalMcpPath: string;
  perAppRouting?: {
    paramName: string;
    paramPattern: string;
    pathPrefix?: string;
  };
}): (issuer: string, resource: string) => boolean {
  const { universalMcpPath, perAppRouting } = opts;
  // Normalize a single trailing slash on the path-only-root form. RFC
  // 3986 §6.2.3 says `https://host` and `https://host/` are equivalent
  // when no other path segments follow. Some clients (claude.ai 2026-05)
  // canonicalize the OAuth `resource` indicator with a trailing slash
  // even when the advertised resource (per /.well-known/oauth-
  // protected-resource) has none — strict-equality rejects them as
  // invalid_target. Normalize both sides before comparing.
  const stripTrailingSlash = (url: string): string => (url.endsWith("/") ? url.slice(0, -1) : url);
  return (issuer: string, resource: string): boolean => {
    const universalResource = universalMcpPath === "/" ? issuer : `${issuer}${universalMcpPath}`;
    if (stripTrailingSlash(resource) === stripTrailingSlash(universalResource)) return true;
    if (!perAppRouting) return false;
    const { paramPattern, pathPrefix = "" } = perAppRouting;
    // Anchor both ends so partial matches like
    // `${issuer}/apps/<id>/extra` don't slip through. Allow optional
    // trailing slash on per-app resources for the same client-canonical
    // -form reason as universal above.
    const prefixEscaped = `${issuer}${pathPrefix}/`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^${prefixEscaped}(?:${paramPattern})/?$`);
    return re.test(resource);
  };
}
