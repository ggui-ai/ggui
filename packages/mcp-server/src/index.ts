/**
 * @ggui-ai/mcp-server — open self-hosted MCP server for the ggui protocol.
 *
 * **Role**: thin HTTP/MCP binding layer.
 * Composes `@ggui-ai/mcp-server-handlers` (real handler logic) with
 * `@ggui-ai/mcp-server-core` in-memory reference adapters to produce a
 * runnable open server. No business logic lives here — if you need to
 * change tool behavior, edit the shared handler package.
 *
 * Zero-config boot:
 *
 * ```ts
 * import { createGguiServer } from '@ggui-ai/mcp-server';
 * const server = createGguiServer();
 * await server.listen(4567);
 * ```
 *
 * This package deliberately does NOT:
 *
 *   - embed AWS / DDB / Redis / cloud-specific wiring (those bind to
 *     `@ggui-ai/mcp-server-core` interfaces in separate adapter
 *     packages),
 *   - implement authoring / pairing / UI generation (those are separate
 *     packages + protocol flows).
 *
 * The `ggui serve` CLI command boots this server with the OSS defaults.
 */

export type { HandlerContext, SharedHandler } from '@ggui-ai/mcp-server-handlers';
// `StackItem` is the canonical session stack-item shape the OSS CLI
// composes when authoring no-credentials fallback cards. Re-exported
// here so embedders don't need a separate `@ggui-ai/protocol`
// dependency for the type alone.
export type {
  GadgetDescriptor,
  McpUiDisplayMode,
  SessionStackEntry,
  StackItem,
  SystemStackItem,
} from '@ggui-ai/protocol';
export type {
  GenerationCredentials,
  GenerationDeps,
} from '@ggui-ai/mcp-server-handlers';
// No-credentials fallback helpers — re-exported so the OSS CLI can
// build the no-credentials card stack item (pointing at the resolved
// `/settings` URL) without taking a direct `@ggui-ai/mcp-server-handlers`
// dependency.
export {
  NO_CREDENTIALS_SYSTEM_CARD_KIND,
  buildNoCredentialsStackItem,
} from '@ggui-ai/mcp-server-handlers';
export { createGguiServer, defaultHandlers } from './server.js';
export type {
  CreateGguiServerOptions,
  GguiServer,
} from './server.js';
// Content-addressable code delivery (2026-05-03). FileSystemCodeStore
// is the OSS dev default; in-memory variant ships in
// `@ggui-ai/mcp-server-core/in-memory` for tests + ephemeral runs.
export { FileSystemCodeStore } from './code-store-fs.js';
export type { FileSystemCodeStoreOptions } from './code-store-fs.js';
// Mount aggregation seam — lets external MCP tool bundles register
// on the OSS server path. `McpServerMount` pairs a diagnostic `name`
// with a `SharedHandler[]` bundle that registers alongside
// ggui-native tools on the same `/mcp` surface.
export type { McpServerMount } from './mcp-mounts.js';
export { composeWiredActionRouterFromMounts } from './mcp-mounts.js';
// Isolated MCP services. An `McpService` is a complete,
// self-contained MCP server mounted at its own HTTP path with its own
// tool namespace — distinct from `McpServerMount`, which contributes
// tools to the shared audience-filtered routes. Services bypass
// audience filtering (the path IS the audience).
export type { McpService, ServicePath } from './mcp-mounts.js';
export { validateMcpServices, validateServicePath } from './mcp-mounts.js';
// Reserved-channel payload validator composition.
// `composePreviewReservedValidator` binds the A2UI adapter
// for `_ggui:preview`; `mergeReservedValidators` layers caller-provided
// extras on top. `createGguiServer` composes these automatically —
// consumers that embed the session-channel server directly (via
// `createSessionChannelServer`) wire them up manually.
export {
  composePreviewReservedValidator,
  mergeReservedValidators,
} from './reserved-validators.js';
// Schema compatibility checker. Exposes the helper, the policy-mode
// type, the canonical error, and the default mode constant. Consumers
// embedding their own endpoint paths (custom hosted wrappers) can
// reuse the helper directly.
export {
  checkStackItemSchemaCompat,
  DEFAULT_SCHEMA_COMPAT_MODE,
  SchemaCompatError,
} from './schema-compat.js';
export type {
  SchemaCompatFinding,
  SchemaCompatMode,
  SchemaCompatReport,
  StackItemContractShape,
  ToolSchemaRef,
} from './schema-compat.js';
export type { ServerInfo } from './build-mcp.js';
export {
  UnauthenticatedError,
  DEFAULT_BUILDER_APP_ID,
  defaultAppIdFromIdentity,
} from './auth.js';
export { createConsoleLogger } from './logger.js';
export type { Logger } from './logger.js';
export {
  createSessionChannelServer,
  DEFAULT_SESSION_CHANNEL_PATH,
  DEFAULT_WIRED_TOOL_TIMEOUT_MS,
} from './session-channel.js';
export type {
  SessionChannelOptions,
  SessionChannelServer,
  WiredActionContext,
  WiredActionRouter,
} from './session-channel.js';
export { resolveStorageFromConfig } from './storage.js';
export type {
  ResolveStorageFromConfigOptions,
  ResolvedStorageStores,
} from './storage.js';
export {
  DEFAULT_PAIRING_ADMIN_INIT_PATH,
  DEFAULT_PAIRING_PATH,
  mountPairingTransport,
} from './pairing-transport.js';
export type { PairingTransportOptions } from './pairing-transport.js';
// End-user browser-session cookie + login routes. Cookie + endpoints
// are mounted automatically by `createGguiServer` when pairing is
// enabled; re-exported here so embedders composing custom transports
// can reuse the cookie shape directly.
export {
  USER_SESSION_COOKIE_NAME,
  DEFAULT_USER_SESSION_TTL_SEC,
  cookieAuthMiddleware,
  extractUserSessionCookie,
  formatUserSessionCookieHeader,
  formatClearUserSessionCookieHeader,
  readUserSessionCookie,
  readUserSessionCookieFromHeaders,
} from './user-session-auth.js';
export type { FormatUserSessionCookieInput } from './user-session-auth.js';
// Per-IP rate limit on `/pair`. Mounted automatically by
// `createGguiServer` when pairing is enabled. Re-exported so hosted
// bindings can swap in their own RateLimiter (Redis-backed,
// sliding-window, etc.) and reuse the middleware.
export {
  createPairLoginRateLimitMiddleware,
  resolveClientIp,
} from './rate-limit-middleware.js';
export type { PairLoginRateLimitOptions } from './rate-limit-middleware.js';
// Browser-session hardening: CSRF (double-submit, HMAC-bound to the
// session cookie), audit hooks (wired through
// `LoginRoutesOptions.auditSink`), and security headers
// (X-Frame-Options DENY, Referrer-Policy, X-Content-Type-Options).
// All three mount automatically.
export {
  CSRF_HEADER_NAME,
  CSRF_RESPONSE_HEADER_NAME,
  DEFAULT_CSRF_TOKEN_PATH,
  createCsrfMiddleware,
  mintCsrfToken,
  mountCsrfTokenRoute,
} from './csrf-middleware.js';
export type {
  CsrfMiddlewareOptions,
  MintCsrfTokenInput,
  MountCsrfTokenRouteOptions,
} from './csrf-middleware.js';
export { createSecurityHeadersMiddleware } from './security-headers-middleware.js';
export type { SecurityHeadersMiddlewareOptions } from './security-headers-middleware.js';
// OAuth login providers. Server mounts admin transport always +
// login routes when publicBaseUrl is set; operators paste
// credentials at /admin/oauth-providers and end-users sign in at
// /login via provider buttons.
export {
  composeOAuthUserId,
} from './oauth-login-types.js';
export type {
  OAuthLoginProvider,
  AuthorizeUrlInput,
  ExchangeCodeInput,
  OAuthExchangeResult,
  OAuthProviderConfigRecord,
  OAuthAuthResult,
} from './oauth-login-types.js';
export {
  DEFAULT_OAUTH_START_PATH,
  DEFAULT_OAUTH_CALLBACK_PATH,
  DEFAULT_OAUTH_PROVIDERS_LIST_PATH,
  OAUTH_PKCE_COOKIE_NAME,
  mountOAuthLoginRoutes,
} from './oauth-login.js';
export {
  DEFAULT_EMAIL_LOGIN_START_PATH,
  DEFAULT_EMAIL_LOGIN_VERIFY_PATH,
  DEFAULT_EMAIL_LOGIN_CONFIG_PATH,
  ConsoleEmailSender,
  InMemoryMagicLinkStore,
  mountEmailLoginRoutes,
} from './email-login.js';
export type {
  EmailSender,
  EmailMessage,
  MagicLinkStore,
  MagicLinkRecord,
  MintTokenInput,
  EmailLoginRoutesOptions,
} from './email-login.js';
export { ResendEmailSender } from './email-resend.js';
export type { ResendEmailSenderOptions } from './email-resend.js';
export { SmtpEmailSender } from './email-smtp.js';
export type { SmtpEmailSenderOptions } from './email-smtp.js';
export { selectEmailSenderFromEnv } from './email-sender-from-env.js';
export type {
  EmailSenderKind,
  EmailSenderSelection,
  SelectEmailSenderOptions,
} from './email-sender-from-env.js';
export {
  MCP_INSTRUCTIONS_PRESETS,
  resolveMcpInstructions,
} from './instructions-presets.js';
export type {
  McpInstructionsPreset,
  McpInstructionsValue,
} from './instructions-presets.js';
export type { OAuthLoginRoutesOptions } from './oauth-login.js';
export { googleLoginProvider } from './oauth-providers/google.js';
export type { GoogleLoginProviderOptions } from './oauth-providers/google.js';
export { githubLoginProvider } from './oauth-providers/github.js';
export type { GithubLoginProviderOptions } from './oauth-providers/github.js';
export { createOAuthProvidersStore } from './oauth-providers-store.js';
export type {
  OAuthProvidersStore,
  OAuthProvidersStoreOptions,
  PutInput as OAuthProvidersStorePutInput,
} from './oauth-providers-store.js';
export {
  DEFAULT_ADMIN_OAUTH_PROVIDERS_PATH,
  mountAdminOAuthProvidersTransport,
} from './admin-oauth-providers-transport.js';
export type { AdminOAuthProvidersTransportOptions } from './admin-oauth-providers-transport.js';
// Re-export the pairing types so CLI hosts threading
// `server.pairingService` out through their own handle shapes don't
// need a direct `@ggui-ai/mcp-server-core` dep.
export type {
  CompletePairingInput,
  Pairing,
  PairingCompletion,
  PairingInit,
  PairingService,
  PairingWithToken,
} from '@ggui-ai/mcp-server-core';
export {
  DEFAULT_BUILDER_OWNER_ID,
  DEFAULT_THREADS_PATH,
  defaultThreadOwnerFromIdentity,
  mountThreadTransport,
} from './thread-transport.js';
export type {
  ThreadOwnerResolver,
  ThreadTransportOptions,
} from './thread-transport.js';

