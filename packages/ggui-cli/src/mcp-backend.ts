/**
 * `ggui serve` → `@ggui-ai/mcp-server` composition.
 *
 * Split out from `cli.ts` so tests can import the factory without
 * triggering the CLI `main()` side-effect at module load. The banner /
 * signal / lifecycle wiring stays in `cli.ts` / `serve-command.ts`;
 * this module owns exactly one thing: the option bundle that turns
 * `createGguiServer()` into the canonical OSS first-run server.
 *
 * What gets wired by default — see OSS-split §2 (the five server
 * responsibilities):
 *
 *   - `renderChannel: true` — live-channel `/ws` endpoint. Required for
 *     MCP Apps iframes AND the console render viewer.
 *   - `pairing: true` — `POST /pair` + `POST /admin/pair/init` so
 *     remote clients (Portal, third-party) can pair with this server.
 *     The default `InMemoryAuthAdapter` registers pairing tokens
 *     through `onTokenIssued` automatically.
 *   - `console: { sessionCookie: true }` — landing page at `/` +
 *     `/s/<shortCode>` viewer + same-origin HTTP-only cookie flow.
 *   - `shortCodeIndex: new InMemoryShortCodeIndex()` — required by
 *     the `sessionCookie` flow so `POST /ggui/console/session-cookie`
 *     can resolve a posted shortCode to the bound `{sessionId, appId}`.
 *     In-memory is correct for the OSS first-run: render state lives
 *     in memory unless the operator opts into sqlite, so a matching
 *     index lifetime is what operators expect.
 *   - `mcpApps: { wsUrl }` — registers the `ggui_render` tool with
 *     MCP Apps `_meta.ui.*` declaration, serves `ui://ggui/render`,
 *     and advertises the `io.modelcontextprotocol/ui` capability.
 *     `wsUrl` is the live-channel URL the spawned iframe subscribes
 *     to; resolved host + port are mandatory so it points back at
 *     this same process. See §2.4.1 "sole entry-point tool" lock
 *     in the OSS-split plan.
 *
 * Embedding hosts that want a different shape (no landing page, no
 * pairing, programmatic control) compose `createGguiServer()` directly
 * rather than going through `ggui serve`.
 */
