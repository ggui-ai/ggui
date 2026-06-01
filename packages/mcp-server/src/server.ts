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
  LlmProvider,
  PairingService,
  PendingEventConsumer,
  ProviderKeyStore,
  RateLimiter,
  RenderStore,
  SessionStreamBuffer,
  ShortCodeIndex,
  TelemetrySink,
  ThreadStore,
  VectorStore,
} from "@ggui-ai/mcp-server-core";
import {
  CODE_HASH_REGEX,
  createDeterministicBlueprintSelector,
  isEnumerableVectorStore,
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
  InMemoryRenderStore,
  InMemorySessionStreamBuffer,
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
import { GguiJsonV1 } from "@ggui-ai/project-config";
import type { DiscoveredPrimitiveCatalog, LoadedTheme } from "@ggui-ai/project-config/node";
import { findGguiJson, loadTheme, safeLoadGguiJson } from "@ggui-ai/project-config/node";
import type { Blueprint, CanvasLifecyclePayload, Render } from "@ggui-ai/protocol";
import { LIFECYCLE_CHANNEL } from "@ggui-ai/protocol";
import {
  GGUI_RENDER_RESOURCE_MIME,
  GGUI_RENDER_RESOURCE_URI,
  MCP_APP_AI_GGUI_RENDER_META_KEY,
  type McpAppAiGguiRenderMeta,
} from "@ggui-ai/protocol/integrations/mcp-apps";
import { setLlmTraceSink } from "@ggui-ai/ui-gen/harness/llm-trace-sink";
import { setValidatorTraceSink } from "@ggui-ai/ui-gen/harness/validator-trace-sink";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Express, type Request, type Response } from "express";
import type { ParamsDictionary } from "express-serve-static-core";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Server as NodeHttpServer } from "node:http";
import path from "node:path";
import { z, type ZodRawShape } from "zod";
import {
  CONSOLE_COOKIE_NAME,
  mintDevtoolCookie,
  readDevtoolCookieFromHeaders,
  verifyDevtoolCookie,
} from "./console-auth.js";
import { BoundedCacheTraceSink, mountConsoleCacheRoutes } from "./console-cache.js";
import { applyDevtoolSecurityHeaders } from "./console-headers.js";
import { singleParam } from "./route-param.js";
import { BoundedLlmTraceSink, mountConsoleLlmTraceRoutes } from "./console-llm-trace.js";
import { BoundedPayloadTraceSink, mountConsolePayloadsRoutes } from "./console-payloads.js";
import {
  mountDevtoolThemeRoutes,
  type ThemeFileUploader,
  type ThemeWriter,
} from "./console-theme-routes.js";
import { mountConsoleTimelineRoutes } from "./console-timeline.js";
import { BoundedValidatorTraceSink, mountConsoleValidatorRoutes } from "./console-validator.js";
import { renderWelcomeHtml } from "./console-welcome.js";
import { GGUI_RENDER_SHELL_HTML } from "./mcp-apps-outbound.js";
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
  clearGenerationCache,
  createGguiConsumeHandler,
  createGguiEmitHandler,
  createGguiGetRenderHandler,
  createGguiHandshakeHandler,
  createGguiListRendersHandler,
  createGguiRefreshWsTokenHandler,
  createGguiRenderHandler,
  createGguiSubmitActionHandler,
  createGguiSyncContextHandler,
  createGguiUpdateHandler,
  createInMemoryProvisionalPreviewRegistry,
  deriveContractBundle,
  derivePublicEnvProjection,
  deriveRenderMeta,
  invalidateGenerationCache,
  listBlueprints,
  listGenerationCache,
  type ChannelNotifier,
  type GenerationCacheEntry,
  type GenerationCredentials,
  type GenerationDeps,
  type HandshakeNegotiator,
  type PropsUpdateNotifier,
  type ProvisionalPreviewConfig,
  type ProvisionalPreviewDeps,
  type ProvisionalPreviewEmitter,
  type ProvisionalPreviewOutcome,
} from "@ggui-ai/mcp-server-handlers/renders";
import type { UiRegistry } from "@ggui-ai/ui-registry";
import {
  DEFAULT_ADMIN_BLUEPRINTS_PATH,
  mountAdminBlueprintsTransport,
} from "./admin-blueprints-transport.js";
import { mountAdminOAuthProvidersTransport } from "./admin-oauth-providers-transport.js";
import {
  DEFAULT_BUILDER_APP_ID,
  defaultAppIdFromIdentity,
  resolveIdentity,
  UnauthenticatedError,
} from "./auth.js";
import { buildMcpServer, type ServerInfo } from "./build-mcp.js";
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
import {
  buildWwwAuthenticate,
  handleAuthorizationServerMetadata,
  handleAuthorizeGet,
  handleAuthorizePost,
  handleProtectedResourceMetadata,
  handleRegister,
  handleToken,
  InMemoryOAuthStorage,
  resolveIssuerUrl,
  type OAuthConfig,
  type OAuthStorage,
} from "./oauth.js";
import {
  DEFAULT_PAIRING_ADMIN_INIT_PATH,
  DEFAULT_PAIRING_PATH,
  mountPairingTransport,
} from "./pairing-transport.js";
import { createPairLoginRateLimitMiddleware } from "./rate-limit-middleware.js";
import {
  createRenderChannelServer,
  type RenderChannelServer,
  type WiredActionRouter,
} from "./render-channel.js";
import { buildRequestContextMiddleware, resolveRuntimeUrl } from "./request-context.js";
import { composePreviewReservedValidator, mergeReservedValidators } from "./reserved-validators.js";
import {
  checkRenderSchemaCompat,
  DEFAULT_SCHEMA_COMPAT_MODE,
  SchemaCompatError,
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
 * Type-narrowing predicate for an `_meta` shape that carries an
 * MCP-Apps `ui.visibility` array. Defensive against legacy handlers
 * that omit `_meta` entirely (no cast required to read through).
 */
function hasUiVisibilityArray(meta: Record<string, unknown> | undefined): meta is Record<
  string,
  unknown
> & {
  ui: { visibility: readonly string[] };
} {
  if (!meta) return false;
  const ui = meta["ui"];
  if (ui === null || typeof ui !== "object") return false;
  const visibility = (ui as { visibility?: unknown }).visibility;
  return Array.isArray(visibility) && visibility.every((v) => typeof v === "string");
}

/**
 * Scan a handler list and return the names of those whose
 * `_meta.ui.visibility` array includes `"app"`. Used by the push
 * handler's `appCallableTools` provider to populate the bootstrap
 * field the iframe-runtime consults for Pattern α / Pattern β
 * dispatch routing.
 *
 * Returns an empty array when no app-visible tools are registered.
 * Order matches handler registration order (deterministic for tests).
 */
function collectAppCallableToolNames(
  handlers: ReadonlyArray<SharedHandler<ZodRawShape, ZodRawShape>>
): readonly string[] {
  const names: string[] = [];
  for (const h of handlers) {
    if (!hasUiVisibilityArray(h._meta)) continue;
    if (h._meta.ui.visibility.includes("app")) {
      names.push(h.name);
    }
  }
  return names;
}

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
 * `push` is opt-in via `deps.push` — it's only useful when the server
 * was booted with `mcpApps: true` (so `ui://ggui/render` is served)
 * and pairs a real RenderStore. Callers get the choice explicitly.
 */
/**
 * Assemble the `opsBlueprint` dep bundle for `defaultHandlers`.
 *
 * Encapsulates the in-memory-store-narrowing logic at one site so the
 * call site stays clean. When the store is `InMemoryBlueprintStore`,
 * we wire its `putCode` + `listAllForApp` hooks (the in-memory
 * equivalents of the cloud adapter's S3 putObject + `blueprintsByApp`
 * GSI query). Cloud stores omit both — their `BlueprintStore.put`
 * writes code to S3 directly, and their `BlueprintSearch` impl owns
 * the per-app enumeration.
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
   * agent-facing matchBlueprint exact-key probe (handshake + push)
   * finds operator-authored blueprints. Same bundle the handshake
   * negotiator + push handler already consume — single source of
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
     * ownership) before negotiating. OSS sets this to the same store
     * the render-commit handler uses so the handshake catches unknown
     * / cross-tenant ids at the earliest boundary; cloud pods omit and
     * validate at render-commit time via their own DDB-backed path.
     */
    readonly renderStore?: RenderStore;
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
  readonly push?: {
    readonly renderStore: RenderStore;
    /**
     * Optional bootstrap-credential minter. When present, `ggui_render`
     * (the renamed render-commit tool) results carry the
     * `ai.ggui/render` slice meta. When absent, they don't —
     * non-MCP-Apps hosts read `{renderId}` off structuredContent and
     * resolve the render-resource themselves.
     */
    readonly mintBootstrap?: (
      renderId: string,
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
     * Live theme getter — resolved per-push. When set, supersedes
     * the static `themeId` / `themeMode` for every push's bootstrap.
     * Pair with the same getter passed into `createGguiServer({
     * themeProvider })` and a closure that reads from the shared
     * mutable cell `mountDevtoolThemeRoutes`'s POST handler updates.
     * Forwarded onto `deps.push.themeProvider` so the handler reads
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
     * `shortcuts.mcpApps` push payloads (inbound MCP Apps hosting).
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
     * Optional shortCode → session binding index. When present,
     * `ggui_render` records every minted `shortCode` so console's
     * `/s/<shortCode>` viewer (via the session-cookie endpoint) can
     * resolve it back to the right session. Absent = hosted cloud
     * flow (DynamoDB side-table owns lookups), or console not
     * enabled.
     */
    readonly shortCodeIndex?: ShortCodeIndex;
    /**
     * Optional provisional-preview wiring. When present, `ggui_render`
     * kicks off the configured emitter on every qualifying push (the
     * `evaluateProvisionalPreviewGate` predicate filters MCP Apps
     * pushes + storyless calls automatically). Absent = no preview
     * channel traffic.
     *
     * Constructed by `createGguiServer` from `opts.provisionalPreview`
     * plus the late-bound `RenderChannelServer.sendToSession`
     * closure; callers threading their own handler set can build
     * `ProvisionalPreviewDeps` directly.
     */
    readonly provisionalPreview?: ProvisionalPreviewDeps;

    /**
     * Optional generation wiring. When present, `ggui_render` invokes
     * the supplied {@link UiGenerator} on every story-path call and
     * commits the generated `Render` before returning `codeReady:
     * true`. Absent = push stays in placeholder mode (render +
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
     * before every `renderStore.commit` — if the pending Render's
     * `actionSpec` / `streamSpec` references a tool whose schemas
     * disagree, the hook throws `SchemaCompatError` and the handler
     * converts the rejection into an error render + `codeReady:
     * false`. Forwarded as-is to `createGguiRenderHandler`.
     *
     * `createGguiServer` binds this closure against the composed
     * `handlers` list + `opts.schemaCompatCheck` (default `'reject'`)
     * automatically; callers composing their own push handler via
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
     * via live-mode (wsUrl+token) and receives the stack item via the
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
     * `ggui_runtime_refresh_bootstrap` tool (G14, 2026-05-23). When
     * supplied, the tool registers and validates each refresh request
     * via this seam's HMAC check + refresh-window arithmetic. Typically
     * wired against the SAME `channelBootstrap.refresh` the
     * session-channel server uses for WS upgrade validation, so both
     * paths share one HMAC secret and one refresh-window policy.
     *
     * Absent: the tool is NOT registered on this deployment. iframes
     * fall back to the historical "fresh handshake on every reconnect"
     * posture — fast via the matcher cache, but more wire traffic than
     * a stateless refresh.
     *
     * `createGguiServer` wires this from the `mcpAppsEnabled` branch's
     * `channelBootstrap.refresh` so the OSS factory's behavior matches
     * the cloud pod's tool-side composition.
     */
    readonly bootstrapRefresh?: import("@ggui-ai/mcp-server-handlers/renders").WsTokenRefreshSeam;
  };
  /**
   * `ggui_update` wiring. When present, register the OSS update
   * handler against the supplied RenderStore + optional live-channel
   * props_update notifier. The handler reads `renderId` from wire
   * input today, but a future in-process dispatcher can populate it
   * on the canonical context.
   *
   * Absent = `ggui_update` is NOT registered on this server. Hosts
   * that don't expose props mutation keep the smaller surface (e.g.,
   * static-blueprint demos, MCP-Apps-only deployments).
   */
  readonly update?: {
    readonly renderStore: RenderStore;
    /**
     * Optional live-subscriber `props_update` notifier — typically a
     * thin closure over `RenderChannelServer.sendPropsUpdate`.
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
      renderId: string,
      appId: string
    ) => { wsUrl: string; token: string; expiresAt: string };
    /** Iframe-runtime bundle URL forwarded onto the
     *  `ai.ggui/render.runtimeUrl` slice field.
     *  Function form mirrors push deps — see {@link BuildMcpDeps.push}. */
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
    /** Returns names of app-visible tools for bootstrap.appCallableTools. */
    readonly appCallableTools?: () => readonly string[];
    /** Resolver for bootstrap.streamWebSocketLocalTools. */
    readonly streamWebSocketLocalTools?: () => readonly string[] | undefined;
  };
  /**
   * Pending-events consumer wiring for `ggui_consume`. When `push`
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
   * Stream channel wiring for `ggui_emit`. When `push` is bound, the
   * handler registers automatically; its `sendEnvelope` closes over
   * `stream.channelProvider`, a lazy getter that resolves the
   * `RenderChannelServer` at emit time (the channel is constructed
   * AFTER `defaultHandlers` runs, so a static reference would always
   * be null on the OSS in-process boot).
   *
   * Absent / returns null = no live receiver. Emit still succeeds at
   * the protocol level; the envelope just isn't fanned out. Matches
   * cloud's `ggui_emit_accepted_no_receiver` posture.
   *
   * The getter pattern lets the OSS server bind once at boot, then
   * mutate the cell after `createRenderChannelServer` runs.
   */
  readonly stream?: {
    readonly channelProvider?: () => RenderChannelServer | null;
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
   *     `blueprints` too — same deps the push generation path
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
     * as `push.generation.resolveLlm` — typically wired to the same
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
     * matchBlueprint exact-key probe (handshake + push) finds them.
     * Same bundle the push handler reads/writes.
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
  // Single shared pending-events pipe (Model C, renderId-keyed).
  // push opens (`markCreated`), submit_action appends, consume drains,
  // pop/close clean up. Every handler that touches the pipe MUST get
  // the same instance — separate instances would mean the pipe push
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
    // optional — passed through from `deps.push.renderStore` when
    // bound; absent → ledger write is skipped, queue still fires.
    createGguiSubmitActionHandler({
      pendingEventConsumer,
      activeConsumerRegistry,
      ...(deps.push?.renderStore ? { renderStore: deps.push.renderStore } : {}),
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
  // ggui_runtime_sync_context — runtime → server contextSpec snapshot mirror.
  // Same `_meta.ui.visibility: ['app']` channel as ggui_runtime_submit_action;
  // claude.ai (and any MCP Apps host) routes iframe-issued
  // `tools/call` here. Wired only when a renderStore is bound (push
  // is on) — the handler's whole job is upserting the snapshot onto
  // the active Render, which requires the same store push writes
  // to. Without push, there's no render to mutate.
  if (deps.push) {
    handlers.push(
      createGguiSyncContextHandler({
        renderStore: deps.push.renderStore,
      }) as SharedHandler<ZodRawShape, ZodRawShape>
    );
    // `ggui_runtime_refresh_bootstrap` — G14 (2026-05-23) signed-
    // envelope refresh tool. Registered only when a refresh seam is
    // wired (typically `channelBootstrap.refresh` from the
    // mcpAppsEnabled branch). Without the seam, the tool would always
    // return BOOTSTRAP_NOT_SUPPORTED, which is honest but useless on
    // tools/list — skip registration entirely.
    if (deps.push.bootstrapRefresh) {
      handlers.push(
        createGguiRefreshWsTokenHandler({
          refreshSeam: deps.push.bootstrapRefresh,
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
  // Canvas-mode lifecycle emitter — shared by handshake/push/consume so
  // the three handlers publish to the reserved `_ggui:lifecycle`
  // channel through one binding. Lazy-resolves the channel provider
  // because `createRenderChannelServer` runs after `defaultHandlers`;
  // a static reference would always be null on first emit. Mirrors the
  // pattern `ggui_emit`'s `sendEnvelope` uses below.
  //
  // Fire-and-forget: a slow / failing publish degrades the canvas
  // animator (no pill state change for that signal) but MUST NOT
  // impact the handler's primary result.
  const lifecycleChannelProvider = deps.stream?.channelProvider;
  const canvasLifecycleEmitter = lifecycleChannelProvider
    ? {
        emit(renderId: string, payload: CanvasLifecyclePayload): void {
          const channel = lifecycleChannelProvider();
          if (!channel) return;
          void channel
            .sendToSession({
              renderId,
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
        ...(canvasLifecycleEmitter ? { canvasLifecycle: canvasLifecycleEmitter } : {}),
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
        // Bootstrap-emission deps mirror push so MCP Apps hosts that
        // forward `ui/notifications/tool-result` via postMessage can
        // re-apply patched props on the live mount without a WS round-trip.
        ...(deps.update.mintBootstrap ? { mintWsToken: deps.update.mintBootstrap } : {}),
        ...(deps.update.runtimeUrl !== undefined ? { runtimeUrl: deps.update.runtimeUrl } : {}),
        ...(deps.update.themeId !== undefined ? { themeId: deps.update.themeId } : {}),
        ...(deps.update.themeMode !== undefined ? { themeMode: deps.update.themeMode } : {}),
        ...(deps.update.themeProvider !== undefined
          ? { themeProvider: deps.update.themeProvider }
          : {}),
        ...(deps.update.appCallableTools !== undefined
          ? { appCallableTools: deps.update.appCallableTools }
          : {}),
        ...(deps.update.streamWebSocketLocalTools !== undefined
          ? { streamWebSocketLocalTools: deps.update.streamWebSocketLocalTools }
          : {}),
      }) as SharedHandler<ZodRawShape, ZodRawShape>
    );
  }
  // ggui_consume registers whenever push is bound (it shares the
  // RenderStore for renderId resolution + tenancy checks).
  // Default backing is in-memory; operators override via
  // `deps.consume.pendingEventConsumer` for SQLite / Dynamo adapters.
  // Without this registration the `nextStep → consume` hint that
  // every push response carries would resolve to a not-found tool.
  if (deps.push) {
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
          readonly renderId: string;
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
        renderStore: deps.push.renderStore,
        activeConsumerRegistry,
        ...(deps.consume?.defaultRenderTtlSeconds !== undefined
          ? { defaultRenderTtlSeconds: deps.consume.defaultRenderTtlSeconds }
          : {}),
        ...(drainAckNotifier ? { drainAckNotifier } : {}),
        logger: drainTelemetryLogger,
        ...(canvasLifecycleEmitter ? { canvasLifecycle: canvasLifecycleEmitter } : {}),
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
    // ggui_get_render is a pure read off the RenderStore, registered
    // alongside the render-commit handler. (ggui_get_stack was deleted
    // — a render IS the addressable unit; there is no stack to read.
    // The former companion `ggui_close` tool was also retired: renders
    // decay implicitly via TTL, so there is no terminal write to make.)
    handlers.push(
      createGguiGetRenderHandler({
        renderStore: deps.push.renderStore,
      }) as SharedHandler<ZodRawShape, ZodRawShape>
    );
    // ggui_list_renders — host-scoped render enumeration for resume.
    // Folds the ws-token mint into the same call so the host doesn't
    // round-trip twice (list, then mint-per-render). Reuses the
    // already-wired `deps.push.mintBootstrap` seam so both code paths
    // share one HMAC secret and one TTL policy. Absent seam (rare —
    // every deployment that has push wired also has mintBootstrap)
    // ⇒ summaries omit wsToken and the caller must mint elsewhere.
    const pushMintBootstrap = deps.push.mintBootstrap;
    handlers.push(
      createGguiListRendersHandler({
        renderStore: deps.push.renderStore,
        ...(pushMintBootstrap !== undefined
          ? {
              mintWsToken: {
                mint: ({ renderId, appId }) => {
                  const { token, expiresAt } = pushMintBootstrap(renderId, appId);
                  return { token, expiresAt };
                },
              },
            }
          : {}),
      }) as SharedHandler<ZodRawShape, ZodRawShape>
    );
    // `ggui_emit` routes outbound stream envelopes through the active
    // `RenderChannelServer.sendToSession`
    // (which records into the bound `SessionStreamBuffer` + fans out
    // to subscribers). When no channel is bound, the handler accepts
    // the envelope and returns silently — mirrors cloud's
    // `ggui_emit_accepted_no_receiver` posture.
    //
    // `channelProvider` is lazy because `createRenderChannelServer`
    // runs AFTER `defaultHandlers`; a static reference would always
    // be null on first emit. The OSS server's outer scope mutates
    // `channelForHealth` on listen() and points the provider at it.
    const channelProvider = deps.stream?.channelProvider;
    handlers.push(
      createGguiEmitHandler({
        renderStore: deps.push.renderStore,
        async sendEnvelope(envelope) {
          const channel = channelProvider?.() ?? null;
          if (!channel) {
            // No live receiver. Accept at the protocol boundary; no
            // fan-out happens. `seq` is unset because no buffer
            // recorded the envelope.
            return {};
          }
          const { seq } = await channel.sendToSession({
            renderId: envelope.renderId,
            channel: envelope.channel,
            mode: envelope.mode,
            payload: envelope.payload,
            ...(envelope.complete === true ? { complete: true as const } : {}),
          });
          // `sendToSession` plumbs the stamped seq out of fanOut so
          // ggui_emit's wire output carries ordering info — matches
          // cloud's `RedisSessionStreamBuffer.record` returning seq
          // and being threaded onto the response. Agents that want to
          // correlate "I just emitted on channel X" with a specific
          // wire frame have a stable handle.
          return { seq };
        },
      }) as SharedHandler<ZodRawShape, ZodRawShape>
    );
  }
  if (deps.push) {
    // Provider that scans the registered handler list for tools
    // whose `_meta.ui.visibility` includes
    // `"app"`, surfacing the names on `bootstrap.appCallableTools`.
    // Closure defers the scan to push-time so handlers added AFTER
    // push (e.g. mounted MCP server tools composed via
    // `composeHandlersWithMounts`) are NOT included — same-server
    // app-visible tools live on the OSS handler list, mounted tools
    // are by definition cross-server.
    const appCallableToolsProvider = (): readonly string[] => collectAppCallableToolNames(handlers);
    handlers.push(
      createGguiRenderHandler({
        renderStore: deps.push.renderStore,
        // Plugin slice Commit 3 — push reads App.gadgets to
        // gate `clientCapabilities.gadgets[*].hook` references via
        // `assertGadgetsRegistered`. Same instance the
        // handshake handler reads from so both seams enforce the
        // same registry membership.
        ...(deps.appMetadataStore ? { appMetadataStore: deps.appMetadataStore } : {}),
        pendingEventConsumer,
        appCallableTools: appCallableToolsProvider,
        ...(deps.push.streamWebSocketLocalTools !== undefined
          ? { streamWebSocketLocalTools: deps.push.streamWebSocketLocalTools }
          : {}),
        ...(deps.push.mintBootstrap ? { mintWsToken: deps.push.mintBootstrap } : {}),
        ...(deps.push.runtimeUrl !== undefined ? { runtimeUrl: deps.push.runtimeUrl } : {}),
        ...(deps.push.themeId !== undefined ? { themeId: deps.push.themeId } : {}),
        ...(deps.push.themeMode !== undefined ? { themeMode: deps.push.themeMode } : {}),
        ...(deps.push.themeProvider !== undefined
          ? { themeProvider: deps.push.themeProvider }
          : {}),
        ...(deps.push.connectors ? { connectors: deps.push.connectors } : {}),
        ...(deps.push.rateLimiter ? { rateLimiter: deps.push.rateLimiter } : {}),
        ...(deps.push.shortCodeIndex ? { shortCodeIndex: deps.push.shortCodeIndex } : {}),
        ...(deps.push.provisionalPreview
          ? { provisionalPreview: deps.push.provisionalPreview }
          : {}),
        ...(deps.push.generation ? { generation: deps.push.generation } : {}),
        // Live-subscriber render-commit notifier. Forwarded as-is
        // when present so the render handler can fan out
        // `renderStore.commit` deltas to already-subscribed
        // live-channel clients. Hosts without a render channel pass
        // nothing; the handler's own no-op-on-absent posture keeps
        // the path intact.
        ...(deps.push.channelNotifier ? { channelNotifier: deps.push.channelNotifier } : {}),
        // F4 schema compat hook. Forwarded as-is; the push handler
        // wraps it in try/catch
        // on the generation + cache-hit paths so a thrown
        // SchemaCompatError converts to an error stack-item.
        ...(deps.push.checkRenderContracts
          ? { checkRenderContracts: deps.push.checkRenderContracts }
          : {}),
        // Content-addressable code store. Both fields are forwarded
        // together; the push handler
        // requires both to emit `codeUrl`. Absent or partial =
        // inline-base64 fallback (see push.ts handler body).
        ...(deps.push.codeStore && deps.push.codeBaseUrl
          ? {
              codeStore: deps.push.codeStore,
              codeBaseUrl: deps.push.codeBaseUrl,
            }
          : {}),
        // Share the handshake KV store between the two handlers so
        // the write (ggui_handshake) + read (ggui_render) sit on one
        // source of truth. The caller can also pass a different
        // handshakeStore to push if they split minting + consuming
        // across processes, but the defaults wire them to the same
        // instance.
        ...(deps.handshake ? { handshakeStore: deps.handshake.kvStore } : {}),
        ...(canvasLifecycleEmitter ? { canvasLifecycle: canvasLifecycleEmitter } : {}),
      }) as SharedHandler<ZodRawShape, ZodRawShape>
    );
  }
  // Operator-class blueprint tools. Registered
  // on /ops via `audience: ['ops']`. Three read-mutating tools land
  // whenever the blueprint store + search seam is bound; the
  // `generate` tool additionally requires `resolveLlm` +
  // `blueprints` (same deps the push generation path reads). Cloud
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
        registry: deps.opsBlueprint.registry,
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
   *     agent-builder writes (push / handshake / update) while keeping
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
   * closes the parallel-state-stores bug where the push handler
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
   * the callback writes to so a console save reaches the next push
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
   * Streamable HTTP convention. Cloud `mcp.ggui.ai` overrides to `/`
   * (bare root) so URLs are short — the domain already says "mcp",
   * no need to repeat it in the path.
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
   * Cloud `mcp.ggui.ai` deployments pass `{paramName: 'appId',
   * paramPattern: '[A-Za-z0-9]{8}', pathPrefix: '/apps'}` so URLs
   * like `mcp.ggui.ai/apps/aB3kP9xY` route to a session scoped to
   * that specific GguiApp. The `/apps/` prefix segments the
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
   * Cloud uses this to verify `GguiApp.userId === identity.userId`
   * (raw-DDB readers in pod tools bypass AppSync owner-auth, so
   * this is the boundary that prevents cross-user blueprint reads).
   * OSS deployments that opt in to per-app routing without an
   * authorize callback are TRUSTED — every authenticated caller can
   * scope to any URL appId.
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
   * tool handlers (e.g. `SessionAccessError` "this session doesn't belong
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
   * Render store — backing plane for the live-channel render endpoint
   * (and OSS render-reading MCP tools). Defaults to
   * `InMemoryRenderStore`, which is fine for OSS zero-config / dev.
   * SQLite / Postgres / Redis adapters bind via the same interface
   * when they land.
   */
  readonly renderStore?: RenderStore;

  /**
   * Outbound stream replay buffer for the live-channel endpoint. Defaults
   * to a fresh `InMemorySessionStreamBuffer` — fine for OSS zero-config
   * / dev. Operators who need durability layer a different
   * `SessionStreamBuffer` implementation behind this seam.
   *
   * Only used when `sessionChannel` is enabled. Ignored otherwise.
   */
  readonly streamBuffer?: SessionStreamBuffer;

  /**
   * Enable the OSS live-channel session endpoint at `/ws` (configurable).
   *
   *   - `false` (default): no session channel. `/mcp` is the only
   *     HTTP surface. Callers who only need the tool plane get the
   *     smallest shape.
   *   - `true`: mount the channel at the default path (`/ws`) with
   *     the default session store.
   *   - `{ path?: string }`: override the mount path.
   *
   * The live channel is where the live-contract enforcement point
   * lives. Enabling this makes the OSS server a second real consumer
   * of the shared `@ggui-ai/mcp-server-handlers/renders`
   * helpers.
   */
  readonly sessionChannel?: boolean | { readonly path?: string };

  /**
   * Opt-in WS-direct action dispatcher for agent-less deployments.
   * When present AND `sessionChannel: true`, the channel server
   * fires the tool named by an incoming action's `payload.tool` hint
   * (falling back to `actionSpec[name].nextStep` when the client
   * omitted the hint) in-process after inbound validation, and emits
   * every declared `streamSpec[name].source.tool` refresh on the
   * session. See {@link WiredActionRouter} + `session-channel.ts` for
   * the full router contract.
   *
   * Absent = agent-mediated behavior (canonical for MCP Apps hosts and
   * Claude Agent SDK consumers). Inbound actions land on the
   * renderId-keyed pending-events pipe via `ggui_runtime_submit_action`
   * and the agent's `ggui_consume` long-poll drains them. CLI
   * composition in `ggui serve` wires a router by default over the
   * same handler bundle `/mcp` uses, since that command runs WITHOUT
   * an agent (raw WS clients hitting the OSS server directly). Library
   * consumers MAY pass their own router; library consumers running
   * behind an agent typically pass `undefined` so actions flow through
   * the agent's reasoning loop.
   */
  readonly wiredActionRouter?: WiredActionRouter;
  /**
   * Per-call timeout for wired-tool invocations, in ms. Defaults to
   * `DEFAULT_WIRED_TOOL_TIMEOUT_MS` (30 s) when omitted. Forwarded
   * verbatim to `createRenderChannelServer`.
   */
  readonly wiredActionTimeoutMs?: number;
  /**
   * Opt-in plumbing for `channel_subscribe` polling — the WS fan-out
   * path for `streamSpec[*].source.tool`. When present, the
   * session channel accepts `channel_subscribe` frames whose
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
   * Only consulted when `sessionChannel` is enabled. Forwarded
   * verbatim to `createRenderChannelServer` (see
   * `RenderChannelOptions.streamWebSocketLocalTools`).
   */
  readonly streamWebSocketLocalTools?: import("./render-channel.js").RenderChannelLocalToolsOptions;
  /**
   * Hook fired when the local subscriber count for `sessionId`
   * transitions 0 → 1 on the live channel. Forwarded verbatim to
   * `createRenderChannelServer`. Used by cloud adapters for per-session
   * cross-pod pubsub channel scoping; OSS callers leave this undefined.
   *
   * Only consulted when `sessionChannel` is enabled. See
   * `RenderChannelOptions.onFirstSubscriber` for the full contract.
   */
  readonly onFirstSubscriber?: (sessionId: string) => void;
  /**
   * Hook fired when the local subscriber count for `sessionId`
   * transitions 1 → 0 on the live channel. Forwarded verbatim to
   * `createRenderChannelServer`.
   *
   * Only consulted when `sessionChannel` is enabled. See
   * `RenderChannelOptions.onLastSubscriberGone` for the full contract.
   */
  readonly onLastSubscriberGone?: (sessionId: string) => void;
  /**
   * Override the sanitizer applied to the stringified original error
   * written into `ContractErrorPayload.error.causedBy`. Defaults to
   * `@ggui-ai/protocol::sanitizeCausedBy` when omitted — redacts
   * Bearer tokens, query-param secrets, common env-var dumps, and
   * truncates at 2 KB. Forwarded verbatim to
   * `createRenderChannelServer`. See `RenderChannelOptions
   * .sanitizeCausedBy` for the contract.
   */
  readonly sanitizeCausedBy?: import("@ggui-ai/protocol").SanitizeCausedBy;

  /**
   * Extra reserved-channel payload validators merged with the
   * server's default A2UI preview validator before being passed to
   * the session channel (Item 4 injection pattern). Caller-provided
   * entries WIN on key conflict — the pattern is "server supplies
   * defaults, operator may replace by key".
   *
   * Absent = the server binds only the A2UI validator for
   * `_ggui:preview` by default. `_ggui:contract-error` is validated
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
   * Protocol-version handshake policy for the session channel. Forwarded
   * verbatim to `createRenderChannelServer` (see
   * `RenderChannelOptions.versionPolicy`). Defaults to `'reject'` —
   * mismatched `SubscribePayload.supportedVersions` emits
   * UPGRADE_REQUIRED and closes the connection. Legacy opt-out
   * `'advisory'` keeps the connection open after the error frame for
   * controlled migration windows.
   *
   * Only consulted when `sessionChannel` is enabled.
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
   *   - `'reject'` (default) — violations throw before the stack
   *     item commits (or before blueprint registration completes).
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
   *     `sessionChannel: true` so the iframe has a WebSocket to open;
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
   *      with wsUrl + short-TTL token + expiresAt. The session-channel
   *      server accepts that token on `subscribe` and issues a
   *      longer-TTL `renderToken` in the ack for iframe reconnects.
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
   * inbound MCP Apps push payloads (`shortcuts.mcpApps`) and for the
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
   *   - No same-origin cookie, no session viewer, no WebSocket
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
         * (`POST /ggui/console/render-cookie` + session-channel
         * cookie-auth wiring). Defaults to OFF — the landing-page
         * static surface is useful on its own (pair-code display,
         * server identity); turning on the cookie flow is an
         * explicit step that pulls in additional deps.
         *
         * Enabling REQUIRES `sessionChannel: true` — the cookie only
         * authenticates the live-channel WebSocket upgrade, so a cookie
         * flow without a channel to use it on would be pointless +
         * confusing. Throws at construction if that invariant fails.
         *
         * Enabling REQUIRES a configured {@link shortCodeIndex} — the
         * cookie endpoint resolves shortCode → sessionId by reading
         * it. Throws at construction if the index is absent.
         *
         * The cookie signing secret is the same {@link wsTokenSecret}
         * used by the MCP Apps bootstrap/session tokens — different
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
         * admin-login route. Other console routes (registry, sessions,
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
   * looks up the posted shortCode to find the session to bind).
   *
   * Pair this with a `push` handler so the agent's `ggui_render` writes
   * the shortCode into the same index that console later reads.
   * See `defaultHandlers` for the wiring seam.
   */
  readonly shortCodeIndex?: ShortCodeIndex;

  /**
   * Content-addressable code blob storage. When wired, this server
   * mounts `GET /code/<hash>.js` for the iframe runtime to fetch
   * compiled componentCode by content hash. The push handler writes
   * to the store before emitting `codeUrl` on the `ai.ggui/render`
   * slice.
   *
   * Defaults: when omitted the route is NOT mounted; the push
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
   * flag is on, every qualifying component push kicks off the
   * supplied emitter; frames land on the reserved `_ggui:preview`
   * channel of the push's session.
   *
   * The server owns the `sendEnvelope` + registry plumbing — only
   * the emitter + flag + optional observers are caller-facing.
   *
   * Requires `sessionChannel: true` + `mcpApps` enabled (preview
   * needs a channel to emit on AND a push handler to attach to).
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
    /** Per-push predicate. See {@link ProvisionalPreviewConfig}. */
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
   *     decision the paired push echoes as `structuredContent.decision`.
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
   * every component push invokes the bound `UiGenerator` and commits
   * the result as a real `Render`. Absent = placeholder mode:
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
   * returns resolved credentials per push.
   */
  readonly generation?: GenerationDeps;

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
   * push-on-cache-miss can read + write through it. When omitted,
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
   * The OSS live-channel session endpoint, when `sessionChannel` was
   * enabled. `null` when disabled. Hosts can use this for
   * introspection (`.sessionCount`, `.subscriberCount`) or for
   * composition with future mutation handlers that want to fan out
   * via `sessionChannel.sendToSession(sessionId, data)`.
   */
  readonly sessionChannel: RenderChannelServer | null;
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
  // setPayloadTraceSink because the push + update factories are
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
  // `_meta.ui.*`. Requires `sessionChannel` so the iframe has a
  // live-channel endpoint to connect to; without it the path is pointless.
  const mcpAppsEnabled = opts.mcpApps !== undefined && opts.mcpApps !== false;
  if (mcpAppsEnabled && !opts.sessionChannel) {
    throw new Error(
      "createGguiServer: `mcpApps` requires `sessionChannel: true`. The MCP Apps iframe has nowhere to connect to without a live-channel endpoint."
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

  // Lazy resolver: each push/update handler invocation looks up the
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

  // Render store is resolved here (not lazy-inside-sessionChannel)
  // when mcpApps is on, because the render-commit handler needs it at
  // handler-factory time, BEFORE the session-channel factory runs.
  const renderStore: RenderStore | undefined =
    opts.renderStore ??
    (mcpAppsEnabled || opts.sessionChannel ? new InMemoryRenderStore() : undefined);

  // Outbound stream replay buffer is hoisted here so the
  // `/ggui/console/timeline/*` mount can read its cursor alongside
  // RenderStore events. Only constructed when the channel is
  // enabled; otherwise there's nothing to buffer and the timeline
  // routes report `streamSeq: 0` honestly.
  const streamBuffer: SessionStreamBuffer | undefined = opts.sessionChannel
    ? (opts.streamBuffer ?? new InMemorySessionStreamBuffer())
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
    | ((renderId: string, appId: string) => { wsUrl: string; token: string; expiresAt: string })
    | undefined;
  let channelBootstrap: import("./render-channel.js").RenderChannelBootstrap | undefined;
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
    const syncMinter = (renderId: string, appId: string) => {
      const { token, claims } = mintWsToken({ renderId, appId }, secret);
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
            renderId: result.claims.renderId,
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
      issueSessionToken: (renderId, appId) => {
        const { token } = mintSessionToken({ renderId, appId }, secret);
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

  // Live-channel session endpoint reference. Declared here (not at the
  // Express `app` block below) so the provisional-preview
  // `sendEnvelope` closure can late-bind to it. Assignment happens
  // during the session-channel factory run further down. Safe because
  // `ggui_render` can only fire after `listen()` binds HTTP, which is
  // strictly after that factory runs.
  let channelForHealth: RenderChannelServer | null = null;

  // Provisional preview wiring. Must precede the default-handlers
  // construction so `push.provisionalPreview` is threaded through at
  // that point.
  //
  // Preconditions:
  //   - flag `enabled: true` requires `mcpApps` (ggui_render attached)
  //     + `sessionChannel` (envelope transport). We already threw on
  //     `mcpApps` without `sessionChannel` above, so this check only
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
        cache:
          opts.generation.cache ??
          ({ embedding, vectorStore: vectors, index } as const),
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
  //      returns a sensible create/update shape based on session
  //      state + agent prompt. RAG infrastructure (embedding +
  //      vectors) is degraded gracefully.
  //   4. `undefined` — handshake records action:'create' with the
  //      no-negotiator-bound message.
  //
  // Convergence invariant for the cache-backed tier: the negotiator
  // reads the SAME cache the push handler reads/writes — scope +
  // embedding + threshold are all shared. A `reuse` decision at
  // handshake time is the same outcome the paired push's cache
  // lookup would converge on; a `create` decision matches the push
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
            // round-trip. Same bundle the paired push handler reads
            // / writes — handshake match decisions converge with
            // what push would do on the same draft. Absent →
            // negotiator falls back to the synth-only path (same
            // posture as deployments without RAG infrastructure).
            ...(generationWithCache.cache ? { cache: generationWithCache.cache } : {}),
            // Marketplace-install bridge. When wired, the
            // handshake's exact-key probe sees
            // installed blueprints too — the provider lazily
            // compiles + caches each installed entry on first
            // ensureCached per scope, so the handshake hits the
            // cache directly without a synth round-trip. Same
            // provider the paired push handler reads, so handshake
            // + push converge on the same blueprint pool.
            ...(generationWithCache.installedBlueprints
              ? { installedBlueprints: generationWithCache.installedBlueprints }
              : {}),
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
      // Late-binds to the RenderChannelServer created further down.
      // `ggui_render` can only fire after `listen()` binds the HTTP
      // server, by which point `channelForHealth` is assigned.
      sendEnvelope: async (envelope) => {
        if (!channelForHealth) {
          // Safety net for programmatic hosts that construct +
          // invoke handlers without `listen()` (shouldn't happen,
          // but a silent no-op is strictly safer than a throw).
          return {};
        }
        await channelForHealth.sendToSession({
          renderId: envelope.renderId,
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
      ...(opts.blueprintProvider ? { blueprints: opts.blueprintProvider } : {}),
      // UI registry for `ggui_render_blueprint`. Absent = render tool
      // is NOT registered on this server (defaultHandlers' own opt-in
      // rule). OSS CLI wires a `LocalUiRegistry` here so manifest
      // blueprints mount through their compiled bundles.
      ...(opts.uiRegistry ? { uiRegistry: opts.uiRegistry } : {}),
      // Register `ggui_handshake` + wire the paired push consume
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
              // surfaces validation downstream — push consumes the
              // record + create-if-missing semantics on
              // `renderStore.create({id})` keep stack-growth-per-chat
              // working without a pre-existing session. Operators that
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
              //   - sessionChannel is enabled (something to subscribe
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
                if (!opts.sessionChannel) return undefined;
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
            push: {
              renderStore,
              ...(mintBootstrap ? { mintBootstrap } : {}),
              // G14 (2026-05-23) refresh seam. Same `channelBootstrap`
              // the WS upgrade path uses — sharing it means one HMAC
              // secret + one refresh-window policy across the verify
              // path and the `ggui_runtime_refresh_bootstrap` tool.
              // Absent when MCP Apps isn't enabled or no bootstrap
              // secret is wired; the tool isn't registered in that case.
              ...(channelBootstrap
                ? { bootstrapRefresh: { refresh: channelBootstrap.refresh } }
                : {}),
              // Iframe-runtime bundle URL — padded onto the
              // `ai.ggui/render.runtimeUrl` slice field by the push
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
              // `themeId` / `themeMode` per-push. Pair with the
              // mountDevtoolThemeRoutes onConfigChange callback so a
              // console "Save to ggui.json" reaches the next push
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
              // every story-path push awaits
              // `uiGenerator.generate(...)`, commits the generated
              // Render, and returns `codeReady:true`. Absent =
              // placeholder mode (no componentCode produced).
              //
              // `generationWithCache` enriches the caller-supplied
              // deps with `{cache:{embedding, vectorStore}}` composed
              // from the server's own already-resolved `embedding` +
              // `vectors` deps whenever `opts.generation.cache` is
              // undefined. The handler then runs a cache lookup on
              // every story-path push + emits `cache.hit /
              // similarity / cachedBlueprintId / llmCallsAvoided` on
              // structuredContent.
              ...(generationWithCache
                ? {
                    generation: {
                      ...generationWithCache,
                      // Thread an LLMCaller resolver into
                      // push so the registry-based three-tier matcher
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
              // RenderChannelServer created further down (`channel`
              // / `channelForHealth`) — the channel doesn't exist yet
              // at handler-factory time, so we hand the push handler
              // a thin closure that forwards to whatever channel ends
              // up assigned to `channelForHealth`. Same late-bind
              // pattern as `provisionalPreviewDeps.sendEnvelope`.
              //
              // Absent channel → no-op closure: the notify drops on
              // the floor, which is correct for hosts that didn't
              // enable `sessionChannel` (no live subscribers to
              // notify in the first place). The handler's own
              // `safelyNotifyStackPush` swallows on absent notifier
              // anyway, but providing the closure unconditionally
              // keeps the typecheck simple — no per-config branching.
              channelNotifier: {
                notifyRenderCommit: (renderId, render, matchType) => {
                  if (!channelForHealth) return;
                  channelForHealth.notifyRenderPush(renderId, render, matchType);
                },
              },
              // F4 schema compat check. Late-binds to the composed
              // `handlers` list + resolved schemaCompatMode — both
              // exist only after defaultHandlers returns, so we hand
              // the push handler a thin closure that captures them
              // by reference. Same late-bind pattern as
              // `channelNotifier` / `provisionalPreviewDeps.sendEnvelope`.
              //
              // Content-addressable code delivery. When the operator
              // wired `opts.codeStore`, forward it to the push
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
              // sessionChannel + mcpApps + allowlist must all be set
              // for the field to surface. Threading a closure (not a
              // static value) so dev-mode reconfig propagates without
              // a restart, symmetric with the handshake side.
              streamWebSocketLocalTools: () => {
                if (!opts.sessionChannel) return undefined;
                if (!mcpAppsEnabled) return undefined;
                if (!opts.streamWebSocketLocalTools) return undefined;
                return [...opts.streamWebSocketLocalTools.allowlist];
              },
              checkRenderContracts: (shape) => {
                // Shape carries the optional actionSpec / streamSpec
                // pair from either the authored DataContract (push
                // validation) or a Render (gen / cache-hit backstops).
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
      // `ggui_update` handler. Registered alongside `push` because
      // both want the RenderStore and
      // benefit from live-channel fan-out. Same late-bind pattern as
      // `channelNotifier` / `provisionalPreviewDeps.sendEnvelope`:
      // the handler factory captures a closure, the closure forwards
      // to `channelForHealth.sendPropsUpdate` once the session
      // channel is created further down.
      //
      // Absent channel → no-op closure: the props_update fan-out
      // drops on the floor, which is correct for hosts that didn't
      // enable `sessionChannel` (no live subscribers to notify).
      // The handler's own try/catch swallows notifier rejections,
      // but providing the closure unconditionally keeps the
      // typecheck simple — no per-config branching.
      ...(renderStore
        ? {
            update: {
              renderStore,
              propsUpdateNotifier: {
                sendPropsUpdate: async (renderId, props) => {
                  if (!channelForHealth) return;
                  await channelForHealth.sendPropsUpdate(renderId, props);
                },
              },
              // Bootstrap-emission deps. Mirror push so MCP Apps hosts
              // that re-post `ui/notifications/tool-result` over postMessage
              // can re-apply patched props on the live mount without a WS
              // round-trip. Composing the same minter / runtimeUrl / theme
              // resolvers keeps the two transports byte-identical at the
              // bootstrap-projection boundary.
              ...(mintBootstrap ? { mintBootstrap } : {}),
              // Function form: matches push so ggui_update emits the
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
      // `blueprints` deps come from the same source push reads, so
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
            // key probe (handshake + push) finds them. Same bundle
            // the push handler + handshake negotiator already
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
      // createRenderChannelServer runs (which is AFTER
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
  // threaded into the console blueprint-try endpoint + the push
  // handler's `checkRenderContracts` closure above (which
  // late-binds to this constant via lexical capture).
  // See CreateGguiServerOptions.schemaCompatCheck.
  const schemaCompatMode: SchemaCompatMode = opts.schemaCompatCheck ?? DEFAULT_SCHEMA_COMPAT_MODE;

  const appIdFromIdentity = opts.appIdFromIdentity ?? defaultAppIdFromIdentity;

  const als = new AsyncLocalStorage<HandlerContext>();

  const app = express();
  // Per-request context (ALS-backed) — captures forwarded host/proto
  // when the TCP peer is loopback, so deps that build absolute URLs
  // (push/update resultMeta.runtimeUrl) can adapt to the tunnel host.
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
    // `trust proxy` so req.protocol + req.host honor X-Forwarded-Proto +
    // X-Forwarded-Host. nginx-ingress + ALB both terminate TLS upstream;
    // without trust-proxy the metadata advertises `http://` instead of
    // `https://` which breaks PKCE (browsers refuse insecure flows).
    app.set("trust proxy", true);

    app.get("/.well-known/oauth-protected-resource", (req, res) =>
      handleProtectedResourceMetadata(req, res, oauthConfig, opts.universalMcpPath ?? "/mcp")
    );
    // Per-app protected-resource metadata (RFC 9728 per-resource
    // discovery). When `perAppRouting` is configured,
    // mount a second well-known endpoint under the same path prefix
    // the per-app `/mcp` handler lives on. Each `appId` gets its own
    // metadata document with `resource: ${issuer}${pathPrefix}/${appId}`
    // so claude.ai's discovery flow against `mcp.ggui.ai/apps/<appId>`
    // sees a per-app resource rather than the universal one. The
    // shared `authorization_servers: [issuer]` lets the auth server
    // (also us) issue tokens bound to either resource via RFC 8707
    // resource indicators.
    if (opts.perAppRouting !== undefined) {
      const { paramName, pathPrefix = "" } = opts.perAppRouting;
      // `path-to-regexp` v8 (express@5) removed the `:param(pattern)`
      // inline-regex route syntax — registering one throws at startup.
      // Per-app routes now mount with a PLAIN named param; `paramPattern`
      // is enforced by a single `app.param` validator (registered with
      // the per-app MCP route below) that 404s any value failing a
      // full-anchored match. Express resolves `app.param` callbacks at
      // dispatch time for any route declaring the param, regardless of
      // registration order, so this well-known route inherits the check
      // even though the validator is wired further down.
      //
      // `req.params` can't be indexed by the runtime `paramName` under
      // the v8 param-key inference, so pin the params type to the plain
      // string dictionary (`ParamsDictionary`) — the legitimate
      // single-value param shape — so the `paramName` lookup resolves
      // to `string`.
      app.get<ParamsDictionary>(
        `${pathPrefix}/:${paramName}/.well-known/oauth-protected-resource`,
        (req, res) => {
          const appId = req.params[paramName];
          if (typeof appId !== "string" || appId.length === 0) {
            res.status(404).json({ error: "not_found" });
            return;
          }
          handleProtectedResourceMetadata(req, res, oauthConfig, `${pathPrefix}/${appId}`);
        }
      );
    }
    app.get("/.well-known/oauth-authorization-server", (req, res) =>
      handleAuthorizationServerMetadata(req, res, oauthConfig)
    );
    app.post("/oauth/register", (req, res) => {
      void handleRegister(req, res, oauthConfig, oauthStorage);
    });
    app.get("/oauth/authorize", (req, res) => {
      void handleAuthorizeGet(req, res, oauthConfig, oauthStorage);
    });
    app.post("/oauth/authorize", (req, res) => {
      void handleAuthorizePost(req, res, oauthConfig, oauthStorage, auth, pairingService);
    });
    app.post("/oauth/token", (req, res) => {
      void handleToken(req, res, oauthStorage);
    });
  }

  // Live-channel session endpoint reference is declared earlier (above
  // the provisional-preview wiring) so the preview `sendEnvelope`
  // closure can late-bind to it. /ggui/health reads the same ref to
  // surface live subscriber / session counts.

  // 1s per-check timeout — a hung dependency must not block the K8s
  // liveness probe, which itself runs on a short period. A timeout is
  // treated as a failed check; the dependency is degraded either way.
  const READINESS_CHECK_TIMEOUT_MS = 1_000;
  const readinessChecks = opts.readinessChecks ?? [];

  async function runReadinessChecks(): Promise<{
    readonly allReady: boolean;
    readonly results: Record<string, boolean>;
  }> {
    if (readinessChecks.length === 0) {
      return { allReady: true, results: {} };
    }
    const results: Record<string, boolean> = {};
    let allReady = true;
    await Promise.all(
      readinessChecks.map(async ({ name, check }) => {
        try {
          const ready = await Promise.race<boolean>([
            Promise.resolve().then(() => check()),
            new Promise<boolean>((resolve) =>
              setTimeout(() => resolve(false), READINESS_CHECK_TIMEOUT_MS)
            ),
          ]);
          results[name] = ready;
          if (!ready) allReady = false;
        } catch {
          results[name] = false;
          allReady = false;
        }
      })
    );
    return { allReady, results };
  }

  /**
   * Process-alive probe — answers 200 with a tiny JSON body whenever
   * the Node event loop can run a handler, regardless of readiness.
   *
   * Why separate from `/ggui/health`: K8s livenessProbe + readinessProbe
   * have distinct semantics. Liveness asks "is the process alive?" and
   * a failure tells the kubelet to RESTART the pod. Readiness asks "is
   * the pod ready to receive traffic?" and a failure tells the service
   * to STOP ROUTING. Tying both probes to a single endpoint that gates
   * on dependency health (Redis, DDB, RAG) means a transient
   * upstream blip kills the pod entirely instead of just removing it
   * from rotation.
   *
   * Self-hoster wiring (K8s):
   *
   *   livenessProbe:  { httpGet: { path: '/ggui/live',   port } }
   *   readinessProbe: { httpGet: { path: '/ggui/health', port } }
   *
   * No body needed for the kubelet's HTTP check (status code is the
   * signal), but a tiny JSON keeps the endpoint debuggable from a
   * shell. No `readinessChecks` invoked — keeping this probe cheap
   * is the point; any heavier work belongs in `/ggui/health`.
   */
  app.get("/ggui/live", (_req, res) => {
    res.status(200).json({ status: "alive", server: info.name });
  });

  app.get("/ggui/health", (_req, res) => {
    void (async () => {
      const { allReady, results } = await runReadinessChecks();
      const body: Record<string, unknown> = {
        status: allReady ? "ok" : "degraded",
        server: info.name,
        version: info.version,
        tools: handlers.length,
      };
      if (channelForHealth) {
        body.channel = {
          path: channelForHealth.path,
          subscribers: channelForHealth.subscriberCount,
          sessions: channelForHealth.sessionCount,
        };
      }
      // Thread-transport presence + durability claim. Absent when the
      // server was booted without `threads:` (no persistent-chat routes
      // mounted). When present, `durability` is exactly what the caller
      // declared — 'ephemeral' by default so Portal does not silently
      // hide its non-durable caveat.
      if (opts.threads) {
        body.threads = {
          enabled: true,
          durability: opts.threads.durability ?? "ephemeral",
        };
      }
      if (Object.keys(results).length > 0) {
        body.checks = results;
      }
      res.status(allReady ? 200 : 503).json(body);
    })();
  });

  /**
   * Authenticated liveness probe.
   *
   * Identical auth semantics to `/mcp` (same AuthAdapter, same Bearer-
   * parsing) but with a flat 204 / 401 response shape, no body, no
   * session state. Designed for clients that need to distinguish
   * "server is up but my token is stale" from "server is unreachable".
   *
   * A Settings → Servers probe in a host client is the canonical
   * consumer: it hits `/ggui/health` first (open), then
   * `/ggui/auth-check` with the pairing token, and reports
   * `token-invalid` when the first succeeds but the second returns 401.
   *
   * No response body to keep the endpoint cheap — a 401 is the signal.
   * We deliberately skip the MCP error envelope shape used by `/mcp`
   * because this route is explicitly NOT part of the MCP wire.
   */
  app.get("/ggui/auth-check", async (req: Request, res: Response) => {
    try {
      await resolveIdentity(auth, req);
      res.status(204).end();
    } catch (err) {
      if (err instanceof UnauthenticatedError) {
        if (oauthEnabled) {
          // Auth-check is universal-only — no per-app variant route is
          // mounted, so the WWW-Authenticate always points at the
          // universal resource metadata. Symmetric with the universal
          // /mcp handler's 401 behavior.
          res.setHeader(
            "WWW-Authenticate",
            buildWwwAuthenticate(resolveIssuerUrl(req, oauthConfig.issuerUrl))
          );
        }
        res.status(401).end();
        return;
      }
      logger.error("auth_check_unexpected_error", { error: String(err) });
      res.status(500).end();
    }
  });

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

      let identity: AuthResult;
      if (handlerOpts?.anonymous) {
        // Anonymous-mode services bypass the auth chain. Synthesize an
        // identity so every downstream consumer (HandlerContext, MCP
        // server build, logger metadata) sees the same shape it would
        // for any other request — the only difference is `source` =
        // `'anonymous'`, which handlers may read if they need to gate
        // sensitive paths (e.g. writes) even on a public service.
        identity = { identity: { kind: "builder" }, source: "anonymous" };
      } else {
        try {
          identity = await resolveIdentity(auth, req);
        } catch (err) {
          if (err instanceof UnauthenticatedError) {
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
              const wwwAuthResourcePath = resolveWwwAuthResourcePath(req, opts);
              res.setHeader(
                "WWW-Authenticate",
                buildWwwAuthenticate(
                  resolveIssuerUrl(req, oauthConfig.issuerUrl),
                  wwwAuthResourcePath
                )
              );
            }
            res.status(401).json({
              jsonrpc: "2.0",
              error: { code: -32000, message: err.message },
              id: null,
            });
            return;
          }
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
        opts.perAppRouting !== undefined ? req.params[opts.perAppRouting.paramName] : undefined;
      const hasUrlAppId = typeof urlAppId === "string" && urlAppId.length > 0;

      // Per-app authorize hook — when the deployment configured
      // `perAppRouting.authorize` AND the request matched the per-app
      // path, invoke the callback. Throwing collapses to a 403 before
      // the MCP handler ever sees the request, which is the boundary
      // that prevents cross-user blueprint reads when pod tools bypass
      // AppSync owner-auth via raw DDB. Universal-endpoint requests
      // skip this entirely (no urlAppId).
      if (hasUrlAppId && opts.perAppRouting?.authorize) {
        try {
          await opts.perAppRouting.authorize(urlAppId, identity);
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
        // Per-session self-contained shell registration. Only wired
        // when MCP Apps is on AND the session store is resolved —
        // both preconditions for `ggui_render.resultMeta` stamping a
        // per-call `ui://ggui/render/<sessionId>` URI a host can
        // resolve here. Absent either, we register only the legacy
        // static `ui://ggui/render` URI (postMessage shell).
        ...(mcpAppsEnabled && renderStore
          ? {
              selfContained: {
                renderStore,
                runtimeUrl: runtimeBootstrapUrl,
                // Forward operator-picked theme into the per-session
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
                // resource handler can render a session-evicted
                // rehydrate from the registered blueprint instead of
                // the dead loading shell. `defaultAppIdFallback`
                // bounds the registry lookup to the OSS single-tenant
                // identity; multi-tenant deployments leave this
                // undefined to fail-safe back to the loading shell
                // (no way to derive the right tenant from a missing
                // session).
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
                ...(mintBootstrap
                  ? { mintWsToken: mintBootstrap }
                  : {}),
              },
            }
          : {}),
        ...(opts.allowedKinds !== undefined ? { allowedKinds: opts.allowedKinds } : {}),
        ...(resolvedInstructions !== undefined ? { instructions: resolvedInstructions } : {}),
        ...(opts.extraResources !== undefined ? { extraResources: opts.extraResources } : {}),
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
          if (opts.errorMapper) {
            try {
              mapped = opts.errorMapper(err);
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
  const universalMcpPath = opts.universalMcpPath ?? "/mcp";
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
  // well-known route above AND this MCP route — regardless of
  // registration order. A value failing the pattern 404s before any
  // handler runs.
  if (opts.perAppRouting !== undefined) {
    const { paramName, paramPattern, pathPrefix } = opts.perAppRouting;
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
  // Validation already ran above via `validateMcpServices`; here we
  // just iterate the validated list.
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

  // Iframe-runtime bundle static mount (C8 — plan §C8 Deliverable 2).
  //
  // Serves the `@ggui-ai/iframe-runtime` iframe runtime bundle from
  // `runtimePath` (default `/_ggui/iframe-runtime.js`). The thin-shell
  // HTML served from `ui://ggui/render` dynamic-script-loads this
  // URL on boot — the rendering runtime is OUT of the shell and IN
  // this separately-served file (C8 pivot, shrinking the shell from
  // ~175 LOC inline JS to ~30 LOC wrapper).
  //
  // Routing discipline: registered BEFORE the console block below
  // because console's default `path` is `/` and its `express.static`
  // + SPA-fallback would otherwise match `/_ggui/iframe-runtime.js` first
  // (Express route table is order-sensitive). Registering here keeps
  // the runtime path from leaking into the console's `index.html`
  // fallback on a missing-bundle day.
  //
  // Missing-bundle posture mirrors the console mount: 503 with a
  // `pnpm --filter @ggui-ai/iframe-runtime build` remediation hint. Silent
  // 404 would be mistaken for "renderer is broken" instead of
  // "renderer bundle wasn't built" — same debugging trap console
  // avoids.
  //
  // `runtimeEnabled === false` (operator set `runtime: false` OR
  // `mcpApps` is off): NO mount. Operator is on the hook for serving
  // the bundle from elsewhere (CDN, proxy) + publishing that URL via
  // `runtime.url`. The bootstrap still carries a `runtimeUrl` so
  // the shell knows where to look — just not our HTTP listener.
  if (runtimeEnabled) {
    if (existsSync(runtimeBundleFile)) {
      app.get(runtimePath, (_req, res) => {
        res.setHeader("Content-Type", "application/javascript; charset=utf-8");
        // Short cache — operators iterating on the renderer want
        // fresh copies after rebuild. Production hardening (etag,
        // long-term caching with hashed filenames) is a follow-on
        // concern; same posture console takes.
        res.setHeader("Cache-Control", "no-cache");
        // CORS: the bundle MUST be loadable from `<script type="module"
        // src=...>` inside a sandboxed `srcdoc` iframe (the
        // `<McpAppIframe>` mount path — see `packages/ggui-react/src/
        // McpAppIframe/dispatch.ts::deriveResourceMountSource`). Such an
        // iframe has the `null` origin and module-script fetches always
        // run in CORS mode; without a permissive header browsers reject
        // the response and the renderer never executes (Lane 1 specs
        // pinning `data-ggui-mcp-app-iframe-lifecycle="code-ready"`
        // hang to timeout). The bundle is public — it ships unmodified
        // to anyone who fetched the page, so `*` is the right shape;
        // there's no auth state on the renderer route to protect via a
        // narrower origin allowlist. This pairs with the production
        // `/ui://ggui/render` shell HTML setting `s.type='module'`
        // (`mcp-apps-outbound.ts::GGUI_SESSION_SHELL_SCRIPT_BODY`).
        res.setHeader("Access-Control-Allow-Origin", "*");
        // `dotfiles: 'allow'` — express@5's `res.sendFile` (send@1.x)
        // splits the FULL absolute path into segments and applies its
        // default `dotfiles: 'ignore'` policy, which 404s any file whose
        // path crosses a dot-prefixed directory segment (e.g. a checkout
        // under `~/.local/...` or a git worktree under `.../.git/...`).
        // `runtimeBundleFile` is a fixed, server-controlled absolute path
        // — never derived from the request — so there is no traversal
        // surface to protect; allow the bundle to serve regardless of
        // where the package install tree happens to live. express@4's
        // `sendFile` did not subject the parent directories to this check.
        res.sendFile(runtimeBundleFile, { dotfiles: "allow" });
      });
    } else {
      logger.warn("renderer_bundle_missing", {
        bundleFile: runtimeBundleFile,
        hint: "Run `pnpm --filter @ggui-ai/iframe-runtime build` to produce the bundle. Serving 503 from the mount point until it exists.",
      });
      app.get(runtimePath, (_req, res) => {
        res
          .status(503)
          .type("text/plain")
          .send("renderer bundle not built. Run:\n  pnpm --filter @ggui-ai/iframe-runtime build\n");
      });
    }
  }

  // R6 — GET /api/renders/:renderId/state?wsToken=<token>
  //
  // Auth'd snapshot read of the current render state, returning the
  // same slice envelope as the wire `_meta` (a single
  // `{"ai.ggui/render": {...}}` slice — Phase B collapsed the prior
  // session + stack-item pair). Polling clients call this on a fixed
  // interval (registry-level polling — see R6 library refactor) to
  // pick up changes when WS is blocked at the host's CSP layer.
  //
  // wsToken-gated: same credential as the live-channel WS upgrade
  // (`?wsToken=<token>` on `/ws`). Drift-free with the WS surface —
  // the iframe-runtime already has the token from the bootstrap
  // envelope; no separate refresh path needed.
  //
  // Distinct from `/r/:shortCode` (JSON branch):
  //   - `/r/...` is shortCode-gated (bearer-by-obscurity; anyone with
  //     the URL can read). R5 deletes that surface entirely.
  //   - `/api/renders/.../state` is wsToken-gated (HMAC-signed,
  //     short-TTL, scoped to renderId+appId). Survives R5.
  //
  // Distinct from R7's `/api/renders/:id/events?sinceSequence=N`
  // (planned): /state is a snapshot; /events is a cursor-replay. Both
  // are gated identically (wsToken), unified under the RenderEvent
  // ledger cursor (`render.lastSequence`).
  if (mcpAppsEnabled && renderStore && sharedTokenSecret !== undefined) {
    const renderStoreForState = renderStore;
    const stateSecret = sharedTokenSecret;
    const appMetadataStoreForState = opts.appMetadataStore;
    const stateThemeId =
      opts.theme === undefined || opts.theme.source === "default"
        ? undefined
        : opts.theme.source === "preset"
          ? opts.theme.preset
          : undefined;
    const stateThemeMode =
      opts.theme === undefined || opts.theme.source === "default" ? undefined : opts.theme.mode;
    app.get("/api/renders/:renderId/state", async (req, res) => {
      const renderId = req.params["renderId"];
      if (typeof renderId !== "string" || renderId.length === 0) {
        res.status(400).type("text/plain").send("renderId required");
        return;
      }
      const wsTokenRaw = req.query["wsToken"];
      const wsToken = typeof wsTokenRaw === "string" ? wsTokenRaw : "";
      if (wsToken.length === 0) {
        res.status(401).type("text/plain").send("wsToken query required");
        return;
      }
      const verify = verifyToken(wsToken, stateSecret, "ws");
      if (!verify.ok) {
        // 410 Gone for expired (matches the `BOOTSTRAP_EXPIRED`
        // semantics on the WS upgrade): the envelope was once valid
        // but has aged out; the iframe-runtime branches on this to
        // surface a refresh-vs-rehandshake prompt instead of treating
        // it as a hostile request.
        if (verify.reason === "expired") {
          res.status(410).type("text/plain").send("wsToken expired");
          return;
        }
        // 401 for tamper / wrong-kind / malformed / invalid-format —
        // the caller is broken or hostile; no info leak.
        res.status(401).type("text/plain").send("wsToken invalid");
        return;
      }
      // Tenancy gate: the wsToken's claimed renderId MUST match the
      // URL's renderId. A wsToken minted for render A MUST NOT read
      // render B's state.
      if (verify.claims.renderId !== renderId) {
        res.status(401).type("text/plain").send("wsToken scope mismatch");
        return;
      }
      let stored;
      try {
        stored = await renderStoreForState.get(renderId);
      } catch (err) {
        logger.warn("state_read_failed", {
          renderId,
          error: String(err),
        });
        res.status(500).type("text/plain").send("internal error");
        return;
      }
      if (!stored) {
        // 404: render evicted / never existed. Polling clients fold
        // this into "stop polling" — distinct from 410 which signals
        // "credential aged out, refresh".
        res.status(404).type("text/plain").send("render not found");
        return;
      }
      // Tenancy gate (round 2): the wsToken's appId MUST match the
      // render's appId. Closes the case where a render is created
      // under a different appId than the token was minted for.
      if (verify.claims.appId !== stored.appId) {
        res.status(401).type("text/plain").send("wsToken scope mismatch");
        return;
      }
      // Phase B: a render IS the addressable unit. Pick directly from
      // the resolved Render (no stack walk).
      const render = stored.render;
      const isMcpApps = render.type === "mcpApps";
      const isSystem = !isMcpApps && render.type === "system";
      const renderKind =
        isSystem && typeof (render as { kind?: string }).kind === "string"
          ? (render as { kind: string }).kind
          : undefined;
      // Build render-slice meta. Mirror render.resultMeta's shape so
      // the iframe-runtime parser admits identical envelopes regardless
      // of which surface served them. `lastSequence` is the load-bearing
      // R6 addition: polling clients use it to initialize the R7 /events
      // cursor (`?sinceSequence=N`) aligned with the WS stream.
      const view = !isMcpApps ? deriveRenderMeta(render) : undefined;
      let statePublicEnv: Readonly<Record<string, string>> | undefined;
      if (appMetadataStoreForState && !isMcpApps) {
        try {
          const appRecord = await appMetadataStoreForState.get(stored.appId);
          statePublicEnv = derivePublicEnvProjection(render, appRecord?.publicEnv);
        } catch {
          // Silent — wrappers calling getPublicEnv throw clearly.
        }
      }
      // Live-mode credential trio. Always minted fresh on /state reads
      // so the iframe-runtime gets a long-TTL token + the host learns
      // `wsUrl` (the CSP-permitted WebSocket origin). Without this,
      // any caller of /state — including the restore-bootstrap path in
      // every host (claude.ai, ChatGPT, our sample-agent) — receives a
      // render slice missing `wsUrl`. CSP `connect-src` then omits the
      // `ws://` scheme, the browser blocks the upgrade, and props_update
      // never reaches the iframe. The render-commit handler already
      // stamps this trio on its resultMeta; mirroring here closes the
      // drift.
      const liveTrio = mintBootstrap ? mintBootstrap(stored.id, stored.appId) : undefined;
      // Polling URL — the iframe-runtime's R6 polling-fallback path
      // composes its fetch URL from `render.pollingUrl`. The /state
      // endpoint IS that URL, so we stamp it here; without it the
      // iframe-runtime can't fall back when the WS upgrade fails.
      const requestHostForPolling = req.get("host") ?? "";
      const pollingBase = opts.publicBaseUrl
        ? opts.publicBaseUrl.replace(/\/$/, "")
        : `${req.protocol}://${requestHostForPolling}`;
      const pollingUrl = `${pollingBase}/api/renders/${encodeURIComponent(stored.id)}/state`;
      // Static-component delivery via codeUrl (the same content-addressable
      // channel /r/ uses). Polling clients are render-capable and need
      // the URL to mount/refresh the static-component variant.
      let renderCodeUrl: string | undefined;
      let renderCodeHash: string | undefined;
      let renderContractHash: string | undefined;
      let renderValidatorsUrl: string | undefined;
      if (!isSystem && !isMcpApps && opts.codeStore) {
        const code = (render as { componentCode?: string }).componentCode;
        if (typeof code === "string" && code.length > 0) {
          try {
            const hash = opts.codeStore.hashOf(code);
            await opts.codeStore.put(hash, code);
            renderCodeHash = hash;
            const requestHost = req.get("host") ?? "";
            const base = opts.publicBaseUrl
              ? opts.publicBaseUrl.replace(/\/$/, "")
              : `${req.protocol}://${requestHost}`;
            renderCodeUrl = `${base}/code/${hash}.js`;
          } catch {
            // Silent — caller falls back to live-mode delivery.
          }
          try {
            const bundle = await deriveContractBundle(render);
            if (bundle) {
              await opts.codeStore.put(bundle.contractHash, bundle.bundleSource);
              renderContractHash = bundle.contractHash;
              const requestHost = req.get("host") ?? "";
              const base = opts.publicBaseUrl
                ? opts.publicBaseUrl.replace(/\/$/, "")
                : `${req.protocol}://${requestHost}`;
              renderValidatorsUrl = `${base}/contract/${bundle.contractHash}.js`;
            }
          } catch {
            // Silent — server-side gate remains authoritative.
          }
        }
      }
      // Phase B: single flat ai.ggui/render slice — render + visible-
      // bits surface fields merged into one shape.
      const renderMeta: McpAppAiGguiRenderMeta = {
        renderId: stored.id,
        appId: stored.appId,
        runtimeUrl: resolveRuntimeUrlForResultMeta(),
        ...(liveTrio !== undefined
          ? {
              wsUrl: liveTrio.wsUrl,
              wsToken: liveTrio.token,
              expiresAt: liveTrio.expiresAt,
            }
          : {}),
        pollingUrl,
        ...(stateThemeId !== undefined ? { themeId: stateThemeId } : {}),
        ...(stateThemeMode !== undefined ? { themeMode: stateThemeMode } : {}),
        ...(view?.gadgets !== undefined && view.gadgets.length > 0
          ? { gadgets: view.gadgets }
          : {}),
        ...(statePublicEnv !== undefined && Object.keys(statePublicEnv).length > 0
          ? { publicEnv: statePublicEnv }
          : {}),
        ...(view?.permissionsPolicy !== undefined && view.permissionsPolicy.length > 0
          ? { permissionsPolicy: view.permissionsPolicy }
          : {}),
        // R6 — load-bearing ledger cursor. Always stamped on /state
        // reads so polling clients can position the R7 /events cursor.
        lastSequence: stored.eventSequence,
        // Visible-bits surface merged onto the single render slice.
        ...(renderKind !== undefined ? { kind: renderKind } : {}),
        ...(renderCodeUrl !== undefined
          ? {
              codeUrl: renderCodeUrl,
              ...(renderCodeHash !== undefined ? { codeHash: renderCodeHash } : {}),
            }
          : {}),
        ...(view?.propsJson !== undefined ? { propsJson: view.propsJson } : {}),
        ...(view?.actionNextSteps !== undefined ? { actionNextSteps: view.actionNextSteps } : {}),
        ...(view?.contextSlots !== undefined ? { contextSlots: view.contextSlots } : {}),
        ...(renderContractHash !== undefined && renderValidatorsUrl !== undefined
          ? {
              contractHash: renderContractHash,
              validatorsUrl: renderValidatorsUrl,
            }
          : {}),
      };
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.status(200).json({
        [MCP_APP_AI_GGUI_RENDER_META_KEY]: renderMeta,
      });
    });
  }

  // R7 — GET /api/renders/:renderId/events?wsToken=&sinceSequence=N&limit=M
  //
  // Cursor-replay read from the RenderEvent ledger (`bc524f2f0` in
  // cloud; in-memory + sqlite stores OSS). Returns events with
  // `seq > sinceSequence`, up to `limit` (default 100, max 500).
  //
  // Unification: WS subscribe's `sinceSequence` cursor and this HTTP
  // endpoint read from the SAME ledger via the same `listEventsSince`
  // RenderStore method. Different transports, same cursor model —
  // that's R7's payoff.
  //
  // Auth: wsToken-gated, identical posture to /state.
  //
  // Responses:
  //   - 200 — `{events, lastSequence, hasMore}` (matches
  //     `EventsResponse` from @ggui-ai/protocol/integrations/mcp-apps).
  //   - 401 — wsToken missing / invalid / wrong-scope.
  //   - 404 — sessionId does not resolve.
  //   - 410 — `{reason: 'REPLAY_HORIZON_PASSED', currentSequence}` when
  //     `sinceSequence` is below the server's replay horizon OR strictly
  //     greater than `lastSequence` (cursor is from a stale deployment
  //     or the session was reset). Clients re-mount from /state.
  if (mcpAppsEnabled && renderStore && sharedTokenSecret !== undefined) {
    const renderStoreForEvents = renderStore;
    const eventsSecret = sharedTokenSecret;
    app.get("/api/renders/:renderId/events", async (req, res) => {
      const renderId = req.params["renderId"];
      if (typeof renderId !== "string" || renderId.length === 0) {
        res.status(400).type("text/plain").send("renderId required");
        return;
      }
      const wsTokenRaw = req.query["wsToken"];
      const wsToken = typeof wsTokenRaw === "string" ? wsTokenRaw : "";
      if (wsToken.length === 0) {
        res.status(401).type("text/plain").send("wsToken query required");
        return;
      }
      const verify = verifyToken(wsToken, eventsSecret, "ws");
      if (!verify.ok) {
        if (verify.reason === "expired") {
          res.status(410).type("text/plain").send("wsToken expired");
          return;
        }
        res.status(401).type("text/plain").send("wsToken invalid");
        return;
      }
      if (verify.claims.renderId !== renderId) {
        res.status(401).type("text/plain").send("wsToken scope mismatch");
        return;
      }
      // Parse + validate sinceSequence (required, non-negative integer)
      // and limit (optional, 1..500, default 100).
      //
      // sinceSequence is REQUIRED — explicit cursor reads only. A missing
      // query is a caller bug (no sensible default; `0` means "replay
      // everything" which we don't want to fire unintentionally).
      const sinceSequenceRaw = req.query["sinceSequence"];
      if (typeof sinceSequenceRaw !== "string" || sinceSequenceRaw.length === 0) {
        res
          .status(400)
          .type("text/plain")
          .send("sinceSequence query required (non-negative integer)");
        return;
      }
      const sinceSequence = Number(sinceSequenceRaw);
      if (!Number.isInteger(sinceSequence) || sinceSequence < 0) {
        res.status(400).type("text/plain").send("sinceSequence must be a non-negative integer");
        return;
      }
      const limitRaw = req.query["limit"];
      let limit = 100;
      if (typeof limitRaw === "string" && limitRaw.length > 0) {
        const parsed = Number(limitRaw);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
          res.status(400).type("text/plain").send("limit must be an integer in [1, 500]");
          return;
        }
        limit = parsed;
      }
      let result;
      try {
        result = await renderStoreForEvents.listEventsSince(renderId, sinceSequence, limit);
      } catch (err) {
        logger.warn("events_read_failed", {
          renderId,
          error: String(err),
        });
        res.status(500).type("text/plain").send("internal error");
        return;
      }
      if (result === null) {
        // 404 — render not found. Distinct from 410 (cursor stale on
        // a live render) so polling clients can branch.
        res.status(404).type("text/plain").send("render not found");
        return;
      }
      // Tenancy gate (round 2): the wsToken's appId MUST match the
      // render's appId. We need the render record to check — fetch
      // it. listEventsSince validated the render exists.
      const stored = await renderStoreForEvents.get(renderId);
      if (!stored) {
        res.status(404).type("text/plain").send("render not found");
        return;
      }
      if (verify.claims.appId !== stored.appId) {
        res.status(401).type("text/plain").send("wsToken scope mismatch");
        return;
      }
      // Replay-horizon gate. Two cases collapse to REPLAY_HORIZON_PASSED:
      //   (a) sinceSequence < horizonSeq — events evicted (cloud TTL,
      //       in-mem never).
      //   (b) sinceSequence > lastSequence — cursor from a different
      //       deployment / reset session; the server has no events
      //       beyond what it knows, and we can't safely advance.
      if (sinceSequence > result.lastSequence) {
        res.status(410).type("application/json").json({
          reason: "REPLAY_HORIZON_PASSED",
          currentSequence: result.lastSequence,
        });
        return;
      }
      if (sinceSequence < result.horizonSeq) {
        res.status(410).type("application/json").json({
          reason: "REPLAY_HORIZON_PASSED",
          currentSequence: result.lastSequence,
        });
        return;
      }
      // RenderEvent is now the unified wire-shape ledger primitive
      // (Wave 7 of flatten-render-identity, 2026-05-28). The store
      // returns events in protocol-canonical shape (seq + type +
      // timestamp[ISO] + data); no projection needed.
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.status(200).json({
        events: result.events,
        lastSequence: result.lastSequence,
        hasMore: result.hasMore,
      });
    });
  }

  // GET /code/:hash.js — content-addressable componentCode delivery.
  // GET /contract/:hash.js — content-addressable contract-validator-bundle
  //   delivery (#109).
  //
  // Both routes serve from the same {@link CodeStore} keyed by
  // `sha256(bytes)`. The same store is safe to share — content-addressable
  // hashes can't collide across kinds unless the bytes are identical
  // (in which case the cached value is equally valid for either path).
  // Two separate URLs exist for debuggability + protocol clarity: a
  // request to `/code/<hash>.js` is unambiguously a component fetch;
  // `/contract/<hash>.js` is unambiguously a validator-bundle fetch.
  //
  // Cache posture: `Cache-Control: public, max-age=31536000, immutable` —
  // hash is content-derived, the bytes can NEVER change for a given URL,
  // so browsers + CDNs cache forever (immutable means "don't even
  // revalidate"). A second push with the same componentCode / contract
  // hits browser cache for free.
  //
  // CORS: same `*` posture as `/r/:shortCode` (JSON branch) — bytes are
  // public-by-shortCode anyway (the agent already shared the URL with
  // the host), and the bytes carry no credentials.
  //
  // Validation: hash MUST match `[a-f0-9]{64}` — strict charset gate
  // closes path-traversal (`..`, `/`) and other shenanigans before the
  // store sees the parameter.
  if (opts.codeStore) {
    const codeStoreForRoute = opts.codeStore;
    const mountContentAddressableRoute = (mountPath: string, label: "code" | "contract"): void => {
      app.get(mountPath, async (req: Request, res: Response) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        const hash = req.params["hash"];
        if (typeof hash !== "string" || !CODE_HASH_REGEX.test(hash)) {
          res.setHeader("Cache-Control", "no-store");
          res.status(400).json({
            error: {
              code: "invalid_request",
              message: "hash path parameter must be 64-char lowercase hex",
            },
          });
          return;
        }
        try {
          const code = await codeStoreForRoute.get(hash);
          if (code === null) {
            res.setHeader("Cache-Control", "no-store");
            res.status(404).json({
              error: {
                code: "not_found",
                message: `unknown ${label} hash`,
              },
            });
            return;
          }
          res.setHeader("Content-Type", "application/javascript; charset=utf-8");
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          res.status(200).send(code);
        } catch (err) {
          logger.warn(`${label}_route_failed`, { hash, error: String(err) });
          res.setHeader("Cache-Control", "no-store");
          res.status(500).json({
            error: {
              code: "internal",
              message: `${label} fetch failed`,
            },
          });
        }
      });
    };
    mountContentAddressableRoute("/code/:hash.js", "code");
    mountContentAddressableRoute("/contract/:hash.js", "contract");
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
  //   - `POST /ggui/console/render-cookie` — resolve shortCode
  //     → render and mint the same-origin HTTP-only cookie the
  //     viewer authenticates to the live channel with. Enabled only when
  //     `console.sessionCookie` is on AND `shortCodeIndex` +
  //     `sessionChannel` are wired.
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
  // Cookie-auth binding into the session-channel. Populated inside
  // the console block below when `sessionCookie` is enabled, then
  // threaded into createRenderChannelServer. Declared `let` here so
  // the declaration-order dance stays legible.
  let consoleCookieAuth: import("./render-channel.js").RenderChannelCookieAuth | undefined;
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
  // /sessions, /config) gate identically without redefining the logic.
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
    // don't need to wire sessionChannel + shortCodeIndex. The feature
    // requires `sessionChannel: true` (the cookie only authenticates
    // the live channel) and `shortCodeIndex` (the cookie endpoint resolves
    // shortCode → session through it). Fail fast at construction if
    // either is missing when the operator asked for the flow.
    const sessionCookieEnabled =
      consoleConfig.sessionCookie === true ||
      (typeof consoleConfig.sessionCookie === "object" && consoleConfig.sessionCookie !== null);
    if (sessionCookieEnabled) {
      if (!opts.sessionChannel) {
        throw new Error(
          "createGguiServer: `console.sessionCookie` requires `sessionChannel: true`. The cookie authenticates the live-channel WebSocket upgrade; without a channel it has no consumer."
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

    // GET /ggui/console/blueprint/:id — same-origin HTTP mirror of
    // the `ggui_render_blueprint` MCP tool. Resolves a manifest-declared
    // blueprint id to its compiled bundle + metadata via the already-
    // wired `opts.uiRegistry`; lets the SPA's `/preview/<id>` route mount the
    // blueprint with a single fetch instead of negotiating a full MCP
    // round-trip from the browser.
    //
    // Scope: registered only when a `UiRegistry` is present (same gate
    // as the MCP render handler — no registry = no render path, no
    // endpoint). No bearer auth: console routes are same-origin
    // operator-facing; the operator already has OS access to the TSX
    // sources this endpoint serves back.
    //
    // Failure shape: { error, message } with a matching HTTP code.
    //   - 404 for unknown id OR known-id-no-bundle (source-only /
    //     compile-failed). The operator's remediation is the same in
    //     both cases (fix the manifest / fix the entry / fix the
    //     compile); splitting codes would add noise without signal.
    //   - 400 for malformed id parameters (empty, oversized).
    //
    // Shape symmetry: matches `GguiRenderBlueprintOutput` exactly, so
    // the browser-side fetch can share a type import with MCP-tool
    // callers without a translation layer.
    if (opts.uiRegistry) {
      const uiRegistryForEndpoint = opts.uiRegistry;
      // POST /ggui/console/blueprint/:id/try — create a session,
      // compile the blueprint's componentCode, push a StackItem with
      // its full contract (actionSpec/streamSpec/propsSpec from the
      // manifest), mint a shortCode, and return `{sessionId, shortCode,
      // url}`. The returned `/s/<shortCode>` lands on the console's
      // session viewer + subscribes to the session over `/ws`, so the
      // just-appended StackItem arrives via `ack.stack` on subscribe.
      //
      // Gates (all three required):
      //   - `opts.uiRegistry`     — blueprint resolution
      //   - `renderStore`        — session persistence
      //   - `opts.shortCodeIndex` — shortCode → session binding
      //
      // Partial gate (uiRegistry alone) → 503 with a remediation hint.
      // Same-origin console surface — no bearer auth; viewer inherits
      // the operator's machine trust model.
      if (renderStore && opts.shortCodeIndex) {
        const renderStoreForTry = renderStore;
        const shortCodeIndexForTry = opts.shortCodeIndex;
        app.post("/ggui/console/blueprint/:id/try", async (req, res) => {
          applyDevtoolSecurityHeaders(res);
          const blueprintId = req.params["id"];
          if (
            typeof blueprintId !== "string" ||
            blueprintId.length === 0 ||
            blueprintId.length > 256
          ) {
            res.status(400).json({
              error: "invalid_request",
              message: "`id` path parameter must be a non-empty string (≤256 chars)",
            });
            return;
          }
          try {
            const entry = await uiRegistryForEndpoint.get(blueprintId);
            if (!entry) {
              res.status(404).json({
                error: "not_found",
                message: `No blueprint registered with id "${blueprintId}". Check ggui.json#blueprints.include globs + ggui.ui.json#id values.`,
              });
              return;
            }
            const bundle = await uiRegistryForEndpoint.getBundle(blueprintId);
            if (!bundle) {
              res.status(404).json({
                error: "bundle_not_available",
                message: `Blueprint "${blueprintId}" (${entry.manifest.name}) has no bundle available. Either the TSX entry is missing or compile-on-demand failed.`,
              });
              return;
            }
            // Materialize streamed bundles to a string — StackItem
            // stores componentCode inline. Same rule the sibling GET
            // endpoint applies.
            let code: string;
            if (typeof bundle.code === "string") {
              code = bundle.code;
            } else {
              const reader = bundle.code.getReader();
              const decoder = new TextDecoder();
              let out = "";
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (typeof value === "string") out += value;
                else if (value instanceof Uint8Array)
                  out += decoder.decode(value, { stream: true });
              }
              out += decoder.decode();
              code = out;
            }

            // Same default appId the CLI's pairing-authenticated /mcp
            // ingress resolves for single-tenant OSS. Keeps the
            // render + its wiredActionRouter invocation scoped to
            // the same tenant.
            const appId = DEFAULT_BUILDER_APP_ID;
            // Phase B: a render IS the addressable unit; the prior
            // (sessionId, stackItemId) pair collapses to a single
            // renderId. The blueprint id makes a natural slug; a
            // same-blueprint retry replaces the row.
            const renderId = `try-${blueprintId}-${randomUUID()}`;
            const createdAt = Date.now();

            const contract = entry.manifest.contract ?? {};
            const render: Render = {
              id: renderId,
              appId,
              type: "component",
              componentCode: code,
              contentType: bundle.contentType,
              eventSequence: 0,
              createdAt,
              lastActivityAt: createdAt,
              expiresAt: createdAt + 24 * 60 * 60 * 1000,
              description: `Blueprint try-live: ${entry.manifest.name}`,
              // Data contract fields from the manifest. Each is
              // conditionally spread — absent on the manifest →
              // absent on the Render (keeps shape honest + avoids
              // an empty-shape contract tripping structural
              // validators downstream).
              ...(contract.propsSpec ? { propsSpec: contract.propsSpec } : {}),
              ...(contract.actionSpec ? { actionSpec: contract.actionSpec } : {}),
              ...(contract.streamSpec ? { streamSpec: contract.streamSpec } : {}),
            };

            // Schema compatibility check. Fires BEFORE the render
            // commits — if the blueprint's pre-declared actionSpec /
            // streamSpec references a tool whose schemas don't align,
            // the operator gets a named `SCHEMA_MISMATCH_ERROR`
            // response instead of a silent runtime `TOOL_THREW`. Mode
            // sourced from `createGguiServer({schemaCompatCheck})`;
            // defaults to `'reject'`. See `./schema-compat.ts`.
            try {
              const report = checkRenderSchemaCompat(
                render,
                handlers,
                schemaCompatMode,
                `console blueprint-try:${blueprintId}`
              );
              if (!report.compatible) {
                // Non-throwing path (mode === 'warn'): log with full
                // detail so the operator has an observable surface.
                logger.warn("schema_compat_warn", {
                  site: "console_blueprint_try",
                  blueprintId,
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
            } catch (err) {
              if (err instanceof SchemaCompatError) {
                logger.warn("console_blueprint_try_schema_compat_rejected", {
                  blueprintId,
                  findingCount: err.report.findings.length,
                });
                res.status(422).json({
                  error: "SCHEMA_MISMATCH_ERROR",
                  message: err.message,
                  findings: err.report.findings.map((f) => ({
                    kind: f.kind,
                    specName: f.specName,
                    toolName: f.toolName,
                    reason: f.reason,
                    violationCount: f.violations.length,
                  })),
                });
                return;
              }
              throw err;
            }

            try {
              await renderStoreForTry.commit({ render, appId });
            } catch (err) {
              logger.warn("console_blueprint_try_commit_failed", {
                blueprintId,
                renderId,
                error: String(err),
              });
              res.status(500).json({
                error: "commit_failed",
                message: err instanceof Error ? err.message : String(err),
              });
              return;
            }

            // Prime every declared streamSpec channel that carries a
            // refresh tool. Without this, a try-live viewer that mounts
            // a blueprint with e.g. `streamSpec.tasks.tool = 'tasks_list'`
            // hits its empty-state branch because `useStream('tasks').
            // latest` stays `undefined` — no one fires the refresh
            // tool. Await so the initial envelope is buffered via
            // `sessionChannel`'s replay state before the shortCode
            // returns; the viewer subscribes moments later and its
            // `ack.initialReplay` carries the seeded frame.
            //
            // Best-effort: refresh failures on any channel log + skip
            // that channel but don't fail the try-live call — the
            // blueprint's empty state remains a valid degraded UX.
            if (channelForHealth) {
              try {
                await channelForHealth.primeStreams(renderId, render);
              } catch (err) {
                logger.warn("console_blueprint_try_prime_failed", {
                  blueprintId,
                  renderId,
                  error: String(err),
                });
              }
            }

            // Mint the shortCode last — if earlier steps failed the
            // client never sees a dangling mapping. Best-effort bind
            // to match push.ts's posture (a put failure shouldn't
            // fail the whole try-live — a 500 here would leave the
            // render behind with no way to resolve from
            // `/s/<shortCode>`, but the operator can still hit the
            // render via `/ggui/console/renders`).
            const shortCode = generateTryLiveShortCode();
            try {
              await shortCodeIndexForTry.put(shortCode, {
                renderId,
                appId,
              });
            } catch (err) {
              logger.warn("console_blueprint_try_shortcode_failed", {
                blueprintId,
                renderId,
                shortCode,
                error: String(err),
              });
              // Don't fail the response — the client can reopen via
              // the renders list. Surface the issue in the payload
              // so the SPA can show a degraded banner.
              res.status(200).json({
                renderId,
                shortCode: null,
                url: null,
                warning:
                  "shortCode minted but not persisted; viewer link unavailable. Open via /ggui/console/renders.",
              });
              return;
            }

            res.json({
              renderId,
              shortCode,
              url: `/s/${shortCode}`,
            });
          } catch (err) {
            logger.warn("console_blueprint_try_failed", {
              blueprintId,
              error: String(err),
            });
            res.status(500).json({
              error: "try_failed",
              message: err instanceof Error ? err.message : String(err),
            });
          }
        });
      } else {
        // Partial wiring — /try would attempt a session create that
        // has nowhere to land. Surface with 503 + specific message
        // so the operator knows which seam to add (console cookie +
        // shortCodeIndex live on `console.sessionCookie: true`).
        app.post("/ggui/console/blueprint/:id/try", (_req, res) => {
          applyDevtoolSecurityHeaders(res);
          res.status(503).json({
            error: "try_not_wired",
            message:
              "POST /ggui/console/blueprint/:id/try requires `sessionChannel: true` + `shortCodeIndex` on createGguiServer. The CLI enables both by default via `console.sessionCookie: true`.",
          });
        });
      }
      app.get("/ggui/console/blueprint/:id", async (req, res) => {
        applyDevtoolSecurityHeaders(res);
        const blueprintId = req.params["id"];
        if (
          typeof blueprintId !== "string" ||
          blueprintId.length === 0 ||
          blueprintId.length > 256
        ) {
          res.status(400).json({
            error: "invalid_request",
            message: "`id` path parameter must be a non-empty string (≤256 chars)",
          });
          return;
        }
        try {
          const entry = await uiRegistryForEndpoint.get(blueprintId);
          if (!entry) {
            res.status(404).json({
              error: "not_found",
              message: `No blueprint registered with id "${blueprintId}". Check ggui.json#blueprints.include globs + ggui.ui.json#id values.`,
            });
            return;
          }
          const bundle = await uiRegistryForEndpoint.getBundle(blueprintId);
          if (!bundle) {
            res.status(404).json({
              error: "bundle_not_available",
              message: `Blueprint "${blueprintId}" (${entry.manifest.name}) has no bundle available. Either the TSX entry is missing or compile-on-demand failed — check the manifest directory.`,
            });
            return;
          }
          // Same string-materialization rule as the MCP render handler:
          // collapse stream bundles to a plain string so the browser
          // fetch can JSON-parse the response in one shot.
          let code: string;
          if (typeof bundle.code === "string") {
            code = bundle.code;
          } else {
            const reader = bundle.code.getReader();
            const decoder = new TextDecoder();
            let out = "";
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (typeof value === "string") out += value;
              else if (value instanceof Uint8Array) out += decoder.decode(value, { stream: true });
            }
            out += decoder.decode();
            code = out;
          }
          res.json({
            blueprintId,
            blueprintName: entry.manifest.name,
            code,
            contentType: bundle.contentType,
          });
        } catch (err) {
          logger.warn("console_blueprint_resolve_failed", {
            blueprintId,
            error: String(err),
          });
          res.status(500).json({
            error: "resolve_failed",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    }

    // GET /ggui/console/registry — JSON catalog of the blueprints +
    // primitives this server was booted with. Consumed by the SPA's
    // `/registry` route to paint an operator-facing browser over what
    // `ggui.json#blueprints.include` discovered + what primitive
    // catalogs the server was composed with.
    //
    // Scope: read-only surface. No registration / upload / mutation —
    // authoring happens on disk (`ggui.ui.json` + TSX) and the server
    // re-reads on boot. Zero-config is an honest empty shape:
    // `{blueprints: [], primitives: []}` when neither is wired.
    //
    // Sources:
    //   - `blueprints[]`  ← `opts.uiRegistry?.list()` (full manifest
    //     entries; surfaces `name` + `description?` + `category?`).
    //     Same registry the `/ggui/console/blueprint/:id` endpoint
    //     resolves against, so the /registry click-through to
    //     /preview/<id> is guaranteed to hit the same dataset.
    //   - `primitives[]` ← `opts.primitiveCatalogs` (`DiscoveredPrimitiveCatalog`
    //     shape from `@ggui-ai/project-config`). Each entry flattens
    //     one primitive per row, tagging it with its catalog's
    //     `source` ('package' | 'local') + `import` specifier.
    //
    // No bearer auth (same rule as the other console endpoints —
    // same-origin operator-facing). Output is stable-sorted by id /
    // name so the SPA's filter-as-you-type UI doesn't need a second
    // sort pass.
    app.get("/ggui/console/registry", async (_req, res) => {
      applyDevtoolSecurityHeaders(res);
      interface BlueprintSummary {
        readonly id: string;
        readonly name: string;
        readonly description?: string;
        readonly category?: string;
      }
      interface PrimitiveSummary {
        readonly name: string;
        readonly source: "package" | "local";
        readonly catalog: string;
      }

      const blueprints: BlueprintSummary[] = [];
      if (opts.uiRegistry) {
        try {
          const entries = await opts.uiRegistry.list();
          for (const entry of entries) {
            const summary: BlueprintSummary = {
              id: entry.id,
              name: entry.manifest.name,
              ...(entry.manifest.description !== undefined
                ? { description: entry.manifest.description }
                : {}),
              ...(entry.manifest.category !== undefined
                ? { category: entry.manifest.category }
                : {}),
            };
            blueprints.push(summary);
          }
          blueprints.sort((a, b) => a.id.localeCompare(b.id));
        } catch (err) {
          logger.warn("console_registry_blueprint_list_failed", {
            error: String(err),
          });
          res.status(500).json({
            error: "registry_unavailable",
            message:
              err instanceof Error
                ? `Blueprint registry failed to list — ${err.message}`
                : `Blueprint registry failed to list — ${String(err)}`,
          });
          return;
        }
      }

      const primitives: PrimitiveSummary[] = [];
      for (const catalog of opts.primitiveCatalogs ?? []) {
        for (const primitive of catalog.manifest.primitives) {
          primitives.push({
            name: primitive.name,
            source: catalog.source,
            catalog: catalog.import,
          });
        }
      }
      // Stable sort: primary by catalog import (packages first, then
      // locals under their own groups), secondary by primitive name.
      // Operator reads "everything from @ggui-ai/design" as one block
      // rather than having @ggui-ai/design's Button interleaved with
      // a local-catalog Button at the letter-b slot.
      primitives.sort((a, b) => {
        const byCatalog = a.catalog.localeCompare(b.catalog);
        if (byCatalog !== 0) return byCatalog;
        return a.name.localeCompare(b.name);
      });

      res.json({ blueprints, primitives });
    });

    // ─────────────────────────────────────────────────────────────────
    // Blueprints page — cache + probe
    //
    // Four endpoints operator-facing from `/blueprints` (the merged
    // page that also hosts declared blueprints + primitives). All
    // scoped to `DEFAULT_BUILDER_APP_ID` because the OSS server is
    // single-tenant by construction — same scope the push handler
    // writes to, so list/invalidate/clear see what the real cache
    // writes.
    //
    // Enumeration gate: `listGenerationCache` + `clearGenerationCache`
    // require an EnumerableVectorStore. Every OSS default satisfies
    // it (`InMemoryVectorStore`, `SqliteVectorStore`); the AWS-adapter
    // bridge (`embeddingStorageToVectorStore`) doesn't. Hosted paths
    // that wire a non-enumerable backend get a honest `501` with a
    // reason code rather than a silent empty list or a runtime
    // throw.
    //
    // Scope resolution: no auth-derived `appId` — the console is
    // same-origin operator-facing and every other console endpoint
    // uses the anchored `DEFAULT_BUILDER_APP_ID` scope too
    // (matches push.ts:2624 and the chat playground flow).
    // ─────────────────────────────────────────────────────────────────

    // GET /ggui/console/blueprints/cached — list cached generation
    // entries. Rejects with 501 when the vector store doesn't
    // support enumeration (AWS-adapter path). Empty scope returns
    // `{entries: [], total: 0}` — not an error.
    app.get("/ggui/console/blueprints/cached", async (_req, res) => {
      applyDevtoolSecurityHeaders(res);
      if (!isEnumerableVectorStore(vectors)) {
        res.status(501).json({
          error: "enumeration_unsupported",
          message:
            "The configured vector store does not support enumeration. " +
            "Wire an EnumerableVectorStore (default InMemoryVectorStore " +
            "or SqliteVectorStore) to surface the cache in the console.",
        });
        return;
      }
      try {
        const entries = await listGenerationCache({ vectorStore: vectors }, DEFAULT_BUILDER_APP_ID);
        const payload: readonly GenerationCacheEntry[] = entries;
        res.json({ entries: payload, total: payload.length });
      } catch (err) {
        logger.warn("console_blueprints_cached_list_failed", {
          error: String(err),
        });
        res.status(500).json({
          error: "cache_unavailable",
          message:
            err instanceof Error
              ? `Generation cache failed to list — ${err.message}`
              : `Generation cache failed to list — ${String(err)}`,
        });
      }
    });

    // DELETE /ggui/console/blueprints/cached/:id — invalidate one
    // cached entry. Idempotent — 204 whether the id was present or
    // not (same contract as VectorStore.deleteVector). No enumerable
    // gate — delete works on every vector-store implementation.
    app.delete("/ggui/console/blueprints/cached/:id", async (req, res) => {
      applyDevtoolSecurityHeaders(res);
      const id = req.params.id;
      if (!id || id.length === 0) {
        res.status(400).json({
          error: "missing_id",
          message: "Cache entry id required in path segment.",
        });
        return;
      }
      try {
        await invalidateGenerationCache({ vectorStore: vectors }, DEFAULT_BUILDER_APP_ID, id);
        res.status(204).end();
      } catch (err) {
        logger.warn("console_blueprints_cached_invalidate_failed", {
          error: String(err),
          id,
        });
        res.status(500).json({
          error: "cache_invalidate_failed",
          message:
            err instanceof Error
              ? `Invalidate failed — ${err.message}`
              : `Invalidate failed — ${String(err)}`,
        });
      }
    });

    // POST /ggui/console/blueprints/cached/clear — bulk-delete every
    // cached entry in the scope. Returns the count. Requires
    // EnumerableVectorStore (we enumerate to find keys to delete).
    app.post("/ggui/console/blueprints/cached/clear", async (_req, res) => {
      applyDevtoolSecurityHeaders(res);
      if (!isEnumerableVectorStore(vectors)) {
        res.status(501).json({
          error: "enumeration_unsupported",
          message:
            "Bulk-clear requires a vector store that supports " +
            "enumeration. Invalidate entries individually via " +
            "DELETE /ggui/console/blueprints/cached/:id, or wire an " +
            "EnumerableVectorStore to unlock bulk-clear.",
        });
        return;
      }
      try {
        const result = await clearGenerationCache({ vectorStore: vectors }, DEFAULT_BUILDER_APP_ID);
        res.json(result);
      } catch (err) {
        logger.warn("console_blueprints_cached_clear_failed", {
          error: String(err),
        });
        res.status(500).json({
          error: "cache_clear_failed",
          message:
            err instanceof Error
              ? `Clear failed — ${err.message}`
              : `Clear failed — ${String(err)}`,
        });
      }
    });

    // GET /ggui/console/blueprints/registry — list every blueprint
    // registered in the three-tier matcher's storage.
    // Sibling of `/blueprints/cached` and intentionally distinct from
    // the declared-blueprint catalog at `/ggui/console/registry`:
    //   - `/registry` (existing) — operator-declared static catalog
    //     (uiRegistry sources + primitiveCatalogs). Boot-time content.
    //   - `/blueprints/cached` (legacy) — intent-keyed generation
    //     cache. Retired.
    //   - `/blueprints/registry` (this) — contract-keyed runtime
    //     registry the matcher actually consults. Per-row tier
    //     diagnostics: kind, contractKey, hitCount, lastHitAt.
    //
    // Optional `?kind=template|organism|molecule|atom` filter narrows
    // by atomic-design level — kindless query returns everything.
    app.get("/ggui/console/blueprints/registry", async (req, res) => {
      applyDevtoolSecurityHeaders(res);
      if (!isEnumerableVectorStore(vectors)) {
        res.status(501).json({
          error: "enumeration_unsupported",
          message:
            "The configured vector store does not support enumeration. " +
            "Wire an EnumerableVectorStore (default InMemoryVectorStore " +
            "or SqliteVectorStore) to surface the registry in the console.",
        });
        return;
      }
      const rawKind = typeof req.query.kind === "string" ? req.query.kind : undefined;
      const allowedKinds = ["template", "organism", "molecule", "atom"] as const;
      type AllowedKind = (typeof allowedKinds)[number];
      const kind: AllowedKind | undefined =
        rawKind !== undefined
          ? (allowedKinds.find((k) => k === rawKind) as AllowedKind | undefined)
          : undefined;
      if (rawKind !== undefined && kind === undefined) {
        res.status(400).json({
          error: "invalid_kind",
          message: `kind must be one of ${allowedKinds.join(", ")}; got '${rawKind}'.`,
        });
        return;
      }
      try {
        const blueprints = await listBlueprints(
          { vectorStore: vectors },
          DEFAULT_BUILDER_APP_ID,
          kind
        );
        // Project to a wire-friendly view — `componentCode` is large
        // and not load-bearing for the operator listing; surface a
        // length signal instead so the UI can show "12 KB" without
        // parsing 12 KB.
        const entries = blueprints.map((bp) => ({
          id: bp.id,
          kind: bp.kind,
          contractKey: bp.contractKey,
          intent: bp.intent,
          createdAt: bp.createdAt,
          hitCount: bp.hitCount,
          ...(bp.lastHitAt !== undefined ? { lastHitAt: bp.lastHitAt } : {}),
          // Surface provenance so operators
          // can distinguish synth-gen vs. operator-registered vs.
          // marketplace-installed rows on `/ggui/console/blueprints/
          // registry`. Matcher behaviour is unchanged — provenance is
          // purely informational.
          provenance: bp.provenance,
          componentCodeBytes: bp.componentCode.length,
        }));
        res.json({ entries, total: entries.length });
      } catch (err) {
        logger.warn("console_registry_list_failed", { error: String(err) });
        res.status(500).json({
          error: "registry_unavailable",
          message:
            err instanceof Error
              ? `Registry list failed — ${err.message}`
              : `Registry list failed — ${String(err)}`,
        });
      }
    });

    // ──────────────────────────────────────────────────────────────────
    // Admin gate for the operator-info read endpoints (`/info`,
    // `/sessions`, `/config`). These surfaces sit under `/admin/*`
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
        "/ggui/console/renders",
        "/ggui/console/config",
        "/ggui/console/llm-trace",
        "/ggui/console/validator",
        "/ggui/console/cache",
        "/ggui/console/payloads",
        "/ggui/console/timeline",
      ]) {
        app.use(path, (req, res, next) => {
          // The per-render meta route (`/ggui/console/renders/:id/meta`)
          // gates on the same-origin console cookie, NOT the admin token —
          // its caller is a same-origin iframe that already proved cookie
          // possession. Exempt it from this admin-token middleware so
          // both gates compose cleanly (admin token for `/renders` list,
          // cookie for per-render meta).
          if (path === "/ggui/console/renders" && /^\/[^/]+\/meta\/?$/.test(req.path)) {
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

    // Timeline surfaces — `/devtools/timeline` reads the session
    // list and per-session RenderStore.observe replay. REST
    // only — replay is a snapshot, not a live stream. Admin-gated by
    // the loop above. The hoisted `renderStore` + `streamBuffer` may
    // be undefined when neither `mcpApps` nor `sessionChannel` is on;
    // the route handlers tolerate that and return empty bodies.
    mountConsoleTimelineRoutes(app, renderStore, streamBuffer);

    // GET /ggui/console/renders?limit=<n> — active-render list for
    // the console SPA's `/admin/renders` page. Operator-facing "what's
    // live right now?" surface, enriched with each render's current
    // shortCode so rows can link through to `/s/<shortCode>` (the
    // existing render viewer).
    //
    // Scope: active renders only. The `SessionFilter.status`
    // taxonomy ('active' | 'completed' | 'expired') requires the
    // store's private `closed` bucket flag to disambiguate completed
    // from expired — that flag isn't on the `Render` protocol type,
    // so exposing mixed-status listings honestly requires a seam
    // extension we don't need for the "live right now" use case.
    // Future slices (historical renders, closed-renders triage)
    // can opt in via query-param.
    //
    // Sources:
    //   - `renderStore.list({ status: 'active', limit })` — single
    //     page, limit default 25, clamped to [1, 100].
    //   - `shortCodeIndex.findByRenderId(render.id)` — best-effort
    //     enrichment; absent shortCode is a valid row (displays
    //     without a click-through link).
    //
    // Sort: most-recent `lastActivityAt` first — matches operator
    // intent "show me what I was just looking at."
    //
    // Zero-config shape: `{ renders: [], total: 0 }` when no
    // renderStore is wired (e.g. pure-MCP dev boot with neither
    // sessionChannel nor mcpApps enabled).
    app.get("/ggui/console/renders", async (req, res) => {
      applyDevtoolSecurityHeaders(res);
      interface RenderSummary {
        readonly renderId: string;
        readonly shortCode?: string;
        readonly appId: string;
        readonly lastActivityAt: number;
        readonly createdAt: number;
        readonly status: "active";
      }

      const limitRaw = req.query["limit"];
      let limit = 25;
      if (typeof limitRaw === "string") {
        const parsed = Number.parseInt(limitRaw, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          limit = Math.min(100, parsed);
        }
      }

      if (!renderStore) {
        res.json({ renders: [], total: 0 });
        return;
      }

      try {
        const renders = await renderStore.list({
          status: "active",
          limit,
        });
        const summaries: RenderSummary[] = [];
        for (const render of renders) {
          let shortCode: string | null = null;
          if (opts.shortCodeIndex) {
            try {
              shortCode = await opts.shortCodeIndex.findByRenderId(render.id);
            } catch (err) {
              // Best-effort — the render row is still honest
              // without a shortCode.
              logger.warn("console_renders_shortcode_lookup_failed", {
                renderId: render.id,
                error: String(err),
              });
            }
          }
          summaries.push({
            renderId: render.id,
            ...(shortCode ? { shortCode } : {}),
            appId: render.appId,
            lastActivityAt: render.lastActivityAt,
            createdAt: render.createdAt,
            status: "active",
          });
        }
        // Most-recent activity first. Tiebreak on renderId for
        // stability when multiple rows share the same ms timestamp.
        summaries.sort((a, b) => {
          const byRecency = b.lastActivityAt - a.lastActivityAt;
          if (byRecency !== 0) return byRecency;
          return a.renderId.localeCompare(b.renderId);
        });
        res.json({ renders: summaries, total: summaries.length });
      } catch (err) {
        logger.warn("console_renders_list_failed", {
          error: String(err),
        });
        res.status(500).json({
          error: "renders_unavailable",
          message:
            err instanceof Error
              ? `Render store failed to list — ${err.message}`
              : `Render store failed to list — ${String(err)}`,
        });
      }
    });

    // GET /ggui/console/mcp/tools — registered MCP-tool inventory for
    // the console SPA's `/mcp` page. Operator-facing "what tools does
    // my server expose?" — same handler set the `/mcp` JSON-RPC
    // endpoint surfaces via `tools/list`, but rendered as cards
    // instead of curl output.
    //
    // Currently LIST-only — name + title? + description + input/output
    // JSON Schema. A "test invoke" form is deferred — invoking a tool
    // from the console needs a same-origin bearer claim story (console
    // session cookie currently authenticates only the live-channel WS
    // upgrade).
    //
    // Schema conversion: handlers carry Zod raw shapes; the wire
    // needs JSON Schema. `z.toJSONSchema(z.object(rawShape))` does
    // the conversion. Failure (e.g. an exotic Zod type the v4
    // converter doesn't yet support) reports `{}` for that field
    // and warn-logs — operators still see name + description, just
    // without typed input/output detail.
    app.get("/ggui/console/mcp/tools", async (_req, res) => {
      applyDevtoolSecurityHeaders(res);
      interface ToolInfo {
        readonly name: string;
        readonly title?: string;
        readonly description: string;
        readonly inputSchema: unknown;
        readonly outputSchema: unknown;
      }

      const safeToJsonSchema = (shape: ZodRawShape): unknown => {
        try {
          return z.toJSONSchema(z.object(shape));
        } catch (err) {
          logger.warn("console_mcp_tools_schema_conversion_failed", {
            error: String(err),
          });
          return {};
        }
      };

      const tools: ToolInfo[] = handlers.map((h) => {
        const summary: ToolInfo = {
          name: h.name,
          ...(h.title !== undefined ? { title: h.title } : {}),
          description: h.description,
          inputSchema: safeToJsonSchema(h.inputSchema),
          outputSchema: safeToJsonSchema(h.outputSchema),
        };
        return summary;
      });
      // Stable sort by name for deterministic operator reading order
      // — handlers are registered in module-import order, which is
      // arbitrary from the operator's perspective.
      tools.sort((a, b) => a.name.localeCompare(b.name));
      res.json({ tools, total: tools.length });
    });

    // GET /ggui/console/config — VSCode-settings-style read of the
    // resolved `ggui.json`. Returns the parsed manifest, the raw
    // file contents for display, and the introspected v1 JSON Schema
    // (which carries field descriptions via the `.describe()` calls
    // on `GguiJsonV1`).
    //
    // Source resolution: walks up from `process.cwd()` to find the
    // nearest `ggui.json`. Honest about three states:
    //   - found + valid → `{source: {found:true, path}, manifest, raw, schema}`
    //   - found + invalid → `{source: {found:true, path, error: {message}},
    //     raw, schema}` (no manifest field — the operator inspects the raw
    //     bytes + sees the validation error so they can fix the file)
    //   - not found → `{source: {found:false, searchedFrom}, schema}`
    //     (the schema still ships so operators can browse what would be
    //     configurable IF a manifest existed)
    //
    // Read-only. Form controls on the same payload and a PATCH
    // endpoint with atomic write + conflict detection layer on top.
    app.get("/ggui/console/config", async (_req, res) => {
      applyDevtoolSecurityHeaders(res);
      const searchedFrom = process.cwd();
      const safeSchema = (() => {
        try {
          // `unrepresentable: 'any'` keeps fields backed by `.transform()`
          // (e.g. `generation.model`, parsed at the schema boundary into
          // a typed `LlmRoute`) in the JSON Schema as `{}` instead of
          // throwing. Transforms are runtime-only; the JSON-Schema view
          // serves the console SPA as documentation, so a permissive
          // shape is the honest projection.
          return z.toJSONSchema(GguiJsonV1, { unrepresentable: "any" });
        } catch (err) {
          logger.warn("console_config_schema_conversion_failed", {
            error: String(err),
          });
          return {};
        }
      })();
      const path = findGguiJson(searchedFrom);
      if (path === null) {
        res.json({
          source: { found: false as const, searchedFrom },
          schema: safeSchema,
        });
        return;
      }
      let raw: string | null = null;
      try {
        raw = readFileSync(path, "utf-8");
      } catch (err) {
        logger.warn("console_config_read_failed", { path, error: String(err) });
      }
      const result = safeLoadGguiJson(path);
      if (!result.success) {
        const cause = result.error.cause;
        const errorMessage = cause instanceof Error ? cause.message : result.error.message;
        res.json({
          source: {
            found: true as const,
            path,
            error: { message: errorMessage },
          },
          ...(raw !== null ? { raw } : {}),
          schema: safeSchema,
        });
        return;
      }
      res.json({
        source: { found: true as const, path },
        manifest: result.data,
        ...(raw !== null ? { raw } : {}),
        schema: safeSchema,
      });
    });

    app.get("/ggui/console/info", async (_req, res) => {
      applyDevtoolSecurityHeaders(res);
      // Pairing block: `enabled` reflects whether the server was
      // composed with `pairing: true|{...}`. `pending` is the current
      // `activeInit()` read — null when no code is pending OR when
      // pairing is disabled. The landing page renders three distinct
      // copy paths against this shape (disabled / enabled-but-idle /
      // enabled-with-pending) so the client never has to compose
      // state from multiple optional fields.
      let pending: Awaited<ReturnType<PairingService["activeInit"]>> = null;
      if (pairingService) {
        try {
          pending = await pairingService.activeInit();
        } catch (err) {
          // `activeInit` is a read — failure here shouldn't 500 the
          // landing page. Log + return null; operator sees "no pending
          // pair code" which matches reality (we couldn't read one).
          logger.warn("console_active_init_failed", {
            error: String(err),
          });
          pending = null;
        }
      }

      // Capabilities block (console status dashboard).
      //   - `toolCount`: the number of MCP tool handlers this server
      //     registered. Same value `server.toolCount` exposes and the
      //     banner prints.
      //   - `blueprintCount`: operator-scoped blueprint count from the
      //     wired `uiRegistry.list()` — 0 when no registry is bound.
      //     Best-effort on read (same contract as `/ggui/console/registry`).
      //   - `primitiveCount`: sum across `primitiveCatalogs`.
      //   - `agentWired`: whether the session-channel + mcpApps path is
      //     live (the server can accept `ggui_render` + live-channel joins).
      //   - `generationWired`: whether `opts.generation` was bound —
      //     the `ggui_render` LLM path is active. Absent = push returns
      //     `codeReady: false` honest placeholders.
      //
      // Provider/model specifics (`generation: { provider, model }`
      // from the plan) are intentionally NOT surfaced yet — the
      // `UiGenerator` contract doesn't expose a read-only identity
      // on the handle. Adding that is a generator-package change; the
      // dashboard card lands on the simpler `generationWired: boolean`
      // until then.
      let blueprintCount = 0;
      if (opts.uiRegistry) {
        try {
          const list = await opts.uiRegistry.list();
          blueprintCount = list.length;
        } catch (err) {
          logger.warn("console_info_blueprint_count_failed", {
            error: String(err),
          });
        }
      }
      const primitiveCount = (opts.primitiveCatalogs ?? []).reduce(
        (sum, c) => sum + c.manifest.primitives.length,
        0
      );
      // Generation probe — `wired` reports dep binding; `hasCredentials`
      // actually resolves BYOK credentials via the same seam the push
      // handler uses, so the operator-facing pill can distinguish
      // three honest states: off / needs-key / ready. The split avoids
      // a green "wired" pill next to a "text-only" meta misleading
      // operators when creds are missing.
      //
      // Probe is best-effort: resolveLlm failure (filesystem hiccup,
      // malformed `~/.ggui/credentials.json`) reports
      // `hasCredentials: false`, matching operator expectation
      // "whatever is on disk, this won't fire right now." Absence of
      // creds is a non-error path per the GenerationDeps contract.
      let generationHasCredentials = false;
      if (opts.generation) {
        try {
          const probeResult = await opts.generation.resolveLlm({
            appId: DEFAULT_BUILDER_APP_ID,
            requestId: `console-info-probe-${randomUUID()}`,
          });
          generationHasCredentials = probeResult !== null;
        } catch (err) {
          logger.warn("console_info_credential_probe_failed", {
            error: String(err),
          });
        }
      }

      const capabilities = {
        toolCount: handlers.length,
        blueprintCount,
        primitiveCount,
        agentWired: mcpAppsEnabled,
        generation: {
          wired: opts.generation !== undefined,
          hasCredentials: generationHasCredentials,
        },
      } as const;

      // Storage block.
      //   - `renderStore`: 'memory' when the server fell back to the
      //     in-memory default, 'custom' when the operator passed one.
      //   - `vectorStore`: same rule for vectors.
      // Keeps the label taxonomy narrow — two states the operator can
      // act on (swap to SQLite, swap to Postgres). Implementation-name
      // leakage (e.g., "InMemoryRenderStore") would couple the wire
      // to class names that are not part of the public contract.
      const storage = {
        renderStore: (opts.renderStore ? "custom" : "memory") as "memory" | "custom",
        vectorStore: (opts.vectors ? "custom" : "memory") as "memory" | "custom",
      };

      res.json({
        server: info.name,
        version: info.version,
        ...(info.description !== undefined ? { description: info.description } : {}),
        mode,
        pairing: {
          enabled: pairingEnabled,
          pending,
        },
        capabilities,
        storage,
      });
    });

    // POST /ggui/console/chat/message — OSS dev chat round-trip.
    //
    // Routes the message through `ggui_render` whenever the server was
    // composed with a real generator — turning the chat surface into
    // the cohesive agent experience: every user message becomes a push
    // against a thread-scoped session; the push handler owns
    // generation, cache, and provisional preview; the client renders
    // the resulting stack entry inline using `StackItemRenderer`.
    //
    // Shape: `{ text, threadId?, sessionId? }` →
    // `{ threadId, userMessage, agentMessage, ui? }`.
    //   - `ui` is populated only when the push handler is wired AND
    //     the call succeeded. `ui.stackItemId` is the stack item id the
    //     client looks up in `SessionApi.stack` to render the agent's
    //     generated component inline.
    //   - When the push handler is NOT wired (no `mcpApps`, placeholder
    //     mode, or no BYOK), `ui` is absent and `agentMessage.text`
    //     carries an honest text-only acknowledgment. This preserves
    //     the text-only round-trip path so operators without a key can
    //     still exercise the chat UI end-to-end.
    //   - `sessionId` is echoed on every response and should be passed
    //     back on subsequent messages so the thread reuses one session
    //     (stack entries accumulate; `GguiSession` stays subscribed).
    //
    // Same-origin only — no bearer auth. The console surface is
    // always the operator's own browser pointing at their own `ggui
    // serve` instance; adding bearer auth here would block the
    // dev-page-is-usable claim without meaningful security gain.
    //
    // The push invocation uses `DEFAULT_BUILDER_APP_ID` for tenant
    // scope — same well-known value the `/mcp` endpoint collapses to
    // in OSS single-user mode. Matches blueprint + vector scoping
    // applied by the generator / cache seams.
    //
    // Gate on `generationWithCache`: without a generator wired, a push
    // call would allocate a session + shortCode + empty stack item
    // (codeReady:false) per turn without any visible UI — honest
    // behavior but useless. Falling through to the canned-text path
    // keeps the chat surface usable without a BYOK key AND preserves
    // the exact Lane-1 chat-page spec assertion (`/OSS agent
    // generation/`) without a copy change.
    const pushHandlerForChat =
      generationWithCache !== undefined
        ? handlers.find((h) => h.name === "ggui_render")
        : undefined;
    const handshakeHandlerForChat =
      pushHandlerForChat !== undefined
        ? handlers.find((h) => h.name === "ggui_handshake")
        : undefined;
    app.post("/ggui/console/chat/message", async (req, res) => {
      applyDevtoolSecurityHeaders(res);
      const body = (req.body ?? {}) as {
        text?: unknown;
        threadId?: unknown;
        sessionId?: unknown;
      };
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (text.length === 0) {
        res.status(400).json({
          error: "invalid_request",
          message: "`text` (non-empty string) is required",
        });
        return;
      }
      if (text.length > 4000) {
        res.status(400).json({
          error: "invalid_request",
          message: "`text` must be <= 4000 chars",
        });
        return;
      }
      const threadId =
        typeof body.threadId === "string" && body.threadId.length > 0
          ? body.threadId
          : `chat-${randomUUID()}`;
      const requestedSessionId =
        typeof body.sessionId === "string" && body.sessionId.length > 0
          ? body.sessionId
          : undefined;
      const now = Date.now();
      const userMessage = {
        id: `msg-${randomUUID()}`,
        role: "user" as const,
        text,
        createdAt: now,
      };

      // Attempt real generation through `ggui_render` when wired.
      // `pushHandlerForChat` is undefined when mcpApps was disabled or
      // the operator built a custom handler set without push. The
      // handler itself returns `codeReady:false` when generation deps
      // aren't wired (no BYOK) — we surface that honestly on the
      // agentMessage text without pretending a UI landed.
      let ui:
        | {
            sessionId: string;
            shortCode: string;
            stackItemId: string;
            codeReady: boolean;
            cache?: { hit: boolean; llmCallsAvoided: number };
          }
        | undefined;
      let agentText: string | undefined;
      if (pushHandlerForChat && handshakeHandlerForChat) {
        try {
          const requestId = randomUUID();
          const handshakeInput: Record<string, unknown> = {
            story: { intent: text, contract: {} },
          };
          if (requestedSessionId) {
            handshakeInput.session = { id: requestedSessionId };
          }
          const hsRaw = await handshakeHandlerForChat.handler(handshakeInput, {
            appId: DEFAULT_BUILDER_APP_ID,
            requestId,
          });
          const handshakeId = (hsRaw as { handshakeId: string }).handshakeId;
          const raw = await pushHandlerForChat.handler(
            { handshakeId, contract: {} },
            { appId: DEFAULT_BUILDER_APP_ID, requestId }
          );
          const result = raw as {
            sessionId: string;
            stackItemId: string;
            shortCode: string;
            codeReady: boolean;
            cache?: { hit: boolean; llmCallsAvoided: number };
          };
          ui = {
            sessionId: result.sessionId,
            shortCode: result.shortCode,
            stackItemId: result.stackItemId,
            codeReady: result.codeReady,
            ...(result.cache ? { cache: result.cache } : {}),
          };
          // If console cookie auth is enabled, mint a session
          // cookie so the chat can open the /ws subscription without
          // a separate POST to /session-cookie. Single round-trip
          // per turn; cookie is same-origin HttpOnly.
          if (sessionCookieEnabled) {
            const secret = sharedTokenSecret as string;
            const cookieTtlSec =
              typeof opts.console === "object" &&
              opts.console !== null &&
              typeof opts.console.sessionCookie === "object" &&
              opts.console.sessionCookie !== null
                ? opts.console.sessionCookie.ttlSec
                : undefined;
            const cookieSecure =
              typeof opts.console === "object" &&
              opts.console !== null &&
              typeof opts.console.sessionCookie === "object" &&
              opts.console.sessionCookie !== null &&
              opts.console.sessionCookie.secure === true;
            const mint = mintDevtoolCookie({
              // push handler dist still emits the pre-rename `sessionId`
              // field on its output — sibling B.2d agent renames push.ts
              // to surface `renderId` in the same Phase B slice; until
              // then we route the same string through the new field
              // name on the cookie mint input.
              renderId: result.sessionId,
              appId: DEFAULT_BUILDER_APP_ID,
              secret,
              ...(cookieTtlSec !== undefined ? { ttlSec: cookieTtlSec } : {}),
              secure: cookieSecure,
            });
            res.setHeader("Set-Cookie", mint.setCookieHeader);
          }
          if (result.codeReady) {
            agentText = result.cache?.hit
              ? "Reused a matching UI from cache for your request."
              : "Generated a UI for your request.";
          } else {
            // Generator ran but produced no code (no BYOK, generator
            // error, or placeholder mode). Honest text so the
            // operator knows why the surface didn't render a UI.
            agentText =
              "I received your message, but generation did not produce a UI " +
              "(no BYOK key configured, or the provider declined). Export " +
              "ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY / " +
              "OPENROUTER_API_KEY and retry.";
            // Drop the ui payload — no code ready means nothing to
            // render inline. The agent text carries the diagnosis.
            ui = undefined;
          }
        } catch (err) {
          logger.warn?.("console_chat_push_failed", {
            threadId,
            error: err instanceof Error ? err.message : String(err),
          });
          agentText =
            "Generation failed: " +
            (err instanceof Error ? err.message : String(err)) +
            ". The chat surface is still live — retry or try a different prompt.";
          ui = undefined;
        }
      }

      const agentMessage = {
        id: `msg-${randomUUID()}`,
        role: "agent" as const,
        text:
          agentText ??
          // No push handler at all — text-only fallback. Keeps the
          // Lane-1 chat-page spec green by preserving the exact copy
          // it asserts against.
          "Message received. OSS agent generation is not yet wired — " +
            "this is the text-only dev chat. Full responses " +
            "and generated UIs arrive once the generator port lands.",
        createdAt: now + 1,
      };
      logger.debug?.("console_chat_message", {
        threadId,
        userMessageId: userMessage.id,
        textLength: text.length,
        uiStackItemId: ui?.stackItemId,
        uiCodeReady: ui?.codeReady,
      });
      res.status(200).json({
        threadId,
        userMessage,
        agentMessage,
        ...(ui ? { ui } : {}),
      });
    });

    // Cookie-mint route + cookieAuth binding for the session channel.
    // Both enabled only when `sessionCookie` is on (default when
    // `console` is otherwise enabled). The preconditions checked
    // earlier guarantee shortCodeIndex + sessionChannel are present,
    // so the below references are safe.
    if (sessionCookieEnabled) {
      const secret = sharedTokenSecret as string; // verified set above
      const shortCodeIndex = opts.shortCodeIndex as ShortCodeIndex; // precondition
      const cookieTtlSec = sessionCookieConfig.ttlSec; // undefined → helper default (8h)
      const cookieSecure = sessionCookieConfig.secure === true;
      const cookieLogger = logger.child({
        component: "console-cookie",
      });

      app.post("/ggui/console/render-cookie", async (req: Request, res: Response) => {
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
            message: "Short-code does not resolve to any session on this server",
          });
          return;
        }
        const mint = mintDevtoolCookie({
          renderId: binding.renderId,
          appId: binding.appId,
          secret,
          ...(cookieTtlSec !== undefined ? { ttlSec: cookieTtlSec } : {}),
          secure: cookieSecure,
        });
        res.setHeader("Set-Cookie", mint.setCookieHeader);
        res.json({
          renderId: mint.renderId,
          appId: mint.appId,
          expiresAt: mint.expiresAt,
        });
      });

      // Console render-resource pair. The console's `RenderViewer`
      // runs the production iframe path:
      //
      //   1. GET /ggui/console/render-resource?render=<renderId>
      //      → returns a `ResourceContents` blob whose `text` IS the
      //      production thin-shell HTML (`GGUI_RENDER_SHELL_HTML`,
      //      byte-identical to what Claude Desktop fetches via MCP
      //      `resources/read ui://ggui/render`). The shell does NOT
      //      carry an inlined bootstrap — same as production.
      //
      //   2. GET /ggui/console/renders/:renderId/meta
      //      → returns `{ "ai.ggui/render": McpAppAiGguiRenderMeta }` JSON.
      //      The console replies with this to the iframe's
      //      `ui/initialize` postMessage (Path-B inline-meta delivery
      //      per `docs/protocol/extensions/ai.ggui-meta.md`).
      //
      // Earlier iterations used a wrapped-shell path
      // (`buildDevtoolSessionResourceHtml`); that is gone — the
      // console now boots the same shell any conformant MCP Apps host
      // loads.
      //
      // Named parties (both routes):
      //   - console (SPA caller) — holds the same-origin cookie.
      //   - mcp-server (this handler) — gates auth + scope; mints the
      //     bootstrap on the bootstrap route.
      //   - <McpAppIframe> host (bootstrap forwarder) — receives the
      //     bootstrap JSON via prop and threads it through `ui/initialize`.
      //   - renderer bundle (inside the iframe) — runs the same boot
      //     code path as production; reads the `ai.ggui/render` +
      //     `ai.ggui/render` slice meta pair.
      //
      // Auth + scope obligations (both routes — uniform):
      //   - Cookie-auth via `readDevtoolCookieFromHeaders` +
      //     `verifyDevtoolCookie`. Invalid / missing → 401.
      //   - Scope: `cookie.renderId` MUST equal `?render=`. Cross-
      //     render access with a valid cookie → 403.
      //   - Render existence + appId match: 404 / 403 respectively.
      //   - The bootstrap route additionally requires `mintBootstrap`
      //     (`mcpApps: true` at construction); 503 otherwise.
      //
      // Failure-mode taxonomy + observable violations are unchanged
      // from earlier iterations; the wire shape is what changed.

      /**
       * Shared auth + scope gate for the two console render routes.
       * Returns the verified `(renderId, appId)` pair on success or
       * `null` after writing an HTTP error response on failure.
       *
       * Internal — closure-scoped to the route block; not exported.
       */
      const gateDevtoolRenderRequest = async (
        req: Request,
        res: Response,
        explicitRenderId?: string
      ): Promise<{ renderId: string; appId: string } | null> => {
        const renderIdRaw =
          explicitRenderId !== undefined ? explicitRenderId : req.query["render"];
        if (typeof renderIdRaw !== "string" || renderIdRaw.length === 0) {
          res.status(400).json({
            error: "invalid_request",
            message:
              "`render` query parameter (or :renderId path parameter on the meta route) is required",
          });
          return null;
        }
        const rawCookie = readDevtoolCookieFromHeaders(req.headers);
        if (!rawCookie) {
          res.status(401).json({
            error: "missing_cookie",
            message: `${CONSOLE_COOKIE_NAME} cookie required (mint via POST /ggui/console/render-cookie first)`,
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
        if (claims.renderId !== renderIdRaw) {
          res.status(403).json({
            error: "cookie_render_mismatch",
            message: `Console cookie is bound to render '${claims.renderId}' but request targets '${renderIdRaw}'`,
          });
          return null;
        }
        // Render existence + appId match — even on the static-shell
        // route we honestly answer 404 instead of leaking an HTML blob
        // for a render the server doesn't know about.
        let render: Awaited<ReturnType<RenderStore["get"]>> = null;
        if (renderStore) {
          try {
            render = await renderStore.get(claims.renderId);
          } catch (err) {
            cookieLogger.error("render_resource_store_failed", {
              error: String(err),
              renderId: claims.renderId,
            });
            res.status(500).json({ error: "internal_error" });
            return null;
          }
        }
        if (!render) {
          res.status(404).json({
            error: "render_not_found",
            message: `Render '${claims.renderId}' is not on this server`,
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
        return { renderId: claims.renderId, appId: claims.appId };
      };

      // GET /ggui/console/render-resource?render=<renderId>
      // → production thin-shell HTML, wrapped as a ResourceContents
      //   blob. NO inlined bootstrap — console fetches the bootstrap
      //   separately (route below) and replies to the iframe's
      //   `ui/initialize` postMessage with it.
      app.get("/ggui/console/render-resource", async (req: Request, res: Response) => {
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

      // GET /ggui/console/renders/:renderId/meta
      // → slice-envelope JSON (`{ "ai.ggui/render": {...} }`, the same
      //   shape as the wire `_meta`). Required when the console is
      //   hosting the renderer in a srcdoc iframe and needs to feed
      //   the iframe a meta payload via `ui/initialize`. `mcpApps:
      //   true` is required (mintWsToken/mintBootstrap presence) —
      //   503 otherwise.
      app.get("/ggui/console/renders/:renderId/meta", async (req: Request, res: Response) => {
        applyDevtoolSecurityHeaders(res);
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        const renderIdFromPath = singleParam(req.params["renderId"]);
        const verified = await gateDevtoolRenderRequest(req, res, renderIdFromPath);
        if (!verified) return;
        if (!mintBootstrap) {
          res.status(503).json({
            error: "mcp_apps_disabled",
            message:
              "sessions/:id/meta requires mcpApps: true on the server so the renderer can receive a valid WS auth token. Enable `mcpApps` on createGguiServer() and retry.",
          });
          return;
        }
        const minted = mintBootstrap(verified.renderId, verified.appId);
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
        // the active stack item. The renderer iframe's strict CSP
        // forbids the `new Function` codegen `ajv.compile()` needs,
        // so the server compiles + writes the bundle to its
        // CodeStore at push time and threads the URL here. The
        // iframe fetches the URL + dynamic-imports to resolve
        // validators. Best-effort: a missing bundle degrades to no
        // client-side validation; server-side `assertActionContract`
        // remains authoritative.
        let renderContractHash: string | undefined;
        let renderValidatorsUrl: string | undefined;
        if (renderStore && opts.codeStore) {
          try {
            const stored = await renderStore.get(verified.renderId);
            if (
              stored !== null &&
              stored.render.type !== "mcpApps" &&
              stored.render.type !== "system" &&
              typeof stored.render.componentCode === "string" &&
              stored.render.componentCode.length > 0
            ) {
              const bundle = await deriveContractBundle(stored.render);
              if (bundle) {
                await opts.codeStore.put(bundle.contractHash, bundle.bundleSource);
                renderContractHash = bundle.contractHash;
                const baseForValidators = opts.publicBaseUrl
                  ? opts.publicBaseUrl.replace(/\/$/, "")
                  : `${req.protocol}://${requestHost}`;
                renderValidatorsUrl = `${baseForValidators}/contract/${bundle.contractHash}.js`;
              }
            }
          } catch (err) {
            cookieLogger.warn("render_meta_validators_failed", {
              error: String(err),
              renderId: verified.renderId,
            });
          }
        }
        // Slice-envelope response (Phase B: single ai.ggui/render
        // slice) — same shape as the wire `_meta` and the inline
        // `__GGUI_META__` global the `/r/<shortCode>` shell carries.
        // RenderViewer parses with `parseMcpAppAiGguiRenderMeta`.
        const renderMeta: McpAppAiGguiRenderMeta = {
          renderId: verified.renderId,
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

      // GET /ggui/console/render?render=<renderId>
      // → `{render, eventSequence}` JSON.
      //
      // Console-only observation surface for `<RenderViewer>` to mount
      // `<RenderInspector>`. The iframe owns the live WS subscription
      // + the bootstrap token (single-use), so the OUTER console DOM
      // has no live source for render data — without this endpoint
      // the inspector can't render contract / test-action panels.
      //
      // Named parties:
      //   - console SPA (`RenderViewer`) — holds the same-origin
      //     cookie minted by `POST /ggui/console/render-cookie`.
      //   - mcp-server (this handler) — gates auth + scope, reads the
      //     authoritative render from `renderStore`.
      //
      // Auth + scope: identical to render-resource / render-bootstrap
      // (cookie-auth + renderId match + appId match).
      //
      // Failure modes:
      //   - 401 missing/invalid cookie · 403 cross-render/app · 404
      //     unknown render · 500 store failure (all delegated to
      //     `gateDevtoolRenderRequest`).
      //   - 503 if `renderStore` is not wired (zero-config server).
      //
      // Shape note: Phase B collapsed the prior session-stack array to
      // a single `Render` row. The response now returns the resolved
      // `Render` directly; console narrows on `render.type` before
      // passing into `<RenderInspector>` (which only accepts the
      // ComponentRender variant since the inspector reads actionSpec /
      // streamSpec / propsSpec — fields McpAppsRender doesn't carry).
      app.get("/ggui/console/render", async (req: Request, res: Response) => {
        applyDevtoolSecurityHeaders(res);
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        const verified = await gateDevtoolRenderRequest(req, res);
        if (!verified) return;
        if (!renderStore) {
          res.status(503).json({
            error: "render_store_unavailable",
            message:
              "Render observation requires sessionChannel: true on the server so the render store is wired. Enable `sessionChannel` on createGguiServer() and retry.",
          });
          return;
        }
        let stored: Awaited<ReturnType<RenderStore["get"]>> = null;
        try {
          stored = await renderStore.get(verified.renderId);
        } catch (err) {
          cookieLogger.error("render_store_failed", {
            error: String(err),
            renderId: verified.renderId,
          });
          res.status(500).json({ error: "internal_error" });
          return;
        }
        if (!stored) {
          // Race: gate verified existence above but the render
          // could expire between calls. Honest 404.
          res.status(404).json({
            error: "render_not_found",
            message: `Render '${verified.renderId}' is not on this server`,
          });
          return;
        }
        res.status(200).json({
          render: stored.render,
          eventSequence: stored.eventSequence,
        });
      });

      // Bind cookieAuth into the session channel. Declared `let`
      // above so createRenderChannelServer can reference it below.
      consoleCookieAuth = {
        readCookie: readDevtoolCookieFromHeaders,
        verify: (cookieValue: string) => verifyDevtoolCookie(cookieValue, secret),
      };

      // Reference the cookie name to keep the export alive for
      // downstream consumers + lint. The name is the single source
      // of truth; avoid duplicating the string anywhere.
      cookieLogger.debug?.("console_cookie_ready", {
        cookieName: CONSOLE_COOKIE_NAME,
      });
    }

    // OAuth client management (the console's "Connected Apps" surface).
    // Mounted only when both console + OAuth are enabled — there's
    // nothing to manage if OAuth is off, and the management surface
    // belongs to the operator-facing console plane (not the public
    // OAuth metadata endpoints). Same-origin posture: no bearer auth,
    // matches sibling console routes (`/ggui/console/registry`,
    // `/ggui/console/blueprints/cached/...`).
    //
    // GET  /ggui/console/oauth-clients         — list (oldest-first by createdAt)
    // DELETE /ggui/console/oauth-clients/:id   — revoke (idempotent)
    //
    // Revoke caveat — see OAuthStorage.deleteClient JSDoc: revoke
    // deletes the registration but doesn't invalidate in-flight
    // access tokens (the current paste-key flow has access_token ===
    // paired bearer).
    if (oauthEnabled) {
      app.get("/ggui/console/oauth-clients", async (_req, res) => {
        applyDevtoolSecurityHeaders(res);
        try {
          const clients = await oauthStorage.listClients();
          // Project to a wire shape: explicitly list every field we
          // intend to expose so an unrelated `ClientRecord` field
          // addition doesn't accidentally leak through this endpoint.
          res.json({
            clients: clients.map((c) => ({
              clientId: c.clientId,
              clientName: c.clientName ?? null,
              redirectUris: c.redirectUris,
              createdAt: c.createdAt,
            })),
          });
        } catch (err) {
          logger.warn("console_oauth_clients_list_failed", {
            error: String(err),
          });
          res.status(500).json({
            error: "list_failed",
            message:
              err instanceof Error
                ? `Client list failed — ${err.message}`
                : `Client list failed — ${String(err)}`,
          });
        }
      });

      app.delete("/ggui/console/oauth-clients/:clientId", async (req, res) => {
        applyDevtoolSecurityHeaders(res);
        const clientId = req.params["clientId"];
        if (typeof clientId !== "string" || clientId.length === 0) {
          res.status(400).json({
            error: "missing_client_id",
            message:
              "clientId required in path segment (e.g. DELETE /ggui/console/oauth-clients/abc123).",
          });
          return;
        }
        try {
          await oauthStorage.deleteClient(clientId);
          // 204 whether the id was present or not — `deleteClient`
          // is idempotent at the storage layer (matches DELETE
          // /blueprints/cached/:id semantics).
          res.status(204).end();
        } catch (err) {
          logger.warn("console_oauth_clients_delete_failed", {
            error: String(err),
            clientId,
          });
          res.status(500).json({
            error: "delete_failed",
            message:
              err instanceof Error
                ? `Client delete failed — ${err.message}`
                : `Client delete failed — ${String(err)}`,
          });
        }
      });
    }

    // ── Admin-gated keys plane ─────────────────────────────────────
    //
    // POST /ggui/console/admin-login    — bearer → cookie exchange.
    // GET  /ggui/console/keys           — list pairings + plaintext token.
    // POST /ggui/console/keys           — mint a new pairing programmatically.
    // DELETE /ggui/console/keys/:id     — revoke a pairing (idempotent).
    //
    // Why the gate exists: the keys plane renders plaintext bearer
    // tokens minted by the pairing service. The persistence file
    // (`~/.ggui/keys.json` typically) already stores them in plaintext
    // — single-operator local-host threat model — so showing them in
    // a same-origin admin page is a UX, not a posture, change. BUT
    // operators expose `ggui serve` over Cloudflare tunnels for
    // claude.ai connector use, which removes "URL is unreachable from
    // the open internet" from the threat model. The admin token gates
    // the keys plane against random URL discovery.
    //
    // Scope discipline: the gate covers `/ggui/console/keys*` +
    // `/ggui/console/admin-login` ONLY. Other console routes
    // (registry, sessions, cached blueprints, oauth-clients) are not
    // re-gated here — that's a separate audit slice. Adding a single-
    // path-prefix middleware avoids re-litigating the whole console
    // posture in one go.
    //
    // Auth shape: `Authorization: Bearer <admin-token>` header OR the
    // `ggui_console_admin` cookie (HttpOnly, sameSite=Lax, Secure when
    // the request arrived over TLS). Cookie is minted by
    // POST /ggui/console/admin-login on a successful token paste.
    if (resolvedAdminToken !== null && pairingService) {
      const adminTokenForGate = resolvedAdminToken;
      const pairingForKeys = pairingService;
      const ADMIN_COOKIE_NAME = "ggui_console_admin";

      const requestHasAdminAuth = (req: Request): boolean => {
        // Header path — `Authorization: Bearer <token>`. Constant-time
        // compare not needed: this is single-tenant local-host with a
        // local network attacker model; the token also has 72 bits of
        // entropy, so a timing-side-channel attack would still need
        // ~2^36 attempts on average to materialize. Skip the cost.
        const authHeader = req.headers["authorization"];
        if (typeof authHeader === "string") {
          const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
          if (match && match[1] === adminTokenForGate) return true;
        }
        // Cookie path — same name the admin-login route sets.
        const cookieHeader = req.headers["cookie"];
        if (typeof cookieHeader === "string") {
          for (const raw of cookieHeader.split(";")) {
            const trimmed = raw.trim();
            const eq = trimmed.indexOf("=");
            if (eq <= 0) continue;
            const name = trimmed.slice(0, eq);
            if (name !== ADMIN_COOKIE_NAME) continue;
            const value = decodeURIComponent(trimmed.slice(eq + 1));
            if (value === adminTokenForGate) return true;
          }
        }
        return false;
      };

      // Same-origin posture for cookie minting: req.secure is true when
      // the connecting socket is TLS, OR when an upstream proxy set
      // `X-Forwarded-Proto: https` AND express trust-proxy is enabled.
      // For zero-config local-host, trust-proxy is OFF and req.secure
      // reflects the literal socket. Operators behind a tunnel with
      // TLS termination at the edge get the cookie WITHOUT Secure
      // (intended — the in-pod request is plaintext HTTP). Browsers
      // still scope it to the origin via SameSite, which is the
      // primary CSRF protection here; Secure is a defense-in-depth
      // attribute, not load-bearing for this token.
      const buildAdminCookie = (req: Request, value: string): string => {
        const attrs = [
          `${ADMIN_COOKIE_NAME}=${encodeURIComponent(value)}`,
          "Path=/",
          // 8-hour TTL — same posture as the console session cookie.
          // Operators staying in the keys page longer than that just
          // re-paste the admin token (printed on the boot banner).
          "Max-Age=28800",
          "SameSite=Lax",
          "HttpOnly",
        ];
        if (req.secure) attrs.push("Secure");
        return attrs.join("; ");
      };

      // POST /ggui/console/admin-login — bearer-paste → cookie exchange.
      // No auth gate: the request body IS the credential. On match,
      // we set the cookie and 204; on mismatch we 401. Pre-launch no-
      // backcompat: there's no rate-limiter wired in — this is a
      // local-host route, lock-out via wider posture (tunnel access
      // control, Cloudflare WAF) belongs to the operator.
      app.post("/ggui/console/admin-login", (req, res) => {
        applyDevtoolSecurityHeaders(res);
        const body = req.body as { token?: unknown } | undefined;
        const candidate = typeof body?.token === "string" ? body.token : "";
        if (candidate.length === 0 || candidate !== adminTokenForGate) {
          res.status(401).json({ error: "invalid_token" });
          return;
        }
        res.setHeader("Set-Cookie", buildAdminCookie(req, adminTokenForGate));
        res.status(204).end();
      });

      // Path-prefix gate. `app.use(path, mw)` runs `mw` for every
      // request whose path starts with `path` — express normalizes
      // trailing slashes / sub-paths so `/keys/abc` + `/keys` both
      // hit. We only mount the keys routes BELOW this so the gate is
      // genuinely the only ingress.
      app.use("/ggui/console/keys", (req, res, next) => {
        if (requestHasAdminAuth(req)) return next();
        applyDevtoolSecurityHeaders(res);
        res.status(401).json({ error: "admin_auth_required" });
      });

      // GET /ggui/console/keys — list pairings + plaintext bearer.
      // Wire shape: `{ keys: [{pairingId, deviceName, createdAt,
      // lastUsedAt?, token}] }`. Plaintext exposure is intentional;
      // see PairingWithToken JSDoc for the threat model.
      app.get("/ggui/console/keys", async (_req, res) => {
        applyDevtoolSecurityHeaders(res);
        try {
          const rows = await pairingForKeys.listPairingsWithTokens();
          res.json({
            keys: rows.map((row) => ({
              pairingId: row.pairingId,
              deviceName: row.deviceName,
              createdAt: row.createdAt,
              ...(row.lastUsedAt !== undefined ? { lastUsedAt: row.lastUsedAt } : {}),
              token: row.token,
            })),
          });
        } catch (err) {
          logger.warn("console_keys_list_failed", {
            error: String(err),
          });
          res.status(500).json({
            error: "list_failed",
            message:
              err instanceof Error
                ? `Keys list failed — ${err.message}`
                : `Keys list failed — ${String(err)}`,
          });
        }
      });

      // POST /ggui/console/keys — mint a fresh pairing without
      // round-tripping `initPairing` + `completePairing` from the SPA.
      // We do both server-side here: (1) initPairing to get a code,
      // (2) completePairing to consume it. Idiomatic for an admin-only
      // surface — the operator doesn't need a 6-digit-code typed in,
      // they're already authenticated by the admin token. Returns the
      // full `PairingCompletion` so the SPA can show the plaintext
      // bearer in a one-time copy callout.
      app.post("/ggui/console/keys", async (req, res) => {
        applyDevtoolSecurityHeaders(res);
        const body = req.body as { deviceName?: unknown } | undefined;
        const deviceName = typeof body?.deviceName === "string" ? body.deviceName.trim() : "";
        if (deviceName.length === 0 || deviceName.length > 256) {
          res.status(400).json({
            error: "invalid_device_name",
            message: "`deviceName` is required (non-empty string, ≤256 chars).",
          });
          return;
        }
        try {
          const init = await pairingForKeys.initPairing();
          const completion = await pairingForKeys.completePairing({
            code: init.code,
            deviceName,
          });
          res.json({
            pairingId: completion.pairingId,
            token: completion.token,
            serverName: completion.serverName,
            deviceName: completion.deviceName,
          });
        } catch (err) {
          logger.warn("console_keys_mint_failed", {
            error: String(err),
          });
          res.status(500).json({
            error: "mint_failed",
            message:
              err instanceof Error
                ? `Mint failed — ${err.message}`
                : `Mint failed — ${String(err)}`,
          });
        }
      });

      // DELETE /ggui/console/keys/:pairingId — revoke (idempotent).
      app.delete("/ggui/console/keys/:pairingId", async (req, res) => {
        applyDevtoolSecurityHeaders(res);
        const pairingId = req.params["pairingId"];
        if (typeof pairingId !== "string" || pairingId.length === 0) {
          res.status(400).json({
            error: "missing_pairing_id",
            message: "pairingId required in path segment (e.g. DELETE /ggui/console/keys/pair-1).",
          });
          return;
        }
        try {
          await pairingForKeys.revokePairing(pairingId);
          res.status(204).end();
        } catch (err) {
          logger.warn("console_keys_revoke_failed", {
            error: String(err),
            pairingId,
          });
          res.status(500).json({
            error: "revoke_failed",
            message:
              err instanceof Error
                ? `Revoke failed — ${err.message}`
                : `Revoke failed — ${String(err)}`,
          });
        }
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

    // ──────────────────────────────────────────────────────────────────
    // BYOK LLM-keys plane — gated /ggui/console/llm-keys. Two postures:
    //
    //   - `providerKeysGate: 'admin-token'` (default — OSS-personal):
    //     gate accepts the admin bearer. Single global keyset; the
    //     /settings UI lets the operator paste keys for everyone.
    //   - `providerKeysGate: 'auth-adapter'` (multi-tenant): gate
    //     calls the server's `AuthAdapter`. Each user's keys are
    //     scoped by `providerKeyScope` (default: `userId`/`appId`).
    //
    // Wire shape (same in both gates):
    //   GET    /ggui/console/llm-keys           — list providers + presence
    //   POST   /ggui/console/llm-keys           — set { provider, key }
    //   DELETE /ggui/console/llm-keys/:provider — clear (idempotent)
    //
    // Plaintext is NEVER returned on GET — unlike pairing tokens, an LLM
    // key is a one-way paste (operator already has the key elsewhere; the
    // server is just persisting it). The presence + source signal is
    // enough for the /settings UI.
    const providerKeysGateMode: "admin-token" | "auth-adapter" =
      opts.providerKeysGate ?? "admin-token";
    const mountLlmKeysRoute =
      opts.providerKeys !== undefined &&
      (providerKeysGateMode === "auth-adapter" || resolvedAdminToken !== null);
    if (mountLlmKeysRoute && opts.providerKeys) {
      const providerKeyStore = opts.providerKeys;
      const adminTokenForLlm = resolvedAdminToken;
      const defaultScope = (_req: Request, identity: AuthResult | null): string => {
        if (identity) {
          if (identity.identity.kind === "user") {
            return identity.identity.userId;
          }
          if (identity.identity.kind === "app") {
            return identity.identity.appId;
          }
        }
        return "global";
      };
      const scopeFromRequest = opts.providerKeyScope ?? defaultScope;
      const ADMIN_COOKIE_NAME_LLM = "ggui_console_admin";

      // The LLM_PROVIDERS allowlist matches `LlmProvider` minus `bedrock`
      // (which is IAM-based and never paste-resolvable — see byok-resolver
      // PROVIDER_ENV_NAMES bedrock note). Order is the operator-facing
      // display order: anthropic first since the OSS triad ships claude
      // as the default model.
      const LLM_PROVIDERS: ReadonlyArray<Exclude<LlmProvider, "bedrock">> = [
        "anthropic",
        "openai",
        "google",
        "openrouter",
      ];

      // Mirror of `byok-resolver.ts::PROVIDER_ENV_NAMES` — env-var name
      // ordered list per provider, first non-empty wins. Mirrored rather
      // than imported because `@ggui-ai/cli` is downstream of this
      // package and we can't depend back the other direction.
      const PROVIDER_ENV_NAMES: Readonly<
        Record<Exclude<LlmProvider, "bedrock">, readonly string[]>
      > = {
        anthropic: ["ANTHROPIC_API_KEY"],
        google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
        openai: ["OPENAI_API_KEY"],
        openrouter: ["OPENROUTER_API_KEY"],
      };

      const requestHasAdminAuthLlm = (req: Request): boolean => {
        if (adminTokenForLlm === null) return false;
        const authHeader = req.headers["authorization"];
        if (typeof authHeader === "string") {
          const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
          if (match && match[1] === adminTokenForLlm) return true;
        }
        const cookieHeader = req.headers["cookie"];
        if (typeof cookieHeader === "string") {
          for (const raw of cookieHeader.split(";")) {
            const trimmed = raw.trim();
            const eq = trimmed.indexOf("=");
            if (eq <= 0) continue;
            const name = trimmed.slice(0, eq);
            if (name !== ADMIN_COOKIE_NAME_LLM) continue;
            const value = decodeURIComponent(trimmed.slice(eq + 1));
            if (value === adminTokenForLlm) return true;
          }
        }
        return false;
      };

      // Per-request identity stash. Populated by the gate when in
      // 'auth-adapter' mode; left null under 'admin-token'. Route
      // handlers read it via `getRequestIdentity(req)` so the scope
      // resolver receives the resolved AuthResult without re-running
      // `resolveIdentity`.
      const llmKeysIdentityByRequest = new WeakMap<Request, AuthResult>();
      const getRequestIdentity = (req: Request): AuthResult | null =>
        llmKeysIdentityByRequest.get(req) ?? null;

      // Path-prefix gate.
      //
      //   admin-token → same shape as /keys (Bearer admin OR
      //                 ggui_console_admin cookie).
      //   auth-adapter → calls `resolveIdentity(auth, req)`. `kind:'builder'`
      //                  is rejected with 401 — the multi-tenant posture
      //                  is meaningless without a real per-caller id.
      app.use("/ggui/console/llm-keys", (req, res, next) => {
        if (providerKeysGateMode === "admin-token") {
          if (requestHasAdminAuthLlm(req)) return next();
          applyDevtoolSecurityHeaders(res);
          res.status(401).json({ error: "admin_auth_required" });
          return;
        }
        // 'auth-adapter' — the multi-tenant gate.
        resolveIdentity(auth, req)
          .then((identity) => {
            if (identity.identity.kind === "builder") {
              applyDevtoolSecurityHeaders(res);
              res.status(401).json({
                error: "tenant_required",
                message:
                  "Multi-tenant /llm-keys requires an end-user or app identity. " +
                  'The configured AuthAdapter resolved kind:"builder" — pair a ' +
                  'real user/app bearer or use providerKeysGate:"admin-token".',
              });
              return;
            }
            llmKeysIdentityByRequest.set(req, identity);
            next();
          })
          .catch((err: unknown) => {
            applyDevtoolSecurityHeaders(res);
            if (err instanceof UnauthenticatedError) {
              res.status(401).json({ error: "unauthenticated" });
              return;
            }
            logger.warn("console_llm_keys_auth_failed", { error: String(err) });
            res.status(500).json({ error: "auth_unexpected_error" });
          });
      });

      // GET /ggui/console/llm-keys — list providers + presence.
      // Each row reports:
      //   - name:       'anthropic' | 'openai' | 'google' | 'openrouter'
      //   - configured: boolean — true when EITHER env OR file has a key
      //   - source:     'env' | 'file' | null — env wins on collision
      //   - envName:    which env var fired (only present when source='env')
      //   - envNames:   the env-var names this provider accepts
      //                 (informational — the /settings UI shows them so
      //                 operators know they can `export` instead of pasting)
      app.get("/ggui/console/llm-keys", async (req, res) => {
        applyDevtoolSecurityHeaders(res);
        try {
          const scope = scopeFromRequest(req, getRequestIdentity(req));
          const filePresent = new Set(await providerKeyStore.listProviders(scope));
          // Build rows with an optional 12-char prefix preview so the
          // operator can confirm WHICH key is loaded without exposing
          // the secret. 12 chars covers the discriminating prefix
          // (`sk-ant-api03`, `sk-ant-oat01`, `sk-or-v1-…`, etc.) while
          // staying safely under the entropy floor — these prefixes
          // are not secret on their own.
          const rows = await Promise.all(
            LLM_PROVIDERS.map(async (provider) => {
              const envNames = PROVIDER_ENV_NAMES[provider];
              let envHit: string | undefined;
              let envValue: string | undefined;
              for (const name of envNames) {
                const value = process.env[name];
                if (value !== undefined && value.length > 0) {
                  envHit = name;
                  envValue = value;
                  break;
                }
              }
              const inFile = filePresent.has(provider);
              const source: "env" | "file" | null =
                envHit !== undefined ? "env" : inFile ? "file" : null;
              let keyPreview: string | undefined;
              if (envValue !== undefined) {
                keyPreview = envValue.slice(0, 12);
              } else if (inFile) {
                try {
                  const ref = await providerKeyStore.get(scope, provider);
                  if (ref) keyPreview = ref.key.slice(0, 12);
                } catch {
                  // Best-effort — preview is advisory; never block the GET.
                }
              }
              return {
                name: provider,
                configured: source !== null,
                source,
                ...(envHit !== undefined ? { envName: envHit } : {}),
                envNames: [...envNames],
                inFile,
                ...(keyPreview !== undefined ? { keyPreview } : {}),
              };
            })
          );
          res.json({
            providers: rows,
            scope,
          });
        } catch (err) {
          logger.warn("console_llm_keys_list_failed", {
            error: String(err),
          });
          res.status(500).json({
            error: "list_failed",
            message:
              err instanceof Error
                ? `LLM keys list failed — ${err.message}`
                : `LLM keys list failed — ${String(err)}`,
          });
        }
      });

      // POST /ggui/console/llm-keys — set a provider's key.
      // Body: { provider: 'anthropic'|'openai'|..., key: string }.
      // Returns: { provider, source: 'file', envOverridden: boolean }.
      // `envOverridden: true` means the operator pasted a key but env
      // var also set — the resolver still picks env. The /settings UI
      // surfaces this so operators don't think their paste is in effect.
      app.post("/ggui/console/llm-keys", async (req, res) => {
        applyDevtoolSecurityHeaders(res);
        const body = req.body as { provider?: unknown; key?: unknown } | undefined;
        const provider = typeof body?.provider === "string" ? body.provider : "";
        const key = typeof body?.key === "string" ? body.key.trim() : "";
        if (!LLM_PROVIDERS.includes(provider as never)) {
          res.status(400).json({
            error: "invalid_provider",
            message: `provider must be one of ${LLM_PROVIDERS.join(", ")}.`,
          });
          return;
        }
        if (key.length === 0 || key.length > 4096) {
          res.status(400).json({
            error: "invalid_key",
            message: "`key` is required (non-empty string, ≤4096 chars).",
          });
          return;
        }
        try {
          const typedProvider = provider as Exclude<LlmProvider, "bedrock">;
          const scope = scopeFromRequest(req, getRequestIdentity(req));
          await providerKeyStore.set(scope, typedProvider, key);
          const envNames = PROVIDER_ENV_NAMES[typedProvider];
          let envOverride: string | undefined;
          for (const name of envNames) {
            const value = process.env[name];
            if (value !== undefined && value.length > 0) {
              envOverride = name;
              break;
            }
          }
          res.json({
            provider: typedProvider,
            source: "file" as const,
            envOverridden: envOverride !== undefined,
            ...(envOverride !== undefined ? { envName: envOverride } : {}),
          });
        } catch (err) {
          logger.warn("console_llm_keys_set_failed", {
            error: String(err),
            provider,
          });
          res.status(500).json({
            error: "set_failed",
            message:
              err instanceof Error
                ? `LLM key set failed — ${err.message}`
                : `LLM key set failed — ${String(err)}`,
          });
        }
      });

      // DELETE /ggui/console/llm-keys/:provider — clear (idempotent).
      // 204 even when the key wasn't set; mirrors `ProviderKeyStore.delete`
      // contract. NEVER touches env — the operator owns env separately.
      app.delete("/ggui/console/llm-keys/:provider", async (req, res) => {
        applyDevtoolSecurityHeaders(res);
        const provider = req.params["provider"];
        if (!LLM_PROVIDERS.includes(provider as never)) {
          res.status(400).json({
            error: "invalid_provider",
            message: `provider must be one of ${LLM_PROVIDERS.join(", ")}.`,
          });
          return;
        }
        try {
          const typedProvider = provider as Exclude<LlmProvider, "bedrock">;
          const scope = scopeFromRequest(req, getRequestIdentity(req));
          await providerKeyStore.delete(scope, typedProvider);
          res.status(204).end();
        } catch (err) {
          logger.warn("console_llm_keys_delete_failed", {
            error: String(err),
            provider,
          });
          res.status(500).json({
            error: "delete_failed",
            message:
              err instanceof Error
                ? `LLM key delete failed — ${err.message}`
                : `LLM key delete failed — ${String(err)}`,
          });
        }
      });

      // POST /ggui/console/llm-keys/:provider/probe — auth-validation health
      // probe for the configured key. Hits each provider's cheapest
      // auth-checking endpoint with a 5s timeout. Status code is always
      // 200 — the `ok` flag carries the verdict so the UI can paint a dot
      // without branching on HTTP status. NEVER returns or logs the key
      // value (latency + ok-flag + provider name only).
      const probeProvider = async (
        provider: Exclude<LlmProvider, "bedrock">,
        key: string
      ): Promise<{
        ok: boolean;
        latencyMs: number;
        error?: string;
      }> => {
        const start = Date.now();
        const ac = new AbortController();
        const timer = setTimeout(() => {
          ac.abort();
        }, 5000);
        try {
          let url: string;
          const headers: Record<string, string> = {};
          if (provider === "anthropic") {
            url = "https://api.anthropic.com/v1/models?limit=1";
            headers["x-api-key"] = key;
            headers["anthropic-version"] = "2023-06-01";
          } else if (provider === "openai") {
            url = "https://api.openai.com/v1/models";
            headers["Authorization"] = `Bearer ${key}`;
          } else if (provider === "google") {
            // Google uses query-param key auth — no Authorization header.
            url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${encodeURIComponent(key)}`;
          } else {
            // openrouter — auth/key endpoint validates without listing.
            url = "https://openrouter.ai/api/v1/auth/key";
            headers["Authorization"] = `Bearer ${key}`;
          }
          const res = await globalThis.fetch(url, {
            method: "GET",
            headers,
            signal: ac.signal,
          });
          const latencyMs = Date.now() - start;
          if (res.ok) {
            return { ok: true, latencyMs };
          }
          let detail = "";
          try {
            const body = (await res.json()) as {
              error?: unknown;
              message?: unknown;
            };
            const errField = body.error;
            const errMessage =
              typeof errField === "string"
                ? errField
                : errField !== null &&
                    typeof errField === "object" &&
                    "message" in errField &&
                    typeof (errField as { message?: unknown }).message === "string"
                  ? (errField as { message: string }).message
                  : typeof body.message === "string"
                    ? body.message
                    : "";
            if (errMessage.length > 0) detail = ` ${errMessage}`;
          } catch {
            // Non-JSON body — error code alone is enough for the dot.
          }
          return {
            ok: false,
            latencyMs,
            error: `HTTP ${res.status}${detail}`.slice(0, 200),
          };
        } catch (err) {
          const latencyMs = Date.now() - start;
          return {
            ok: false,
            latencyMs,
            error: String(err).slice(0, 200),
          };
        } finally {
          clearTimeout(timer);
        }
      };

      app.post("/ggui/console/llm-keys/:provider/probe", async (req, res) => {
        applyDevtoolSecurityHeaders(res);
        const provider = req.params["provider"];
        if (!LLM_PROVIDERS.includes(provider as never)) {
          res.status(400).json({
            error: "invalid_provider",
            message: `provider must be one of ${LLM_PROVIDERS.join(", ")}.`,
          });
          return;
        }
        try {
          const typedProvider = provider as Exclude<LlmProvider, "bedrock">;
          // Resolve env-first-then-file, mirroring the GET handler's
          // source rule. Env wins on collision so the probe matches what
          // the generation pipeline would actually send.
          const envNames = PROVIDER_ENV_NAMES[typedProvider];
          let resolvedKey: string | null = null;
          for (const name of envNames) {
            const value = process.env[name];
            if (value !== undefined && value.length > 0) {
              resolvedKey = value;
              break;
            }
          }
          if (resolvedKey === null) {
            const scope = scopeFromRequest(req, getRequestIdentity(req));
            const ref = await providerKeyStore.get(scope, typedProvider);
            if (ref !== null && ref.key.length > 0) {
              resolvedKey = ref.key;
            }
          }
          if (resolvedKey === null) {
            res.status(400).json({ ok: false, error: "not_configured" });
            return;
          }
          const result = await probeProvider(typedProvider, resolvedKey);
          logger.info("console_llm_keys_probe", {
            provider: typedProvider,
            ok: result.ok,
            latencyMs: result.latencyMs,
          });
          res.json(result);
        } catch (err) {
          logger.warn("console_llm_keys_probe_failed", {
            error: String(err),
            provider,
          });
          res.status(500).json({
            error: "probe_failed",
            message:
              err instanceof Error
                ? `LLM key probe failed — ${err.message}`
                : `LLM key probe failed — ${String(err)}`,
          });
        }
      });
    }

    if (existsSync(consoleDistDir)) {
      // Read + stamp `<meta name="ggui-mode" content="dev|prod">` into
      // the SPA's `<head>` once at boot. The SPA's `mode.ts` reads the
      // meta synchronously on first paint so `TopNav` renders the
      // `/devtools` link without a `/info` round-trip flicker. Mode
      // changes require a server restart — same shape as every other
      // `CreateGguiServerOptions` field, no live-toggle ceremony.
      const indexPath = path.join(consoleDistDir, "index.html");
      const META_TAG = `<meta name="ggui-mode" content="${mode}">`;
      let indexHtml: string;
      try {
        const raw = readFileSync(indexPath, "utf-8");
        // Inject right after `<head>` so the meta is available before
        // any subsequent `<script>` tag executes. Idempotent: if a
        // previous build somehow already inlined the meta, the
        // injection still produces a valid (duplicate but harmless)
        // tag — `mode.ts` reads the first hit.
        indexHtml = raw.includes("<head>")
          ? raw.replace("<head>", `<head>${META_TAG}`)
          : raw.replace(/^/, `${META_TAG}\n`);
      } catch (err) {
        logger.warn("console_index_read_failed", {
          path: indexPath,
          error: String(err),
        });
        indexHtml = `<!doctype html><html><head>${META_TAG}</head><body></body></html>`;
      }
      const sendConsoleHtml = (res: Response): void => {
        applyDevtoolSecurityHeaders(res);
        res.type("text/html").send(indexHtml);
      };

      // Welcome HTML — server-rendered landing for `consolePath === '/'`
      // when the operator wires `welcomePage`. Identifies who runs
      // the server (operator block; entirely hidden when unset),
      // describes the public deep-link surfaces, and offers the
      // operator-login affordance. No JS, no SPA mount, same security
      // headers as `sendConsoleHtml`.
      const welcomePageOpts = opts.welcomePage;
      const welcomeEnabled = welcomePageOpts !== undefined && consolePath === "/";
      const sendWelcomeHtml = welcomeEnabled
        ? (res: Response): void => {
            applyDevtoolSecurityHeaders(res);
            res.type("text/html").send(renderWelcomeHtml(welcomePageOpts, info.name));
          }
        : null;

      // Onboarding redirect — must run BEFORE express.static, which
      // would otherwise serve `index.html` for `GET /` directly and
      // never give the SPA fallback (or this redirect) a chance.
      const landingRedirectFn =
        typeof opts.console === "object" ? opts.console.landingRedirect : undefined;
      app.get(consolePath, (req, res, next) => {
        // Static middleware fires on the trailing-slash variant when
        // consolePath !== '/'. Both shapes route here.
        if (req.path !== consolePath && req.path !== `${consolePath}/`) {
          return next();
        }
        if (landingRedirectFn) {
          const target = landingRedirectFn();
          if (target && target !== req.path) {
            res.redirect(302, target);
            return;
          }
        }
        if (sendWelcomeHtml) {
          sendWelcomeHtml(res);
          return;
        }
        sendConsoleHtml(res);
      });
      app.use(
        consolePath,
        express.static(consoleDistDir, {
          // index:false — explicit handler above owns `/` so the meta
          // tag gets injected. Without this, express.static would
          // race the handler and sometimes serve the raw file.
          index: false,
          // Short cache — operators iterating on their server want
          // fresh copies after a rebuild; production-hardening
          // (etag, long-term caching for /assets/*) is a slice-3 polish
          // concern.
          maxAge: 0,
          fallthrough: true,
          // Attach the console security header set to every
          // static response. `setHeaders` runs for successful hits
          // (HTML + JS + CSS + asset 200s); misses that fall through
          // to the SPA fallback below are covered by the fallback's
          // explicit `applyDevtoolSecurityHeaders` call.
          setHeaders: applyDevtoolSecurityHeaders,
        })
      );
      // Admin-HTML gate. The SPA's `/admin/*` and `/devtools/*` zones
      // are operator-only — without this gate, every admin page is a
      // GET away from anyone who guesses the path. The corresponding
      // JSON APIs already gate at `/ggui/console/keys`, but the SPA
      // shell itself was unauthenticated. Mounted only when the gate
      // shape is available (admin token resolved + closure built).
      //
      // 302 to `/admin-login?next=<encoded-path>` on miss — the login
      // page reads `next` from the query string and bounces back after
      // a successful token paste. No client-side cookie set here; the
      // existing `POST /ggui/console/admin-login` route owns minting.
      //
      // Scope:
      //   - GATED: `/admin/*`, `/devtools/*`
      //   - UNGATED: `/admin-login`, `/s/*`, `/preview/*`, `/` (welcome
      //     when wired, SPA index otherwise)
      //
      // The welcome page (`/`) is intentionally public — it's the
      // operator-identification surface, not an admin tool. Public
      // deep-link surfaces stay reachable: a session viewer URL
      // `/s/<shortCode>` and a blueprint preview URL `/preview/<id>`
      // are how end-users / blueprint authors land on the server.
      if (requestHasAdminAuthShared !== null) {
        const adminAuth = requestHasAdminAuthShared;
        app.get(/^\/(admin|devtools)(\/.*)?$/, (req, res, next) => {
          if (req.path === "/admin-login") return next();
          if (adminAuth(req)) return next();
          applyDevtoolSecurityHeaders(res);
          const next_ = encodeURIComponent(req.originalUrl || req.path);
          res.redirect(302, `/admin-login?next=${next_}`);
        });
      }

      // SPA fallback: the console client owns client-side routes
      // (`/`, `/s/<shortCode>`, `/admin/*`, `/devtools/*`). An unknown
      // sub-path under the mount must serve the rewritten
      // `index.html` so the React router takes over.
      //
      // Express 5 / path-to-regexp v8 rejects the bare `'*'` and
      // `'foo/*'` wildcard strings that worked in v6; named splats
      // (`{*splat}`) or RegExp patterns are required. Using RegExp
      // here matches the admin-gate pattern at L7738 above and
      // avoids the parser-version churn.
      const spaFallbackPattern =
        consolePath === "/"
          ? /^\/.*$/
          : new RegExp(`^${consolePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/.*$`);
      app.get(spaFallbackPattern, (req, res, next) => {
        // Only fallback for GET of non-asset, non-API paths.
        // `express.static` already served any asset that exists;
        // an `/assets/foo.js` that doesn't exist SHOULD 404 rather
        // than returning HTML.
        if (req.path.startsWith("/ggui/")) return next();
        if (req.path.startsWith(`${consolePath === "/" ? "" : consolePath}/assets/`)) {
          return next();
        }
        sendConsoleHtml(res);
      });
    } else {
      logger.warn("console_dist_missing", {
        distDir: consoleDistDir,
        hint: "Run `pnpm --filter @ggui-ai/console build` to produce the static bundle. Serving 503 from the mount point until the bundle exists.",
      });
      app.use(consolePath, (_req, res) => {
        applyDevtoolSecurityHeaders(res);
        res
          .status(503)
          .type("text/plain")
          .send("console bundle not built. Run:\n  pnpm --filter @ggui-ai/console build\n");
      });
    }
  }

  // Live-channel session endpoint. Defaults to disabled so consumers who
  // only want the tool plane get the smallest surface; CLIs (`ggui serve`,
  // hosted) enable it explicitly.
  //
  // Reserved-channel payload validators (Item 4 injection pattern): by
  // default the server binds the A2UI adapter for `_ggui:preview` so
  // malformed preview frames reject at the fan-out boundary instead of
  // landing in subscribers. `_ggui:contract-error` is validated via
  // `@ggui-ai/protocol`'s built-in regardless of this composition.
  // Operators passing `extraReservedValidators` override the default A2UI
  // entry on key conflict — otherwise the two maps merge layer-wise.
  const composedReservedValidators = mergeReservedValidators(
    composePreviewReservedValidator(),
    opts.extraReservedValidators
  );
  const channel: RenderChannelServer | null = opts.sessionChannel
    ? createRenderChannelServer({
        renderStore: renderStore ?? new InMemoryRenderStore(),
        auth,
        logger: logger.child({ component: "session-channel" }),
        path: typeof opts.sessionChannel === "object" ? opts.sessionChannel.path : undefined,
        streamBuffer:
          streamBuffer ??
          new InMemorySessionStreamBuffer() /* hoist guarantees non-null when opts.sessionChannel truthy; fallback only for TS narrowing */,
        ...(channelBootstrap ? { bootstrap: channelBootstrap } : {}),
        ...(consoleCookieAuth ? { cookieAuth: consoleCookieAuth } : {}),
        ...(opts.wiredActionRouter ? { wiredActionRouter: opts.wiredActionRouter } : {}),
        ...(opts.wiredActionTimeoutMs !== undefined
          ? { wiredActionTimeoutMs: opts.wiredActionTimeoutMs }
          : {}),
        // Opt-in channel_subscribe polling. Same options
        // object is also surfaced on every handshake response's
        // `serverCapabilities.streamWebSocketLocalTools` (via the
        // resolver wired into `createGguiHandshakeHandler` below) so
        // the iframe + server agree on the WS-fan-out vs.
        // iframe-poll-direct split per channel.
        ...(opts.streamWebSocketLocalTools
          ? { streamWebSocketLocalTools: opts.streamWebSocketLocalTools }
          : {}),
        ...(opts.sanitizeCausedBy ? { sanitizeCausedBy: opts.sanitizeCausedBy } : {}),
        ...(composedReservedValidators
          ? { extraReservedValidators: composedReservedValidators }
          : {}),
        ...(opts.versionPolicy !== undefined ? { versionPolicy: opts.versionPolicy } : {}),
        ...(opts.onFirstSubscriber ? { onFirstSubscriber: opts.onFirstSubscriber } : {}),
        ...(opts.onLastSubscriberGone ? { onLastSubscriberGone: opts.onLastSubscriberGone } : {}),
        // Shared TelemetrySink — bound once at composition so wired-
        // tool dispatches on the live channel emit `wired-tool.invoked`
        // telemetry alongside the existing server.composed signal.
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
  // composed N tools, pairing=…, threads=…, sessionChannel=…". Not
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
      sessionChannel: channel !== null,
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
    sessionChannel: channel,
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
            sessionChannel: channel ? channel.path : null,
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
 * 18-char URL-safe shortCode for `POST /ggui/console/blueprint/:id/try`
 * — visually distinct from the 16-char push-minted shortCodes in
 * `@ggui-ai/mcp-server-handlers/renders/push.ts` so operators
 * reading logs can tell a try-live session from an agent-pushed one
 * at a glance. Same confusable-free alphabet
 * (`[a-z0-9]` minus `1lI0Oo`) so the code stays hand-typable. Entropy
 * ≈ 18 × log₂(31) ≈ 89 bits.
 */
function generateTryLiveShortCode(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(18);
  let out = "";
  for (let i = 0; i < 18; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
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

/**
 * Resolve the resource path that `WWW-Authenticate` should point at
 * for the current request. Per-app `/mcp` requests
 * get `${pathPrefix}/${appId}` so RFC 9728 discovery resolves to the
 * per-app metadata; universal-route requests get `''` which collapses
 * back to the universal `${issuer}/.well-known/oauth-protected-resource`.
 *
 * Inputs:
 *   - `req` — the failed-auth Express request. We read `req.params`
 *     to detect the matched per-app route, falling through to the
 *     universal case on miss.
 *   - `opts` — full options bundle so we can read `perAppRouting`
 *     (paramName + pathPrefix) without threading a separate config arg.
 *
 * Defense in depth: even when `perAppRouting` is configured, we
 * reject empty or whitespace-only `appId` values rather than emitting
 * an obviously-wrong `${pathPrefix}//.well-known/...` URL — falling
 * back to universal is the safer behavior.
 */
function resolveWwwAuthResourcePath(req: Request, opts: CreateGguiServerOptions): string {
  if (opts.perAppRouting === undefined) return "";
  const { paramName, pathPrefix = "" } = opts.perAppRouting;
  const appId = req.params[paramName];
  if (typeof appId !== "string" || appId.length === 0) return "";
  return `${pathPrefix}/${appId}`;
}