// Zero-config in-memory reference for the console shortCode → session
// lookup. Re-exported here (alongside `createGguiServer`) so CLI hosts
// composing the OSS first-run path can pass one without taking a direct
// dep on `@ggui-ai/mcp-server-core`. For durable deployments the
// operator swaps in their own `ShortCodeIndex` implementation.
export { InMemoryShortCodeIndex } from '@ggui-ai/mcp-server-core/in-memory';
export type { ShortCodeIndex } from '@ggui-ai/mcp-server-core';

// In-memory reference AuthAdapter. Re-exported for the same reason as
// `InMemoryShortCodeIndex` — CLI hosts that want strict auth (no
// implicit `devAllowAll`) construct one with `devAllowAll: false` and
// pass it to `createGguiServer({ auth: ... })` without taking a direct
// `@ggui-ai/mcp-server-core` dep. `ggui serve` does this by default to
// keep its `/mcp` ingress honest; pair-minted tokens register through
// `onTokenIssued`.
export { InMemoryAuthAdapter } from '@ggui-ai/mcp-server-core/in-memory';
export type { InMemoryAuthAdapterOptions } from '@ggui-ai/mcp-server-core/in-memory';

// In-memory rate-limiter + quota-store reference adapters. Re-exported
// for the same reason as `InMemoryAuthAdapter` — CLI hosts can compose
// `--public-demo` posture (per-IP rate limit on ggui_push) without
// taking a direct `@ggui-ai/mcp-server-core` dep. The default fallback
// inside `createGguiServer` is `NoopRateLimiter`; this is the smallest
// non-trivial alternative.
export {
  FixedWindowRateLimiter,
  InMemoryQuotaStore,
} from '@ggui-ai/mcp-server-core/in-memory';
export type {
  FixedWindowRateLimiterOptions,
  InMemoryQuotaStoreOptions,
} from '@ggui-ai/mcp-server-core/in-memory';
export type { RateLimiter, QuotaStore } from '@ggui-ai/mcp-server-core';