import { listThemes } from "@ggui-ai/design/themes";
import { compileUiOnDemand } from "@ggui-ai/dev-stack";
import { createLocalEmbeddingProvider } from "@ggui-ai/embedding-local";
import { RUNTIME_BUNDLE_URL_PATH } from "@ggui-ai/iframe-runtime/server";
import {
  createGguiServer,
  FileSystemCodeStore,
  FixedWindowRateLimiter,
  InMemoryAuthAdapter,
  InMemoryQuotaStore,
  InMemoryShortCodeIndex,
  selectEmailSenderFromEnv,
  type BlueprintProvider,
  type DiscoveredPrimitiveCatalog,
  type EmailSender,
  type GadgetDescriptor,
  type GenerationDeps,
  type LoadedTheme,
  type McpServerMount,
  type McpUiDisplayMode,
  type OperatorConfig,
  type ResolvedStorageStores,
  type ShortCodeIndex,
  type ThemeWriter,
} from "@ggui-ai/mcp-server";
import {
  InMemoryAppMetadataStore,
  InMemoryBlueprintIndex,
  InMemoryVectorStore,
} from "@ggui-ai/mcp-server-core/in-memory";
import { PlaintextFileProviderKeyStore } from "@ggui-ai/mcp-server-core/plaintext";
import {
  createInstalledBlueprintsProvider,
  createStderrCacheTraceSink,
  setCacheTraceSink,
  type BlueprintPool,
  type CreateInstalledBlueprintsProviderOptions,
  type InstalledBlueprintCacheIssue,
  type InstalledBlueprintCompileResult,
  type InstalledBlueprintEntry,
} from "@ggui-ai/mcp-server-handlers/renders";
import { createDeterministicPreviewEmitter } from "@ggui-ai/preview-a2ui/emitters";
import type { UiManifest } from "@ggui-ai/project-config";
import type { UiRegistry } from "@ggui-ai/ui-registry";
import { existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { getCodeCacheDir, getCredentialsFile, getEmbeddingCacheDir } from "./paths.js";
import { readOrMintHexSecret } from "./persistent-secrets.js";
import type { ServeBackend } from "./serve-command.js";

export interface BuildMcpServerBackendOptions {
  /**
   * Pre-resolved storage from `ggui.json#storage`. Threaded straight
   * through to `createGguiServer`. Omit / leave fields undefined to
   * keep the server's in-memory defaults — no silent file creation
   * without an explicit declaration.
   */
  readonly storage?: ResolvedStorageStores;
  /**
   * Version string echoed in the CLI banner. Deliberately separate
   * from the server's own `info.version` (which still comes out of
   * `@ggui-ai/mcp-server`'s package.json) so the user sees which CLI
   * build launched the server.
   */
  readonly cliVersion: string;
  /**
   * Bind host used to compose the MCP Apps `wsUrl` and `runtime.url`.
   * Must be the same host the CLI then passes to `listen()`; otherwise
   * those URLs will point somewhere the iframe browser can't reach.
   */
  readonly host: string;
  /**
   * Bind port used to compose the MCP Apps URLs. MUST be a concrete
   * port (not `0`) — the iframe-facing URLs (`wsUrl`, `runtime.url`)
   * are captured at composition time, so deferring to an OS-assigned
   * port would leave them pointing at the wrong port. Callers that
   * started with `--port 0` should pre-resolve a free port via
   * {@link pickFreePort} before constructing the backend.
   */
  readonly port: number;
  /**
   * Pre-constructed blueprint provider — the CLI builds one from
   * `ggui.json#blueprints.include` (via `discoverLocalUis` +
   * `ManifestBlueprintProvider`) and threads it through so
   * `ggui_list_featured_blueprints` surfaces every declared UI.
   * Omitted = provider-less server (`ggui_list_featured_blueprints`
   * returns an empty catalog, matching pre-Phase-4 behavior).
   */
  readonly blueprintProvider?: BlueprintProvider;
  /**
   * UI registry consulted by `ggui_render_blueprint`. The CLI pairs
   * this with `blueprintProvider` at boot — same manifest source,
   * two complementary seams (provider for metadata / list / search,
   * registry for compiled bundle resolution). OSS uses
   * `@ggui-ai/dev-stack::LocalUiRegistry` (compile-on-demand via
   * esbuild). Omitted = `ggui_render_blueprint` is NOT registered on
   * this server (no throwing shim; the tool is simply absent from
   * `tools/list`).
   */
  readonly uiRegistry?: UiRegistry;
  /**
   * Primitive catalogs resolved from
   * `ggui.json#primitives.{packages,local}` by
   * `discoverPrimitives()` in `@ggui-ai/project-config/node`. Passed
   * through to `createGguiServer` so `server.primitiveCatalogs`
   * reflects what the operator declared. Omitted = programmatic hosts
   * / tests that don't need a primitive index — the server handle
   * exposes an empty array in that case.
   */
  readonly primitiveCatalogs?: readonly DiscoveredPrimitiveCatalog[];
  /**
   * Theme resolved from `ggui.json#theme` by `loadTheme()` in
   * `@ggui-ai/project-config/node`. Threaded through to
   * `createGguiServer({ theme })` so `server.theme` reflects what
   * the operator declared. Omitted = programmatic hosts / tests
   * that didn't load a theme — the server handle surfaces its own
   * `lightTheme`-backed `LoadedTheme` default in that case.
   */
  readonly theme?: LoadedTheme;
  /**
   * Theme writer for the admin-gated `/ggui/console/theme` POST.
   * Mounted only when present — the server returns 501 on Save when
   * the writer is omitted (programmatic hosts / `--mcp-only` mode
   * with no manifest). The CLI builds this from
   * `manifestPath` via {@link createThemeWriter} when a `ggui.json`
   * is on disk.
   */
  readonly themeWriter?: ThemeWriter;
  /**
   * Live theme getter — when set, supersedes the static `theme`
   * resolution for every `ggui_render` bootstrap envelope. The CLI
   * pairs this with `onThemeConfigChange` so a console save
   * reaches the next render without a server restart.
   */
  readonly themeProvider?: () =>
    | {
        readonly id?: string;
        readonly mode?: "light" | "dark";
      }
    | undefined;
  /**
   * Optional change notifier — fires from
   * `mountDevtoolThemeRoutes`'s POST handlers when the operator
   * saves a new theme via the picker. Pair with `themeProvider` so
   * the render handler reads the live theme on every call.
   */
  readonly onThemeConfigChange?: (
    next:
      | string
      | { preset: string; mode?: "light" | "dark"; overrides?: Record<string, string> }
      | { file: string; mode?: "light" | "dark" }
      | null
  ) => void;
  /**
   * Generation wiring for `ggui_render`. When present, the OSS render
   * handler invokes the bound `UiGenerator` on every story-path
   * call and commits real componentCode as a `GguiSession`. Absent =
   * placeholder mode: render mints sessionIds + shortCodes but does
   * not produce componentCode.
   *
   * The CLI resolves this from the operator's BYOK state at boot via
   * {@link probeGenerationBinding} — env (`ANTHROPIC_API_KEY` etc.)
   * first, then `~/.ggui/credentials.json`. Programmatic hosts
   * embedding `buildMcpServerBackend` directly supply their own
   * `GenerationDeps` bundle (real BYOK in a hosted multi-tenant
   * setting, a test double, etc.).
   */
  readonly generation?: GenerationDeps;

  /**
   * Read-only shared/seed blueprint pools for cross-deployment reuse.
   * Threaded into the handshake negotiator's `seedPools`. Built by the
   * CLI from `--seed-pool` artifacts; absent ⇒ no shared pool.
   */
  readonly seedPools?: readonly BlueprintPool[];

  /**
   * Marketplace-install bridge data. When set, the backend
   * constructs an
   * {@link InstalledBlueprintsProvider} rooted on the same
   * `embedding` + `vectorStore` the matcher consumes, and merges it
   * into `generation.installedBlueprints`. On the first
   * `matchBlueprint` call per scope, every entry with a contract is
   * compiled (esbuild) and registered into the cache with
   * `source: {kind: 'user'}` + the `installed` lifecycle marker — so
   * installed blueprints accelerate render the way cold-gen-cached
   * ones do.
   *
   * Caller is responsible for filtering `entries` to actual
   * marketplace installs (typically: discovered UIs whose
   * `manifestPath` lives under `.ggui/installed-blueprints/`). Hand-
   * authored UIs are intentionally excluded today.
   */
  readonly installedBlueprints?: {
    readonly projectRoot: string;
    readonly entries: ReadonlyArray<{
      readonly id: string;
      readonly manifestPath: string;
      readonly manifest: UiManifest;
    }>;
  };

  /**
   * External MCP tool-handler bundles to aggregate onto `/mcp`.
   * Threaded straight through to `createGguiServer({ mcpMounts })`;
   * see that option's JSDoc for shape + collision rules.
   *
   * The `ggui serve` CLI today does NOT surface a `ggui.json` field
   * for this — there's no config loader yet. Programmatic hosts and
   * integration-test fixtures compose mounts directly via
   * `buildMcpServerBackend({ mcpMounts: [...] })`.
   */
  readonly mcpMounts?: ReadonlyArray<McpServerMount>;

  /**
   * Switch the in-memory auth adapter to `devAllowAll: true`. Every
   * non-empty bearer (including the no-bearer probe MCP custom
   * connectors send) authenticates as builder. Local-dev / tunnel-
   * smoke escape hatch only — pairing or a custom `AuthAdapter` is
   * the production answer. Surface = `--dev-allow-all` CLI flag.
   *
   * Default `false` keeps the strict-auth posture (every bearer
   * must be pair-minted).
   */
  readonly devAllowAll?: boolean;

  /**
   * Public-demo posture. Same auth-adapter shape as `devAllowAll`
   * (every bearer authenticates as builder) but additionally:
   *   - Wires a per-remote-IP `FixedWindowRateLimiter` over an
   *     `InMemoryQuotaStore` (default 30 generations / 10 minutes per
   *     IP). The limiter binds at `ggui_render` so end-user generations
   *     can't burn the operator's BYOK budget.
   *   - The CLI banner displays "PUBLIC DEMO" copy with a cost-
   *     attribution + rate-limit note (vs. "DEV ALLOW-ALL" warning).
   *
   * Mutually exclusive with `devAllowAll`; the CLI rejects both at
   * parse time. Surface = `--public-demo` CLI flag.
   */
  readonly publicDemo?: boolean;

  /**
   * Multi-tenant posture. Switches the `/ggui/console/llm-keys` gate
   * from admin-token to auth-adapter — each authenticated end-user
   * manages their OWN provider keys (scope = `userId` for `kind:'user'`
   * identities, `appId` for `kind:'app'`). `kind:'builder'` identities
   * are rejected at the gate; multi-tenant is meaningless without a
   * real per-caller id.
   *
   * Strict-auth shape — every bearer must clear the `AuthAdapter`
   * (pairing-minted, OIDC, Cognito, or whatever the embedding host
   * binds). Mutually exclusive with `devAllowAll` and `publicDemo`;
   * the CLI rejects combinations at parse time. Surface =
   * `--multi-tenant` CLI flag.
   */
  readonly multiTenant?: boolean;

  /**
   * Public base URL that replaces `http://<host>:<port>` when
   * composing `mcpApps.wsUrl` and `runtime.url`. Set this when the
   * server is being reached through a tunnel (cloudflare, ngrok, …)
   * so URLs the iframe receives resolve from the MCP host's
   * perspective rather than `localhost`.
   *
   * Required shape: `http://…` or `https://…`, no trailing slash.
   * The `wsUrl` is derived by replacing the scheme with `ws`/`wss`.
   * Surface = `--public-base-url <url>` CLI flag.
   */
  readonly publicBaseUrl?: string;

  /**
   * Path to a JSON file backing the in-memory pairing service. When
   * set, paired bearer tokens survive `ggui serve` restarts — claude.ai
   * (and any other MCP client) stays connected without re-pairing.
   * Stored in plaintext at the path with `0600` perms; assume the
   * file lives on operator-controlled disk.
   *
   * Surface = `--keys-file <path>` CLI flag. Default ephemeral when
   * absent (current behavior).
   */
  readonly keysFile?: string;

  /**
   * Mount the OAuth 2.1 + PKCE + Dynamic Client Registration routes.
   * Required for MCP custom-connector hosts (claude.ai, ChatGPT) whose
   * "Add connector" form has no field for a pre-shared bearer.
   *
   * The full flow lives in `@ggui-ai/mcp-server::oauth.ts`; here we
   * just forward `oauth: true` to `createGguiServer` so the server
   * mounts `.well-known/oauth-*` + `/oauth/{authorize,token,register}`.
   * Defaults (in-memory storage, paste-key consent page) are right for
   * single-replica dev. Programmatic embedders that need a custom
   * `OAuthConfig` (storage seam, external consent UI) compose
   * `createGguiServer({oauth: <config>})` directly.
   *
   * Surface = `--oauth` CLI flag.
   */
  readonly oauth?: boolean;

  /**
   * Server-level MCP instructions preset. Threaded straight through
   * to `createGguiServer({mcpInstructions})`. Falls back to the
   * `GGUI_MCP_INSTRUCTIONS` env var when absent. Both absent =
   * `createGguiServer`'s no-preset default (`'aggressive'`).
   *
   * Surface = `--mcp-instructions <preset>` CLI flag or
   * `GGUI_MCP_INSTRUCTIONS` env var (CLI flag wins).
   */
  readonly mcpInstructions?: "default" | "aggressive" | "always" | "minimal" | "off";

  /**
   * Directory backing the cross-restart persistence bundle. When set,
   * `wsTokenSecret` is read from / minted into a 0600-mode file there
   * so the HMAC key survives `ggui serve` restart — claude.ai
   * chat-history revisits keep their cached
   * `_meta["ai.ggui/render"].wsToken` valid across reboots.
   *
   * Absent / undefined = the legacy ephemeral behavior (every restart
   * mints fresh secrets; cached tokens fail HMAC verify). The CLI sets
   * this to `getPersistentDir(projectRoot)` by default and skips when
   * `--ephemeral` is passed.
   */
  readonly persistentDir?: string;

  /**
   * Pre-resolved `ShortCodeIndex` implementation. When set, replaces
   * the default `InMemoryShortCodeIndex` — e.g. a `SqliteShortCodeIndex`
   * rooted under `persistentDir` so cached `/api/bootstrap/<code>` URLs
   * keep resolving after a `ggui serve` restart. With the in-memory
   * default the index is process-local and every restart turns prior
   * shortCodes into 404s — defeating the bootstrap-secret persistence
   * above.
   *
   * Absent = `InMemoryShortCodeIndex` (the default, fine for tests +
   * `--ephemeral`).
   */
  readonly shortCodeIndex?: ShortCodeIndex;

  /**
   * Operator-pinned admin token gating the console `/keys` plane.
   * When omitted, the server mints a fresh `ggui_admin_*` token on
   * boot and surfaces it via `GguiServer.adminToken`. The CLI banner
   * prints whichever value ended up in effect so the operator can
   * paste it into `/admin-login`.
   *
   * Surface = `--admin-token <token>` CLI flag.
   */
  readonly adminToken?: string;

  /**
   * Server-rendered public welcome page at `/`. Identifies who runs
   * the server (operator block, hidden when nothing configured)
   * and links to the public deep-link surfaces + operator login.
   *
   * The CLI's `serve-command.ts` resolves this from
   * `ggui.json#operator` + `ggui.json#app.name`. Programmatic hosts
   * pass whatever fits their context. Omitted = no welcome page;
   * the SPA index handler still owns `/`.
   */
  readonly welcomePage?: {
    readonly operator?: OperatorConfig;
    readonly appName?: string;
  };

  /**
   * Per-app gadget catalog from `ggui.json#app.gadgets`.
   * Gadgets (Leaflet, Mapbox, …) declared
   * here populate `App.gadgets` so the
   * `assertGadgetsRegistered` validator (render, ops_register,
   * ops_generate) accepts contracts that reference them.
   *
   * Omitted ⇒ `STDLIB_GADGETS` defaults from
   * `@ggui-ai/protocol` apply (the 7 first-party hooks).
   */
  readonly gadgets?: readonly GadgetDescriptor[];

  /**
   * Operator-stamped public env channel from
   * `ggui.json#app.publicEnv`. Each key MUST match
   * `^GGUI_PUBLIC_APP_[A-Z0-9_]+$`. The server projects only the keys
   * that some registered wrapper's `requires` references, onto
   * `_meta["ai.ggui/render"].publicEnv` and ultimately
   * `globalThis.__ggui__.publicEnv` for `getPublicEnv()` to read.
   *
   * Omitted ⇒ field absent on the App record (no values projected;
   * wrappers without `requires` still mount, wrappers with `requires`
   * fail at render-gate validation).
   */
  readonly publicEnv?: Readonly<Record<string, string>>;

  /**
   * Per-app default display-mode hint from
   * `ggui.json#app.defaultDisplayMode`. Stamped on every `ggui_render`
   * via `_meta.ui.displayMode` so the host knows whether to present
   * the iframe inline, fullscreen, or picture-in-picture. See
   * `App.defaultDisplayMode` for the full semantics.
   */
  readonly defaultDisplayMode?: McpUiDisplayMode;
}

/**
 * Pick a free localhost TCP port by letting the OS assign one on a
 * throwaway listener. Close the listener immediately and return the
 * chosen number. Exported so the CLI (`cli.ts::runServeCommand`) and
 * the integration tests can resolve `--port 0` to a concrete port
 * BEFORE constructing the backend — {@link buildMcpServerBackend}
 * captures the port in the composed `mcpApps.wsUrl` / `runtime.url`
 * at construction time, so the caller must know it up-front.
 *
 * Tiny race window: another process could claim the port between our
 * `close()` and the caller's `listen()`. The CLI surfaces bind errors
 * as a fatal exit; the OSS first-run path recovers by re-running.
 */
export function pickFreePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", (err) => {
      probe.close();
      reject(err);
    });
    probe.listen(0, host, () => {
      const addr = probe.address();
      if (addr === null || typeof addr === "string") {
        probe.close();
        reject(new Error(`pickFreePort: could not resolve a free port (got ${String(addr)})`));
        return;
      }
      const chosen = addr.port;
      probe.close(() => resolve(chosen));
    });
  });
}

/**
 * Build the `ServeBackend` that `runServe` drives. Returns a thin
 * adapter around `createGguiServer` — the factory is invoked here so
 * preconditions that throw (e.g. missing auth bridge support for
 * `pairing: true`) surface synchronously, before `runServe` bothers
 * binding a port.
 */
export function buildMcpServerBackend(opts: BuildMcpServerBackendOptions): ServeBackend {
  const storage: ResolvedStorageStores = opts.storage ?? {};
  if (!Number.isInteger(opts.port) || opts.port <= 0 || opts.port > 65535) {
    throw new Error(
      `buildMcpServerBackend: \`port\` must be a concrete TCP port (1..65535), got ${opts.port}. Resolve \`--port 0\` via pickFreePort() before composing.`
    );
  }
  // `baseUrl` feeds `runtime.url`; `wsBaseUrl` feeds `mcpApps.wsUrl`.
  // With `--public-base-url`, both derive from the operator-provided
  // tunnel URL so the URLs the iframe receives resolve from the remote
  // host's perspective. Without it, both fall back to the local bind.
  // The shape was validated at flag-parse time (`http://`/`https://`,
  // no trailing slash); we just substitute the scheme for ws/wss to
  // derive the live-channel URL.
  const baseUrl = opts.publicBaseUrl ?? `http://${opts.host}:${opts.port}`;
  const wsBaseUrl = baseUrl.replace(/^http(s?):\/\//, "ws$1://");
  // Strict-auth OSS default (`devAllowAll: false`). `createGguiServer`
  // would otherwise fall back to `InMemoryAuthAdapter({ devAllowAll:
  // true })`, which authenticates any non-empty bearer as builder — a
  // permissive seam that makes the `/mcp` ingress indistinguishable
  // from "no auth at all" for operators running `ggui serve`. Pairing
  // is on by default (see `pairing: true` below), so the honest
  // first-run story is: mint an initial pair code → complete `/pair`
  // → use the resulting token. The CLI surfaces that initial code as
  // the `PAIR_CODE` boot beacon + banner line; see `runServe` in
  // `./serve-command.ts`.
  //
  // `--dev-allow-all` flips this to `true` for local-dev / tunnel
  // smoke against MCP custom connectors that probe `/mcp` without
  // bearer (claude.ai, ChatGPT). The banner prints a loud warning
  // and pair-code emission is suppressed (meaningless under allow-all)
  // so operators don't accidentally take the dev posture to production.
  // `--public-demo` shares the auth shape with `--dev-allow-all`
  // (every bearer = builder). The CLI guarantees these are mutually
  // exclusive at parse time; only one is ever true here.
  const auth = new InMemoryAuthAdapter({
    devAllowAll: (opts.devAllowAll ?? false) || (opts.publicDemo ?? false),
  });
  // Per-IP rate limiter — only bound under `--public-demo` so an
  // anonymous visitor can't burn the operator's BYOK budget by pumping
  // ggui_render. Defaults: 30 generations / 10 minutes per IP. Operators
  // who need different ceilings construct their own backend
  // programmatically (calling `createGguiServer({ rateLimiter })`
  // directly). Skipped under `--dev-allow-all` because that's the
  // single-operator escape hatch where rate limits add noise without
  // protection.
  const rateLimiter = opts.publicDemo
    ? new FixedWindowRateLimiter({
        store: new InMemoryQuotaStore(),
        limit: 30,
        windowMs: 10 * 60 * 1000,
      })
    : undefined;
  // Local-transformer embedder default. Replaces the server's
  // `MockEmbeddingProvider` last-resort fallback for the user-facing
  // OSS path. `bge-small-en-v1.5` (~33MB ONNX) downloads lazily into
  // `~/.ggui/models/` on first embed; `cacheDir` resolves to that
  // path via the CLI's own paths helper. `warmup: true` (the default
  // inside the provider) embeds a dummy string after the pipeline
  // first loads so the first real embedding doesn't pay the ~200-
  // 400ms transformers cold-start tax.
  //
  // Programmatic embedders calling `createGguiServer` directly still
  // get `MockEmbeddingProvider` if they don't bind an embedder — that
  // keeps the 60MB `@huggingface/transformers` install surface off
  // the unit-test path.
  const embeddingCacheDir = getEmbeddingCacheDir();
  const embedding = createLocalEmbeddingProvider({
    cacheDir: embeddingCacheDir,
  });
  // One-line boot log of which embedding provider is live, so a captured
  // serve log makes real-model-vs-mock unambiguous. The local provider
  // loads `bge-small-en-v1.5` lazily; we then fire a best-effort warmup
  // probe (one `embed`) so the model is downloaded/loaded before the
  // first real lookup AND a load failure (e.g. missing
  // `@huggingface/transformers` peer dep) is surfaced as a clear
  // fallback warning rather than a silent first-lookup degradation.
  // eslint-disable-next-line no-console -- one-shot boot signal, mirrors banner output
  console.warn(`[ggui:embedding] local ${embedding.id} (cache: ${embeddingCacheDir})`);
  embedding.embed("warmup").catch((err: unknown) => {
    const reason = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console -- one-shot boot signal; local model unavailable
    console.warn(
      `[ggui:embedding] MockEmbeddingProvider fallback — local model unavailable: ${reason}`
    );
  });
  // BYOK provider-key store — same `~/.ggui/credentials.json` that
  // `byok-resolver.ts` reads on every `resolve()`. Threading the store
  // here makes the operator-facing `/ggui/console/llm-keys` admin API
  // write to the same file generation later reads, with no in-process
  // sync needed (`PlaintextFileProviderKeyStore` re-reads on every
  // `get()`). Operators who set `GGUI_CONFIG_DIR` for a clean-room get
  // the override automatically via `getCredentialsFile()`.
  const providerKeys = new PlaintextFileProviderKeyStore({
    filename: getCredentialsFile(),
  });
  // Email-login sender selection. Reads `GGUI_EMAIL_SENDER`
  // (default: `console`) and provider-specific env vars
  // (`RESEND_API_KEY`, `SMTP_URL` / `SMTP_HOST` + auth, etc.). Misconfig
  // (e.g. `=resend` without `RESEND_API_KEY`) logs a warning and falls
  // back to console rather than crashing — the rest of the server still
  // boots and operators can fix the env without losing other surfaces.
  // Programmatic embedders that want a different shape compose
  // `createGguiServer({emailLogin: {sender: ...}})` directly.
  const emailSenderSelection = selectEmailSenderFromEnv();
  let emailSender: EmailSender;
  let emailFromAddress: string;
  const defaultFromAddress = "ggui-serve <noreply@localhost>";
  if (emailSenderSelection.kind === "ok") {
    emailSender = emailSenderSelection.sender;
    emailFromAddress = emailSenderSelection.fromAddress ?? defaultFromAddress;
  } else {
    // eslint-disable-next-line no-console -- one-shot boot warning, mirrors banner output
    console.warn(
      `[ggui-cli] email-login: ${emailSenderSelection.reason}; falling back to ConsoleEmailSender (magic links print to terminal).`
    );
    const fallback = selectEmailSenderFromEnv({
      env: { GGUI_EMAIL_SENDER: "console" },
    });
    if (fallback.kind !== "ok") {
      throw new Error(
        `[ggui-cli] email-login: console fallback selection failed: ${fallback.reason}`
      );
    }
    emailSender = fallback.sender;
    emailFromAddress = process.env.GGUI_EMAIL_FROM?.trim() || defaultFromAddress;
  }
  // Resolve cross-restart HMAC secrets. When the caller declared a
  // persistent dir, read-or-mint `ws-token-secret.hex` +
  // `render-signer-secret.hex` (32 bytes / 64 hex chars, 0600). Both
  // get threaded into `createGguiServer` below so the server stops
  // minting fresh process-local secrets every boot — the precondition
  // for any cached `_meta["ai.ggui/render"].wsToken` surviving a
  // restart. Absent dir = legacy ephemeral behavior.
  let persistedWsTokenSecret: string | undefined;
  let persistedRenderSignerSecret: string | undefined;
  if (opts.persistentDir !== undefined) {
    persistedWsTokenSecret = readOrMintHexSecret(join(opts.persistentDir, "ws-token-secret.hex"));
    persistedRenderSignerSecret = readOrMintHexSecret(
      join(opts.persistentDir, "render-signer-secret.hex")
    );
  }
  // Resolve mcpInstructions: CLI flag wins over env var. Validated
  // env-var values pass through to createGguiServer; invalid values
  // fall through to the no-preset default with a one-line warning.
  const envInstructions = process.env.GGUI_MCP_INSTRUCTIONS?.trim();
  let resolvedMcpInstructions: "default" | "aggressive" | "always" | "minimal" | "off" | undefined =
    opts.mcpInstructions;
  if (resolvedMcpInstructions === undefined && envInstructions) {
    if (
      envInstructions === "default" ||
      envInstructions === "aggressive" ||
      envInstructions === "always" ||
      envInstructions === "minimal" ||
      envInstructions === "off"
    ) {
      resolvedMcpInstructions = envInstructions;
    } else {
      // eslint-disable-next-line no-console -- one-shot boot warning
      console.warn(
        `[ggui-cli] GGUI_MCP_INSTRUCTIONS='${envInstructions}' not recognized; falling back to default preset.`
      );
    }
  }

  // Per-app metadata store seeded from `ggui.json#theme.preset` (when
  // the manifest declares a preset variant). Single-tenant OSS: any
  // appId the handlers see picks up this default theme via
  // `InMemoryAppMetadataStore.get`'s defaults fall-through. File-mode
  // themes don't have a registry id to surface here — agents pick from
  // `listThemes()` either way; the file-mode override only affects the
  // server's bound `theme` (rendered CSS variables), not the
  // render/handler-side `themeId` chain.
  const manifestThemePreset = opts.theme?.source === "preset" ? opts.theme.preset : undefined;
  const appMetadataStore = new InMemoryAppMetadataStore({
    ...(manifestThemePreset !== undefined ? { defaultThemeId: manifestThemePreset } : {}),
    // `ggui.json#app.gadgets` declarations (Leaflet, Mapbox, …). When
    // omitted, the InMemoryAppMetadataStore falls back to
    // STDLIB_GADGETS from @ggui-ai/protocol so the first-party hooks
    // remain available without explicit declaration. The constructor
    // expects this on `defaultGadgets`, not `gadgets`.
    ...(opts.gadgets !== undefined && opts.gadgets.length > 0
      ? { defaultGadgets: opts.gadgets }
      : {}),
    // `ggui.json#app.publicEnv` operator-stamped values for wrapper
    // hooks to read via `getPublicEnv()`. The render gate
    // (`assertPublicEnvSatisfied`) verifies every declared wrapper's
    // `requires` keys are present in this map BEFORE the iframe boots.
    ...(opts.publicEnv !== undefined && Object.keys(opts.publicEnv).length > 0
      ? { defaultPublicEnv: opts.publicEnv }
      : {}),
    // `ggui.json#app.defaultDisplayMode`. Stamped per-render as
    // `_meta.ui.displayMode`; controls only host-side presentation.
    ...(opts.defaultDisplayMode !== undefined
      ? { defaultDisplayMode: opts.defaultDisplayMode }
      : {}),
  });

  // Materialize the vectorStore here so the marketplace-install
  // bridge writes into the SAME instance the matcher reads. Without
  // this, calling `createGguiServer({ vectors })`
  // when no `storage.vectors` is declared leaves vectorStore
  // construction inside the server, hidden from us, so the provider
  // would have no handle to register into. Mint an `InMemoryVectorStore`
  // here on the absent-storage path; threaded back as `vectors` to
  // `createGguiServer` so server + provider share state.
  const vectorStore = storage.vectors ?? new InMemoryVectorStore();

  // Blueprint identity index — minted here so the install bridge's
  // provider deps and the server share ONE instance (the server's
  // ref-equality guard enforces this, same as `vectorStore`). The index
  // is rebuildable from vector-store metadata and self-heals at the read
  // site, so an in-memory index is safe even alongside a persistent
  // `storage.vectors`; a persistent index can be threaded later via the
  // same seam.
  const blueprintIndex = new InMemoryBlueprintIndex();

  // Construct the marketplace-install bridge BEFORE `createGguiServer`
  // so we can fold it into `opts.generation.installedBlueprints` below.
  // Per design lock (project_slices_5_6_7_plan.md), the provider
  // lazily compiles every installed-blueprint entry on the first
  // `matchBlueprint` call per scope. Idempotent + best-effort per
  // entry — a broken installed-blueprint never sinks the match flow.
  let installedBlueprintsProvider: ReturnType<typeof createInstalledBlueprintsProvider> | undefined;
  if (opts.installedBlueprints && opts.installedBlueprints.entries.length > 0) {
    const { projectRoot, entries } = opts.installedBlueprints;
    const byId = new Map(entries.map((e) => [e.id, e] as const));
    const providerOptions: CreateInstalledBlueprintsProviderOptions = {
      installedBlueprints: () =>
        entries.flatMap((entry) => {
          if (entry.manifest.contract === undefined) return [];
          const intent = entry.manifest.description ?? entry.manifest.name ?? entry.id;
          return [
            {
              id: entry.id,
              manifestPath: entry.manifestPath,
              contract: entry.manifest.contract,
              intent,
            },
          ];
        }),
      compile: async (entry: InstalledBlueprintEntry): Promise<InstalledBlueprintCompileResult> => {
        const ui = byId.get(entry.id);
        if (!ui) {
          return { kind: "missing-entry", tried: [] };
        }
        const result = await compileUiOnDemand({
          projectRoot,
          manifestPath: ui.manifestPath,
          manifest: ui.manifest,
        });
        if (result.kind === "ok") {
          return { kind: "ok", code: result.code };
        }
        if (result.kind === "missing-entry") {
          return { kind: "missing-entry", tried: result.tried };
        }
        return {
          kind: "failure",
          errors: result.errors.map((m) => m.text),
        };
      },
      deps: { embedding, vectorStore, index: blueprintIndex },
      onIssue: (issue: InstalledBlueprintCacheIssue) => {
        process.stderr.write(
          `[ggui serve] installed-blueprint ${issue.id}: ${issue.kind}: ${issue.message}\n`
        );
      },
    };
    installedBlueprintsProvider = createInstalledBlueprintsProvider(providerOptions);
  }

  // Fold the bridge into the generation deps so the render handler +
  // handshake negotiator both consume it via `MatchBlueprintDeps.
  // installedBlueprints`. Two-step pattern keeps the createGguiServer
  // call below unchanged when no provider is wired.
  const generationWithInstalled = opts.generation
    ? installedBlueprintsProvider
      ? {
          ...opts.generation,
          installedBlueprints: installedBlueprintsProvider,
        }
      : opts.generation
    : undefined;

  // Env-gated blueprint-cache trace sink. When `GGUI_CACHE_TRACE_STDERR`
  // is truthy, every `matchBlueprint` decision (and the reason it landed
  // there) is written as a single JSON line to stderr prefixed
  // `[ggui:cache-trace] ` — a diagnostic for seeing WHY a semantic match
  // missed (RAG retrieved nothing / cosine below floor / judge declined)
  // in a captured server log. Registered BEFORE `createGguiServer` so the
  // first lookup already routes through it. Absent env = no sink (the
  // matcher emits nothing and spends no CPU on the top-K probe).
  if (process.env["GGUI_CACHE_TRACE_STDERR"]) {
    setCacheTraceSink(createStderrCacheTraceSink());
  }

  const server = createGguiServer({
    auth,
    embedding,
    providerKeys,
    // Seeded per-app metadata store. Threaded so the in-process
    // singleton is shared across `ggui_list_gadgets`,
    // `ggui_list_themes`, and the handshake (gadgets + theme default
    // resolution).
    appMetadataStore,
    // Theme catalog resolver. Reads from `@ggui-ai/design`'s registry
    // each call so runtime additions surface without a restart.
    // Co-binding with `appMetadataStore` mounts `ggui_list_themes` on
    // the agent route.
    themes: () => listThemes(),
    // Cross-restart HMAC secrets. Present iff the caller declared a
    // persistent dir. Both threaded so the next restart can verify
    // tokens minted by the previous run instead of regenerating per
    // process. render-signer.secret rides on the `renderSigning`
    // discriminated union (the `false` shape disables the layer
    // entirely; we always want it on here, so build the object form).
    ...(persistedWsTokenSecret !== undefined ? { wsTokenSecret: persistedWsTokenSecret } : {}),
    ...(persistedRenderSignerSecret !== undefined
      ? { renderSigning: { secret: persistedRenderSignerSecret } }
      : {}),
    ...(resolvedMcpInstructions !== undefined ? { mcpInstructions: resolvedMcpInstructions } : {}),
    // `--multi-tenant` flips the `/ggui/console/llm-keys` gate from
    // admin-token to auth-adapter. Default scope derivation in the
    // server picks up `userId` / `appId` from the resolved identity;
    // operators with composite scopes pass their own `providerKeyScope`
    // by composing `createGguiServer` directly.
    ...(opts.multiTenant ? { providerKeysGate: "auth-adapter" as const } : {}),
    // Gate OAuth login routes on publicBaseUrl. Without it the
    // redirect_uri can't be composed; the admin transport still mounts
    // so operators can paste credentials in advance.
    ...(opts.publicBaseUrl ? { publicBaseUrl: opts.publicBaseUrl } : {}),
    ...(rateLimiter ? { rateLimiter } : {}),
    ...(storage.renderStore ? { renderStore: storage.renderStore } : {}),
    // Always pass the materialized vectorStore so the install bridge
    // and the matcher share state. Passing only `storage.vectors`
    // (set when the manifest declares sqlite) would, on an absent
    // declaration, leave the server to mint its own internal
    // InMemoryVectorStore that the bridge couldn't see.
    vectors: vectorStore,
    // Share the one minted index instance with the server so the install
    // bridge + matcher resolve identity through the SAME index (the
    // server's ref-equality guard enforces this).
    index: blueprintIndex,
    // `threads:` is an opt-in on createGguiServer (no zero-config
    // fallback — threads without an explicit store wouldn't mount
    // routes at all). We only pass it when the manifest declares a
    // store; absent declaration → no thread routes.
    //
    // Durability claim is whatever the resolver surfaced: `'durable'`
    // for sqlite, `'ephemeral'` for memory. The server echoes this
    // through `/ggui/health`, so Portal's caveat logic stays honest.
    ...(storage.threadStore
      ? {
          threads: {
            store: storage.threadStore,
            ...(storage.threadDurability ? { durability: storage.threadDurability } : {}),
          },
        }
      : {}),
    renderChannel: true,
    pairing: opts.keysFile ? { persistencePath: opts.keysFile } : true,
    // Email magic-link login. OSS first-run default mirrors
    // `provisionalPreview` — wire a sender so magic links can be
    // delivered. `selectEmailSenderFromEnv` reads
    // `GGUI_EMAIL_SENDER` (default: `console`, terminal-only) and
    // optionally `RESEND_API_KEY` / `SMTP_*` to construct a real
    // sender. Misconfig is non-fatal: we log a warning + fall back
    // to console so the boot path stays alive.
    //
    // Routes only mount when `publicBaseUrl` is set (the verify URL
    // can't resolve otherwise) — the server logs
    // `email_login_skipped` in that case and `/login` falls back to
    // OAuth + pair-code. Hosted + programmatic embedders pass their
    // own sender by composing `createGguiServer` directly.
    emailLogin: {
      sender: emailSender,
      fromAddress: emailFromAddress,
    },
    // OAuth 2.1 + PKCE + DCR. Opt-in via `--oauth` because the routes
    // add an HTML paste-key page + 4 well-known endpoints — not free
    // attack surface for operators who only consume from pure-bearer
    // clients (Claude Desktop, the console). Required for MCP custom-
    // connector hosts (claude.ai, ChatGPT) whose form has no bearer
    // field; flag flips on `oauth: true` defaults (in-memory storage,
    // built-in paste-key consent page).
    ...(opts.oauth ? { oauth: true as const } : {}),
    console: {
      sessionCookie: true,
      ...(opts.adminToken !== undefined ? { adminToken: opts.adminToken } : {}),
      // First-run onboarding redirect. When neither the credentials
      // file (`~/.ggui/credentials.json`) nor any provider env var
      // (ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY /
      // OPENROUTER_API_KEY) is present, send `GET /` to the
      // **admin** onboarding flow — the operator running `ggui serve`
      // IS the admin on first-run, so they need the operator-key
      // plane (`/admin/llm-keys`) and the assistant-connection card
      // surfaced there. Cookie-gated end-user `/settings` is for a
      // *separate* user paired with the server later, not the
      // first-run operator. Once any key is configured, the next
      // visit serves the SPA normally. Scoped to the root path;
      // deep links bypass the redirect.
      landingRedirect: () => {
        try {
          const credsFileExists = existsSync(getCredentialsFile());
          const anyEnvKey =
            !!process.env.ANTHROPIC_API_KEY ||
            !!process.env.OPENAI_API_KEY ||
            !!process.env.GOOGLE_API_KEY ||
            !!process.env.OPENROUTER_API_KEY;
          if (!credsFileExists && !anyEnvKey) {
            return "/admin-login?next=%2Fadmin%2Fllm-keys";
          }
          return null;
        } catch {
          return null;
        }
      },
    },
    // Public welcome page at `/` — operator identification + public
    // deep-link surfaces + operator-login affordance. Resolved from
    // `ggui.json#operator` + `ggui.json#app.name` by serve-command.ts;
    // absent = no welcome page (SPA index handler still owns `/`).
    ...(opts.welcomePage ? { welcomePage: opts.welcomePage } : {}),
    // Default to in-memory; caller substitutes a persistent impl
    // (SqliteShortCodeIndex under `persistentDir`) so cached short-code
    // lookups survive a restart. Used by render-URL signing and
    // legacy compat paths; post-R5 the primary mount path is the
    // ui://ggui/render resource (auth-bearer-gated), not shortCodes.
    shortCodeIndex: opts.shortCodeIndex ?? new InMemoryShortCodeIndex(),
    // Content-addressable componentCode delivery. The OSS dev default
    // is filesystem-backed at `~/.ggui/code-cache/` (override via
    // `GGUI_CODE_CACHE_DIR`). Survives `ggui serve` restart so
    // claude.ai's iframe cache still resolves URLs minted before the
    // restart. Operators can `rm -rf` the cache at any time —
    // immutable URLs guarantee a fresh render repopulates as needed.
    codeStore: new FileSystemCodeStore({ root: getCodeCacheDir() }),
    // Manifest-declared blueprints. Only present when `ggui serve`
    // found UIs in `blueprints.include`; absent = the server's
    // `ggui_list_featured_blueprints` returns an empty catalog (the
    // zero-config default).
    ...(opts.blueprintProvider ? { blueprintProvider: opts.blueprintProvider } : {}),
    // Manifest-backed UI registry — resolves blueprint ids to
    // compiled bundles for `ggui_render_blueprint`. Paired with
    // `blueprintProvider` above (metadata vs. bundle resolution on
    // the same source). Absent = render tool not registered.
    ...(opts.uiRegistry ? { uiRegistry: opts.uiRegistry } : {}),
    // Manifest-declared primitive catalogs. Present when `ggui serve`
    // resolved `primitives.{packages,local}`; absent = in-memory-only
    // server with an empty `server.primitiveCatalogs`.
    ...(opts.primitiveCatalogs ? { primitiveCatalogs: opts.primitiveCatalogs } : {}),
    // Manifest-declared theme. Present when `ggui serve` resolved
    // `ggui.json#theme`; absent = `createGguiServer` falls back to its
    // `lightTheme`-backed default internally.
    ...(opts.theme ? { theme: opts.theme } : {}),
    // Console theme picker writer — paired with the admin-gated
    // `/ggui/console/theme` POST. Absent = picker UI surfaces a
    // read-only banner + POST returns 501. CLI sets this when
    // `plan.projectRoot` resolved to a manifest path on disk.
    ...(opts.themeWriter ? { themeWriter: opts.themeWriter } : {}),
    // Live-theme wiring — `themeProvider` reads from a shared cell
    // that `onThemeConfigChange` writes to on every console save,
    // so the picker's "Save to ggui.json" reaches the next render's
    // bootstrap envelope without a restart. Both threaded through
    // when present; absent = boot-baked behaviour (legacy).
    ...(opts.themeProvider ? { themeProvider: opts.themeProvider } : {}),
    ...(opts.onThemeConfigChange ? { onThemeConfigChange: opts.onThemeConfigChange } : {}),
    // Register `ggui_render` + serve `ui://ggui/render`. The `wsUrl`
    // is the live-channel URL published on `_meta["ai.ggui/render"]`
    // so iframes opened by an MCP Apps host (Claude Desktop, Claude
    // Code, claude.ai) can subscribe back to this same process.
    // First-party hosts (Studio, Portal, console) consume
    // `_meta.ui.resourceUri` instead and never hit the URL directly.
    mcpApps: {
      wsUrl: `${wsBaseUrl}/ws`,
    },
    // Task #382 — `runtimeUrl` MUST be absolute. The thin-shell HTML
    // served from `ui://ggui/render` is mounted via `srcdoc` in most
    // consumers (`<McpAppIframe>` default path for inline text), which
    // gives the iframe `about:srcdoc` as its URL — a relative path
    // like `/_ggui/iframe-runtime.js` resolves against `about:` and the
    // `<script src>` fetch silently fails. Publishing the absolute
    // URL built from the CLI's own known `baseUrl` makes srcdoc mount
    // work without operator action. The server still serves the bundle
    // at `/_ggui/iframe-runtime.js` under `runtimePath`; this overrides
    // only the URL published on `_meta["ai.ggui/render"].runtimeUrl`.
    runtime: { url: `${baseUrl}${RUNTIME_BUNDLE_URL_PATH}` },
    // OSS first-run default: provisional A2UI preview is on. The
    // deterministic emitter from `@ggui-ai/preview-a2ui/emitters`
    // adapts each render's `story.intent` into a small A2UI surface
    // (heading → shell → teardown) and streams it on
    // `_ggui:preview`. Embedded-ui's `/s/<shortCode>` viewer mounts
    // `<ProvisionalRenderer>` to paint the frames as they arrive,
    // so operators see a live UI build-up the first time they
    // invoke `ggui_render` — before any LLM generation lands on OSS.
    //
    // Hosted + programmatic hosts opt-in by composing
    // `createGguiServer()` directly and supplying their own
    // emitter (e.g. Haiku-backed); the CLI keeps the OSS story
    // honest with a zero-config default that fires.
    provisionalPreview: {
      enabled: true,
      emitter: createDeterministicPreviewEmitter(),
    },
    // Generation wiring. Threaded through to
    // `defaultHandlers.render.generation` → `createGguiRenderHandler`.
    // Absent = placeholder mode: render mints sessionIds + shortCodes
    // + preview but does NOT produce componentCode. The CLI's
    // `runServeCommand` probes BYOK (env → credentials file) at
    // boot and only supplies this opt on a hit. See
    // `./generation-probe.ts`.
    ...(generationWithInstalled ? { generation: generationWithInstalled } : {}),
    // Seed pools from `--seed-pool` artifacts. Threaded into the
    // handshake negotiator so cross-deployment blueprints are
    // accessible without being in the local cache.
    ...(opts.seedPools && opts.seedPools.length > 0 ? { seedPools: opts.seedPools } : {}),
    // Mount aggregation. External SharedHandler bundles appended onto
    // `/mcp` alongside ggui-native tools. No CLI config loader yet —
    // programmatic hosts + integration tests compose mounts through
    // this opt directly.
    ...(opts.mcpMounts && opts.mcpMounts.length > 0 ? { mcpMounts: opts.mcpMounts } : {}),
    // Schema-compat mode. Defaults to `'reject'` inside
    // `createGguiServer`; the env override is the operator's escape
    // hatch for scenarios that intentionally ship a blueprint with a
    // schema mismatch (e.g. contract-probe fixtures that exercise
    // mismatch handling downstream — `'reject'` would otherwise block
    // the render at render/try-live time before the scenario starts).
    //
    // Accepted values match `SchemaCompatMode`: `'reject' | 'warn' |
    // 'off'`. Unrecognized values fall through to the server's
    // default. Keeping the parse narrow so a typo yields default
    // behavior (reject) rather than silent relaxation.
    ...(process.env["GGUI_SCHEMA_COMPAT_MODE"] === "warn" ||
    process.env["GGUI_SCHEMA_COMPAT_MODE"] === "off" ||
    process.env["GGUI_SCHEMA_COMPAT_MODE"] === "reject"
      ? {
          schemaCompatCheck: process.env["GGUI_SCHEMA_COMPAT_MODE"] as "reject" | "warn" | "off",
        }
      : {}),
  });
  return {
    listen: async (port, host) => {
      const httpServer = await server.listen(port, host);
      const addr = httpServer.address();
      if (!addr || typeof addr === "string") {
        throw new Error("server.address() returned an unexpected shape");
      }
      return addr.port;
    },
    close: () => server.close(),
    toolCount: server.toolCount,
    serverName: "ggui-mcp-server",
    serverVersion: opts.cliVersion,
    primitiveCatalogCount: server.primitiveCatalogs.length,
    themeSource: server.theme.source,
    // Always non-null in the CLI bundle because `pairing: true` is
    // wired above. Exposed through the narrow `ServeBackend` contract
    // so `runServe` can pre-mint an initial pair code after bind
    // without reaching into `GguiServer`.
    pairingService: server.pairingService,
    // Always non-null in the CLI bundle because `console` is wired
    // above (sessionCookie: true). Surfaced so the CLI banner can
    // print the operator-facing value alongside PAIR_CODE.
    adminToken: server.adminToken,
    // Surface the embedding model id so `describeServeBanner` can
    // print a `rag` line. Read off the provider's `id` field — local
    // provider returns the model id (e.g. `Xenova/bge-small-en-v1.5`);
    // MockEmbeddingProvider returns `'mock-sine'`. The banner only
    // shows the line for real models (this CLI bundle always wires
    // the local provider, so the line always appears in `ggui serve`).
    embeddingModel: embedding.id,
  };
}