// Manifest-backed blueprint provider.
// CLI hosts construct one from `discoverLocalUis()` results and pass it
// as `createGguiServer({ blueprintProvider: ... })` so every UI declared
// in `ggui.json#blueprints.include` surfaces through
// `ggui_list_featured_blueprints`. Re-exported here for the same reason
// as `InMemoryShortCodeIndex` — CLI hosts shouldn't need a direct
// `@ggui-ai/mcp-server-core` dep to compose the first-run server.
export { ManifestBlueprintProvider } from '@ggui-ai/mcp-server-core/in-memory';
export type {
  ManifestBlueprintSeed,
  ManifestBlueprintProviderOptions,
} from '@ggui-ai/mcp-server-core/in-memory';
export type { BlueprintProvider } from '@ggui-ai/mcp-server-core';

// Primitive-catalog shape. Re-exported alongside
// `ManifestBlueprintProvider` so CLI hosts threading the
// discovery output through `createGguiServer({ primitiveCatalogs })`
// don't need a direct `@ggui-ai/project-config/node` type import in
// addition to the one they already pull for runtime `discoverPrimitives`.
export type { DiscoveredPrimitiveCatalog } from '@ggui-ai/project-config/node';

// Theme shape. CLI hosts call
// `loadTheme()` from `@ggui-ai/project-config/node`, get a
// `LoadedTheme`, and thread it through
// `createGguiServer({ theme })` so `server.theme` reflects what the
// operator declared (or the shipped default when they didn't).
// Re-exported here for the same reason as the primitive types —
// CLI hosts compose the first-run server without needing a separate
// `@ggui-ai/project-config` type import.
export type { LoadedTheme } from '@ggui-ai/project-config/node';

// Operator-block shape — backing type for the welcome page surface
// `createGguiServer({ welcomePage: { operator } })`. Re-exported for
// the same reason as `LoadedTheme` / `DiscoveredPrimitiveCatalog`:
// CLI hosts thread `gguiJson.operator` through without needing a
// separate `@ggui-ai/project-config` type import.
export type { OperatorConfig } from '@ggui-ai/project-config';

// Theme picker writer seam — paired with the admin-gated
// `/ggui/console/theme` route. The server defines the callback
// shape but never touches the filesystem; the CLI provides the
// implementation that knows where `ggui.json` lives.
//
// Hosts that boot via `createGguiServer` directly (no manifest
// path) supply their own writer or omit the option entirely
// (POST returns 501 in that case).
export type {
  ThemeWriter,
  ThemeFileUploader,
} from './console-theme-routes.js';

// UiGenerator seam types — real generation is wired into `ggui_push`
// via the `generation` opt. Re-exported here so CLI
// hosts (`ggui-cli::buildMcpServerBackend`) and embedding hosts can
// compose the `GenerationDeps` bundle without a direct
// `@ggui-ai/mcp-server-core` dep. The concrete UiGenerator
// implementation ships in `@ggui-ai/ui-gen#createUiGenerator`.
export type {
  LlmProvider,
  LlmRoute,
  LlmSelection,
  ProviderKeyRef,
  UiGenerateEvent,
  UiGenerateInput,
  UiGenerateResult,
  UiGenerator,
  GeneratorTier,
  GeneratorRegistry,
  GeneratorSlugParts,
} from '@ggui-ai/mcp-server-core';

// Generator-registry helpers re-exported so callers composing a
// custom registry don't need a direct `@ggui-ai/mcp-server-core`
// import just for slug parsing.
export {
  formatGeneratorSlug,
  isValidGeneratorSlug,
  parseGeneratorSlug,
} from '@ggui-ai/mcp-server-core';
