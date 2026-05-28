#!/usr/bin/env node
/**
 * `ggui` — the open CLI binary.
 *
 * Minimal command router. The argv parsing + agent-runtime
 * resolution live in `./dev-command.js` so they're unit-testable
 * without triggering `main()` on import.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GguiDevError, LocalUiRegistry, runDev } from '@ggui-ai/dev-stack';
import type { UiRegistry } from '@ggui-ai/ui-registry';
import {
  discoverLocalUis,
  discoverMcpMounts,
  discoverPrimitives,
  GguiJsonLoadError,
  loadTheme,
  type DiscoveredMcpMount,
  type DiscoveredPrimitiveCatalog,
  type DiscoveredUi,
  type DiscoveryIssue,
  type LoadedTheme,
  type McpMountDiscoveryIssue,
  type PrimitiveDiscoveryIssue,
  type ThemeLoadIssue,
} from '@ggui-ai/project-config/node';
import { resolveAgentPlan, type ResolvedAgentPlan } from './serve-fallback.js';
import {
  buildAgentRuntime,
  describeTunnelSession,
  launchBrowser,
  openTunnel,
  parseDevFlags,
  resolveAgentCommand,
  resolveHubUrl,
  shouldAutoOpen,
} from './dev-command.js';
import {
  createNullTunnelProvider,
  discoverTunnelProvider,
  type TunnelProvider,
} from './tunnel-provider.js';
import {
  ManifestBlueprintProvider,
  resolveStorageFromConfig,
  buildNoCredentialsRender,
  type BlueprintProvider,
  type LlmProvider,
  type McpServerMount,
  type ResolvedStorageStores,
  type SharedHandler,
} from '@ggui-ai/mcp-server';
import type { ZodRawShape } from 'zod';
import type { StorageConfig } from '@ggui-ai/project-config';
import { InMemoryBlueprintProvider } from '@ggui-ai/mcp-server-core/in-memory';
import { createByokResolver } from './byok-resolver.js';
import { isInstalledBlueprintPath } from './internal/artifact-install.js';
import {
  DEFAULT_ROUTE_BY_PROVIDER,
  describeGenerationBinding,
  probeGenerationBinding,
  type GenerationBinding,
} from './generation-probe.js';
import { buildMcpServerBackend, pickFreePort } from './mcp-backend.js';
import { createThemeWriter } from './theme-writer.js';
import { createThemeFileUploader } from './theme-file-uploader.js';
import { getPersistentDir } from './paths.js';
import {
  createPersistentRenderStore,
  createPersistentVectorStore,
} from './persistent-stores.js';
import {
  parseServeFlags,
  runServe,
  SERVE_HELP,
} from './serve-command.js';
import { runLoginCommand } from './auth-login.js';
import { runLogoutCommand } from './auth-logout.js';
import { runWhoamiCommand } from './auth-whoami.js';
import { runKeysCommand } from './auth-keys.js';
import { runGadgetCommand } from './gadget-command.js';
import { runBlueprintCommand } from './blueprint-command.js';
import { runThemeCommand } from './theme-command.js';

const HELP = `ggui — open CLI for the ggui protocol

Usage:
  ggui <command> [options]

Commands:
  dev          Start the local UI registry server, open the dev hub,
               and (optionally) supervise a local agent runtime via
               the adapter seam.

                 --port <n>       Bind port (default: 6780, 0 = OS-assigned).
                 --host <addr>    Bind host (default: 127.0.0.1).
                 --no-serve       Load + discover and exit without binding.
                 --no-open        Don't auto-open the browser (also
                                  implied by CI=1 / BROWSER=none /
                                  non-TTY stdout).
                 --agent <entry>  Supervise a local agent runtime.
                                  .js/.mjs/.cjs  → node <entry>
                                  .ts/.tsx/.mts  → node --import=tsx <entry>
                                                   (tsx must be resolvable)
                 --tunnel         Opt into managed mode: after the
                                  local stack is listening, attempt
                                  to open a managed tunnel above it
                                  and print the remote URL. Local
                                  dev still runs if no tunnel
                                  provider is configured.

  serve        Run the open self-hosted personal-mode app (MCP server +
               supervised agent, per ggui.json). Distinct from \`ggui dev\`.

                 --port <n>       Bind port (default: 6781, 0 = OS-assigned).
                 --host <addr>    Bind host (default: 127.0.0.1).
                 --mcp-only       Boot only MCP; skip agent supervision.

  login        Sign into ggui.ai (device flow). Tokens stored in
               ~/.ggui/auth.json.
  logout       Discard the local ggui.ai session.
  whoami       Print the authenticated user.
  keys         Manage ggui_user_* connector keys (list/create/revoke).
  gadget       Author gadgets for the ggui marketplace.

                 gadget create <scope/name>  Scaffold a new gadget repo.

  blueprint    Author UI blueprints for the ggui marketplace.

                 blueprint create <scope/name>  Scaffold a new blueprint repo.

  theme        Validate + inspect operator-authored DTCG themes.

                 theme validate <path>  Validate a JSON theme file against
                                        the ThemeDocumentV1 schema.

Global options:
  --help, -h   Show this help.
  --version    Show installed version.

\`ggui\` runs the protocol locally — no account required. The hosted
Guuey platform is a separate product with its own \`guuey\` binary for
hosted control-plane commands (login/deploy/logs/secrets).
`;

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(HELP);
    return 0;
  }

  if (args[0] === '--version') {
    process.stdout.write(`${readVersion()}\n`);
    return 0;
  }

  const [command, ...rest] = args;

  switch (command) {
    case 'dev':
      return runDevCommand(rest);
    case 'serve':
      return runServeCommand(rest);
    case 'login':
      return runLoginCommand(rest);
    case 'logout':
      return runLogoutCommand(rest);
    case 'whoami':
      return runWhoamiCommand(rest);
    case 'keys':
      return runKeysCommand(rest);
    case 'gadget':
      return runGadgetCommand(rest);
    case 'blueprint':
      return runBlueprintCommand(rest);
    case 'theme':
      return runThemeCommand(rest);
    default:
      process.stderr.write(`ggui: unknown command "${command}"\n\n`);
      process.stderr.write(HELP);
      return 1;
  }
}

// `buildMcpServerBackend` moved to `./mcp-backend.ts` so tests can
// exercise the full opt-in bundle ({sessionChannel, pairing,
// console.sessionCookie, shortCodeIndex}) without triggering
// `main()` at import. See module-level doc there for the bundle
// rationale.

/**
 * Event sink for the supervised agent. Production writes `[agent …]`
 * lines to stderr so they interleave with the JSON-line logger
 * without polluting stdout.
 */
function writeAgentEventToStderr(
  event: Parameters<
    NonNullable<
      Parameters<typeof resolveAgentPlan>[0]['onAgentEvent']
    >
  >[0],
): void {
  if (event.type === 'status') {
    process.stderr.write(`[agent] status=${event.status}\n`);
    // Crash policy made visible: the banner above already printed
    // "agent → running", so the operator's mental model diverges from
    // reality the moment a crash event arrives. This follow-up line
    // keeps the two in sync and documents inline why MCP keeps serving
    // after the supervised agent crashes.
    if (event.status === 'crashed') {
      process.stderr.write(
        `[agent] crashed — MCP still running; restart via your supervisor or Ctrl-C + rerun.\n`,
      );
    }
    return;
  }
  if (event.type === 'log') {
    process.stderr.write(`[agent ${event.stream}] ${event.line}\n`);
    return;
  }
  if (event.type === 'error') {
    process.stderr.write(`[agent error] ${event.message}\n`);
  }
}

async function runServeCommand(args: string[]): Promise<number> {
  const parsed = parseServeFlags(args);
  if (parsed.error === '__help__') {
    process.stdout.write(SERVE_HELP);
    return 0;
  }
  if (parsed.error) {
    process.stderr.write(`ggui serve: ${parsed.error}\n`);
    return 1;
  }

  // Compose SIGINT + SIGTERM into a single AbortController so
  // `runServe` resolves the serve loop on either signal. Listeners
  // are `once` — a second Ctrl-C during shutdown propagates the
  // signal unhandled so Node force-exits, which is the right
  // behavior if graceful close wedges.
  const controller = new AbortController();
  const shutdown = (): void => {
    if (!controller.signal.aborted) controller.abort();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  let plan: ResolvedAgentPlan;
  try {
    plan = resolveAgentPlan({
      mcpOnly: parsed.mcpOnly,
      cwd: process.cwd(),
      onAgentEvent: writeAgentEventToStderr,
    });
  } catch (err) {
    // Hard-config-error path: malformed ggui.json or unsupported
    // agent.entry. Render a crisp, actionable message + exit 1.
    if (err instanceof GguiJsonLoadError) {
      process.stderr.write(`ggui serve: ${err.message}\n`);
      if (err.cause && err.cause instanceof Error) {
        process.stderr.write(`  cause: ${err.cause.message}\n`);
      }
      return 1;
    }
    process.stderr.write(
      `ggui serve: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  // Print warnings BEFORE the banner — stderr lines for missing /
  // incomplete config so operators can't miss them under the pretty
  // section that comes after `listen()`.
  for (const warning of plan.warnings) {
    process.stderr.write(`ggui serve: ${warning}\n`);
  }

  // Resolve `ggui.json#storage` → concrete adapters BEFORE binding.
  // Absent storage block → empty bundle → server keeps in-memory
  // defaults. Sqlite paths resolve relative to the manifest directory
  // (not CWD) so `"path": "./ggui-renders.sqlite"` lands next to
  // `ggui.json` regardless of where the operator invoked `ggui serve`
  // from. Failure to instantiate (e.g. better-sqlite3 peer dep
  // missing, permission denied) propagates to the exit-1 path below.
  let storage: ResolvedStorageStores;
  try {
    storage = await resolveStorageFromConfigSafely(
      plan.manifest?.storage,
      plan.projectRoot,
    );
  } catch (err) {
    process.stderr.write(
      `ggui serve: storage: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  // Persistent default for RenderStore + VectorStore — layered AFTER
  // the manifest resolver so explicit `ggui.json#storage` declarations
  // always win, and BEFORE the banner so `describeStorageStatus`
  // reflects the actual wired state. Without this layer, ggui-default
  // (no `storage:` block in ggui.json) has no VectorStore, which
  // breaks the handshake blueprint cache (matchBlueprint exact-key
  // probe relies on the vector store). Setting `GGUI_PERSISTENT_DIR`
  // overrides the default location.
  {
    // `--ephemeral` skips the whole persistent layering. Operators who
    // pass the flag get pure in-memory defaults across the board (HMAC
    // secrets mint fresh per process). Without the flag, the
    // sqlite-backed VectorStore + RenderStore persist across restarts
    // — note this means the install-to-cache bridge can serve stale
    // install-provenance rows after a boot if the source TSX behind a
    // cached row has been edited or uninstalled in the meantime.
    if (!parsed.ephemeral) {
      const persistentDir = getPersistentDir(plan.projectRoot);
      const manifestDeclaresRenders = plan.manifest?.storage?.renders !== undefined;
      const manifestDeclaresVectors = plan.manifest?.storage?.vectors !== undefined;
      // The persistent stores are SQLite-backed (`better-sqlite3`, an
      // optional native module). When it isn't installed — or the
      // store otherwise can't be created — fall back to the in-memory
      // default rather than refusing to boot: a fresh `npm install
      // @ggui-ai/cli` user can `ggui serve` immediately, and adding
      // `better-sqlite3` later upgrades them to persistence. An
      // explicit `ggui.json#storage` declaration still hard-fails (it
      // resolved above) — the operator asked for it by name.
      if (!manifestDeclaresRenders && storage.renderStore === undefined) {
        try {
          const renderStore = await createPersistentRenderStore(persistentDir);
          storage = { ...storage, renderStore };
        } catch (err) {
          process.stderr.write(
            `ggui serve: persistent render store unavailable — using in-memory `
              + `(renders reset on restart; install \`better-sqlite3\` for persistence). `
              + `[${err instanceof Error ? err.message : String(err)}]\n`,
          );
        }
      }
      if (!manifestDeclaresVectors && storage.vectors === undefined) {
        try {
          const vectors = await createPersistentVectorStore(persistentDir);
          storage = { ...storage, vectors };
        } catch (err) {
          process.stderr.write(
            `ggui serve: persistent vector store unavailable — using in-memory `
              + `(blueprint cache not persisted; install \`better-sqlite3\` for persistence). `
              + `[${err instanceof Error ? err.message : String(err)}]\n`,
          );
        }
      }
    }
  }

  for (const line of describeStorageStatus(plan.manifest?.storage, storage)) {
    process.stdout.write(`${line}\n`);
  }

  // Resolve `ggui.json#blueprints.include` → indexed `ggui.ui.json`
  // manifests BEFORE binding. Discovery is non-throwing — malformed
  // files / duplicate ids surface as issues — but `ggui serve` escalates
  // ANY issue to a fatal exit before binding, preferring explicit
  // failure over a silent partial boot. A partially booted server that
  // silently dropped a declared UI would hand the agent a
  // `ggui_list_featured_blueprints` catalog that doesn't match the
  // operator's ggui.json — the worst kind of drift.
  let blueprintProvider: BlueprintProvider | undefined;
  // Hoist the discovered-UI list so the marketplace-install bridge can
  // filter to `.ggui/installed-blueprints/` entries below. Same
  // discovery walk, two consumers (blueprint catalog + matcher cache
  // seed).
  let discoveredUis: readonly import('@ggui-ai/project-config/node').DiscoveredUi[] = [];
  if (plan.manifest && plan.projectRoot) {
    const discovery = await discoverLocalUis({
      projectRoot: plan.projectRoot,
      manifest: plan.manifest,
    });
    for (const line of describeBlueprintIssues(discovery.issues)) {
      process.stderr.write(`${line}\n`);
    }
    if (discovery.issues.length > 0) {
      process.stderr.write(
        `ggui serve: refusing to start — ${discovery.issues.length} blueprint manifest issue(s). Fix the issues above and re-run.\n`,
      );
      return 1;
    }
    for (const line of describeBlueprintStatus(discovery.uis)) {
      process.stdout.write(`${line}\n`);
    }
    discoveredUis = discovery.uis;
    if (discovery.uis.length > 0) {
      blueprintProvider = new ManifestBlueprintProvider({
        manifests: discovery.uis.map((u) => u.manifest),
      });
    }
  }

  // Pair the metadata provider with a UiRegistry that can resolve
  // blueprint ids → compiled bundles. OSS uses dev-stack's
  // `LocalUiRegistry` (esbuild-backed compile-on-demand; same file
  // layout as `discoverLocalUis`). Registered only when blueprints
  // were discovered — no discovered blueprints, no render tool (the
  // handler registration in `createGguiServer` is gated on this seam
  // being present).
  let uiRegistry: UiRegistry | undefined;
  if (blueprintProvider && plan.manifest && plan.projectRoot) {
    uiRegistry = new LocalUiRegistry({
      projectRoot: plan.projectRoot,
      manifest: plan.manifest,
    });
  }

  // Resolve `ggui.json#primitives.{packages,local}` → catalogs BEFORE
  // binding. Same "non-throwing per source, fatal at the boot boundary"
  // discipline as blueprint discovery — the capability-manifest stops
  // being cosmetic the moment declared sources refuse to resolve.
  let primitiveCatalogs: readonly DiscoveredPrimitiveCatalog[] = [];
  if (plan.manifest && plan.projectRoot) {
    const discovery = await discoverPrimitives({
      projectRoot: plan.projectRoot,
      manifest: plan.manifest,
    });
    for (const line of describePrimitiveIssues(discovery.issues)) {
      process.stderr.write(`${line}\n`);
    }
    if (discovery.issues.length > 0) {
      process.stderr.write(
        `ggui serve: refusing to start — ${discovery.issues.length} primitive manifest issue(s). Fix the issues above and re-run.\n`,
      );
      return 1;
    }
    for (const line of describePrimitiveStatus(discovery.catalogs)) {
      process.stdout.write(`${line}\n`);
    }
    primitiveCatalogs = discovery.catalogs;
  }

  // Resolve `ggui.json#theme` → LoadedTheme BEFORE binding. Absent
  // declaration → shipped default (no issue, no fatal path). Present
  // but unreadable / malformed / schema-invalid → fatal exit with the
  // issue printed to stderr. Same "prefer explicit failure over
  // silent partial boot" escalation the blueprint + primitive slices
  // adopted.
  let theme: LoadedTheme | undefined;
  if (plan.manifest && plan.projectRoot) {
    const result = loadTheme({
      projectRoot: plan.projectRoot,
      manifest: plan.manifest,
    });
    if (!result.ok) {
      for (const line of describeThemeIssue(result.issue)) {
        process.stderr.write(`${line}\n`);
      }
      process.stderr.write(
        `ggui serve: refusing to start — theme manifest issue. Fix the issue above and re-run.\n`,
      );
      return 1;
    }
    theme = result.theme;
    for (const line of describeThemeStatus(theme)) {
      process.stdout.write(`${line}\n`);
    }
  }

  // Live-theme state cell. Shared between the console-theme route's
  // POST handler (mountDevtoolThemeRoutes' `onConfigChange` callback)
  // and the push handler's `themeProvider` getter so a "Save to
  // ggui.json" in the picker reaches the next push's bootstrap
  // envelope without a server restart. Without the cell the push
  // handler would capture `themeId` once at boot, and any subsequent
  // edit would be silently ignored until restart.
  //
  // Initial value derives from the boot-time LoadedTheme so the
  // first push (before any save happens) embeds the manifest's
  // declared theme. POST writes mutate `themeStateCell.current`;
  // the closure below reads it on every push.
  const themeStateCell: {
    current: { id?: string; mode?: 'light' | 'dark' } | null;
  } = {
    current:
      theme !== undefined && theme.source === 'preset'
        ? { id: theme.preset, mode: theme.mode }
        : null,
  };
  const themeProvider = (): { id?: string; mode?: 'light' | 'dark' } | undefined =>
    themeStateCell.current ?? undefined;

  // The legacy `ggui.json#adapters` manifest grant has been retired.
  // The adapter grant model now lives entirely on
  // `clientCapabilities.gadgets[*].permission` and projects to the
  // iframe's Permissions-Policy header.

  // Resolve `ggui.json#mcpMounts` → invoked `createGguiMcpMount`
  // factories BEFORE binding. Same "non-throwing per source, fatal at
  // the boot boundary" discipline as blueprint / primitive / theme
  // discovery: the operator asked for a local tool surface, so a
  // malformed module is a refusal-to-start, not a silent drop. Each
  // mount's factory runs once here at boot — the CLI captures the
  // returned `McpServerMount` bundle and threads it into
  // `buildMcpServerBackend({ mcpMounts })`.
  let mcpMounts: readonly McpServerMount[] = [];
  if (plan.manifest && plan.projectRoot) {
    const discovery = await discoverMcpMounts({
      projectRoot: plan.projectRoot,
      manifest: plan.manifest,
    });
    for (const line of describeMcpMountIssues(discovery.issues)) {
      process.stderr.write(`${line}\n`);
    }
    if (discovery.issues.length > 0) {
      process.stderr.write(
        `ggui serve: refusing to start — ${discovery.issues.length} mcpMount issue(s). Fix the issues above and re-run.\n`,
      );
      return 1;
    }
    for (const line of describeMcpMountStatus(discovery.mounts)) {
      process.stdout.write(`${line}\n`);
    }
    mcpMounts = narrowMcpMounts(discovery.mounts);
  }

  // Resolve `--port 0` BEFORE composing the backend. `createGguiServer`
  // captures `mcpApps.wsUrl` + `runtime.url` at construction time, so
  // we need a concrete port to emit URLs the iframe can connect to.
  // A tiny race window exists between close + bind; surface the bind
  // failure cleanly if it loses.
  //
  // Resolved BEFORE the BYOK probe (vs. previous ordering) because
  // the no-credentials fallback card needs the absolute settings URL
  // — `${publicBaseUrl ?? http://${host}:${port}}/settings` — bound
  // into the generation closure at probe time. Per-call URL recompute
  // would be marginally cheaper but adds plumbing (closure depends on
  // `effectivePort` resolved later) without a real benefit.
  let effectivePort = parsed.port;
  if (effectivePort === 0) {
    try {
      effectivePort = await pickFreePort(parsed.host);
    } catch (err) {
      process.stderr.write(
        `ggui serve: failed to allocate a free port — ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }
  }

  // BYOK probe — boot scan + per-request resolver. The probe ALWAYS
  // returns a `GenerationBinding` now (post-H2): when no env / global
  // / user-scope key resolved at boot, the binding's `resolveLlm`
  // re-runs at every render with `userScope: ctx.appId` (per-user keys
  // stored in `~/.ggui/credentials.json` flip in there); when the
  // re-run also misses, the bound `onNoCredentials` hook produces
  // a Connect-Claude card render pointing at THIS server's
  // `/settings`. Story-path `ggui_render` therefore always lands a
  // real render — either a generated component (key found) or
  // the card (key missing).
  const baseUrlForCard =
    parsed.publicBaseUrl ?? `http://${parsed.host}:${effectivePort}`;
  const settingsUrl = `${baseUrlForCard}/settings`;
  // No-credentials cards live for an hour from mint — long enough for
  // the operator to follow the Connect-Claude link, paste a key, and
  // re-prompt before the persisted render is GC'd.
  const NO_CREDENTIALS_CARD_TTL_MS = 60 * 60 * 1000;

  // Resolve the operator's explicit `generation.model` route, if any.
  // The schema-side `parseAnyLlmRoute` transform yields a typed
  // `LlmRoute` directly — no string parsing here. Bedrock is
  // hosted-only on the OSS path (no IAM resolver chain wired); reject
  // explicitly with a clear error rather than silently failing at
  // dispatch time.
  const configuredRoute = plan.manifest?.generation?.model;
  if (configuredRoute?.provider === 'bedrock') {
    process.stderr.write(
      `ggui serve: ggui.json#generation.model declared a bedrock route ` +
        `("${configuredRoute.model}"), but the OSS BYOK resolver chain ` +
        `does not cover AWS IAM. Bedrock is supported via the hosted ` +
        `runtime only. Pick an anthropic/openai/google/openrouter route.\n`,
    );
    return 1;
  }

  let generationBinding: GenerationBinding;
  try {
    // Use whatever blueprint provider the manifest resolved, or
    // fall back to an empty one so the generator has a valid
    // `blueprints` dep regardless of manifest state.
    const blueprintsForGen = blueprintProvider ?? new InMemoryBlueprintProvider();
    generationBinding = await probeGenerationBinding({
      resolver: createByokResolver(),
      blueprints: blueprintsForGen,
      ...(configuredRoute ? { configuredRoute } : {}),
      onNoCredentials: (ctx, story) => {
        const nowEpochMs = Date.parse(story.nowIso);
        return buildNoCredentialsRender({
          renderId: story.renderId,
          appId: ctx.appId,
          intent: story.intent,
          nowEpochMs,
          expiresAt: nowEpochMs + NO_CREDENTIALS_CARD_TTL_MS,
          settingsUrl,
        });
      },
    });
  } catch (err) {
    // Don't fail boot on a probe error (malformed credentials file,
    // transient fs issue). Surface the reason so the operator can
    // investigate; we still produce a binding for the always-on path
    // by re-running with no fallback hook (resolver retries at
    // request time, hits the legacy error envelope on miss).
    process.stderr.write(
      `ggui serve: generation probe failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    const blueprintsForGen = blueprintProvider ?? new InMemoryBlueprintProvider();
    generationBinding = await probeGenerationBinding({
      resolver: createByokResolver(),
      blueprints: blueprintsForGen,
      ...(configuredRoute ? { configuredRoute } : {}),
    });
  }

  // Strict-fail: a key resolved at boot, but the operator never
  // declared `generation.model` in their manifest. Silently picking
  // the per-provider default was the surprise that produced #22 and
  // #42 — the typed system removed the WIRE bug class, this check
  // removes the OPERATOR bug class. (`--mcp-only` and no-manifest
  // paths skip the check — they have no generation surface to pin.)
  if (
    plan.manifest !== null &&
    generationBinding.bootResolved &&
    configuredRoute === undefined
  ) {
    process.stderr.write(
      `ggui serve: boot scan resolved a ${generationBinding.provider} key but ` +
        `ggui.json#generation.model is unset. Pick the model explicitly:\n` +
        `\n` +
        `  {\n` +
        `    "schema": "1",\n` +
        `    "generation": {\n` +
        `      "model": "${generationBinding.provider}:${DEFAULT_ROUTE_BY_PROVIDER[generationBinding.provider as Exclude<LlmProvider, 'bedrock'>].model}"\n` +
        `    }\n` +
        `  }\n` +
        `\n` +
        `Accepted forms:\n` +
        `  - canonical: "anthropic:claude-haiku-4-5-20251001"\n` +
        `  - LiteLLM:   "anthropic/claude-haiku-4-5"\n` +
        `\n` +
        `See docs/principles/model-string-convention.md.\n`,
    );
    return 1;
  }
  process.stdout.write(`${describeGenerationBinding(generationBinding)}\n`);

  try {
    return await runServe({
      flags: {
        port: effectivePort,
        host: parsed.host,
        mcpOnly: parsed.mcpOnly,
        devAllowAll: parsed.devAllowAll,
        publicDemo: parsed.publicDemo,
        multiTenant: parsed.multiTenant,
        oauth: parsed.oauth,
        ...(parsed.publicBaseUrl !== undefined
          ? { publicBaseUrl: parsed.publicBaseUrl }
          : {}),
        ...(parsed.keysFile !== undefined ? { keysFile: parsed.keysFile } : {}),
        ...(parsed.adminToken !== undefined
          ? { adminToken: parsed.adminToken }
          : {}),
      },
      backendFactory: () =>
        buildMcpServerBackend({
          storage,
          cliVersion: readVersion(),
          host: parsed.host,
          port: effectivePort,
          devAllowAll: parsed.devAllowAll,
          publicDemo: parsed.publicDemo,
          multiTenant: parsed.multiTenant,
          oauth: parsed.oauth,
          ...(parsed.publicBaseUrl !== undefined
            ? { publicBaseUrl: parsed.publicBaseUrl }
            : {}),
          ...(parsed.mcpInstructions !== undefined
            ? { mcpInstructions: parsed.mcpInstructions }
            : {}),
          ...(parsed.keysFile !== undefined ? { keysFile: parsed.keysFile } : {}),
          ...(parsed.adminToken !== undefined
            ? { adminToken: parsed.adminToken }
            : {}),
          ...(blueprintProvider ? { blueprintProvider } : {}),
          ...(uiRegistry ? { uiRegistry } : {}),
          ...(primitiveCatalogs.length > 0 ? { primitiveCatalogs } : {}),
          ...(theme ? { theme } : {}),
          // Console theme picker — wired only when a ggui.json was
          // resolved on disk. Operators booting without a manifest
          // (no projectRoot) get the picker in read-only mode (POST
          // returns 501; the UI surfaces a banner). The writer
          // round-trips JSON through `JSON.parse` + `JSON.stringify`
          // so unknown fields the operator added survive the Save.
          ...(plan.projectRoot
            ? {
                themeWriter: createThemeWriter(
                  join(plan.projectRoot, 'ggui.json'),
                ),
                themeFileUploader: createThemeFileUploader(
                  join(plan.projectRoot, 'ggui.json'),
                ),
                // Live-theme: closure reads `themeStateCell` on every
                // push. `onThemeConfigChange` mutates the cell from
                // the console-theme route's POST handler. Together:
                // console save → cell update → next push's bootstrap
                // carries the new themeId. No restart required.
                themeProvider,
                onThemeConfigChange: (next) => {
                  if (next === null) {
                    themeStateCell.current = null;
                    return;
                  }
                  // ThemeConfig accepts three shapes:
                  //  - string shorthand (`'indigo'`): preset id, no mode.
                  //  - { preset, mode?, overrides? }: explicit preset.
                  //  - { file, mode? }: custom DTCG document.
                  // For preset shapes, propagate id+mode to the live
                  // cell so the next push's bootstrap envelope picks
                  // them up. For the file branch the bootstrap's
                  // `themeId` field has no useful value (the runtime
                  // bundles only registered presets), so we clear
                  // the id and the iframe falls back to its baked
                  // default. The mode still propagates for cases
                  // where a future path resolves the file at runtime.
                  if (typeof next === 'string') {
                    themeStateCell.current = { id: next };
                  } else if ('preset' in next) {
                    themeStateCell.current = {
                      id: next.preset,
                      ...(next.mode !== undefined ? { mode: next.mode } : {}),
                    };
                  } else {
                    themeStateCell.current = next.mode !== undefined
                      ? { mode: next.mode }
                      : null;
                  }
                },
              }
            : {}),
          // Public welcome page at `/` — operator identification +
          // public deep-link surfaces + operator-login affordance.
          // Sourced from `ggui.json#operator` + `ggui.json#app.name`
          // when a manifest was found on disk; absent without one,
          // and absent if `operator` was not declared. The renderer
          // hides the operator block entirely when nothing is set.
          ...(plan.manifest
            ? {
                welcomePage: {
                  ...(plan.manifest.operator
                    ? { operator: plan.manifest.operator }
                    : {}),
                  ...(plan.manifest.app?.name
                    ? { appName: plan.manifest.app.name }
                    : {}),
                },
              }
            : {}),
          // Pass through `app.gadgets` from the manifest so
          // the InMemoryAppMetadataStore seed surfaces declared gadgets
          // (Leaflet, Mapbox, …) on `App.gadgets`. Omitted ⇒
          // `STDLIB_GADGETS` defaults (the first-party hooks).
          ...(plan.manifest?.app?.gadgets &&
          plan.manifest.app.gadgets.length > 0
            ? { gadgets: plan.manifest.app.gadgets }
            : {}),
          // Pass through `app.publicEnv`. The server projects only keys
          // that some registered wrapper's `requires` lists onto
          // `App.publicEnv` for the push-gate validator + the iframe
          // runtime's `getPublicEnv()`.
          ...(plan.manifest?.app?.publicEnv &&
          Object.keys(plan.manifest.app.publicEnv).length > 0
            ? { publicEnv: plan.manifest.app.publicEnv }
            : {}),
          ...(plan.manifest?.app?.defaultDisplayMode !== undefined
            ? { defaultDisplayMode: plan.manifest.app.defaultDisplayMode }
            : {}),
          generation: generationBinding.generation,
          ...(mcpMounts.length > 0 ? { mcpMounts } : {}),
          // Marketplace-install bridge. Pass the projectRoot +
          // filtered installed-blueprint subset so `buildMcpServerBackend`
          // can construct an `InstalledBlueprintsProvider` rooted on the
          // same embedding + vectorStore the matcher reads. Only
          // contract-bearing entries flow through — the bridge needs a
          // contract to hash for the matcher's canonical key.
          ...(plan.projectRoot && discoveredUis.length > 0
            ? {
                installedBlueprints: {
                  projectRoot: plan.projectRoot,
                  entries: discoveredUis
                    .filter((ui) => isInstalledBlueprintPath(ui.manifestPath))
                    .filter((ui) => ui.manifest.contract !== undefined)
                    .map((ui) => ({
                      id: ui.id,
                      manifestPath: ui.manifestPath,
                      manifest: ui.manifest,
                    })),
                },
              }
            : {}),
        }),
      agent: plan.supervision,
      agentStatus: plan.status,
      ...(generationBinding.bootResolved ? {} : { noLlmKey: true }),
      stdout: process.stdout,
      shutdownSignal: controller.signal,
    });
  } catch (err) {
    process.stderr.write(
      `ggui serve: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

/**
 * Wrap `resolveStorageFromConfig` so dynamic-import failures (e.g.
 * `better-sqlite3` not installed when the manifest declared sqlite)
 * surface with a remediation hint instead of a bare `Cannot find
 * module` trace.
 */
async function resolveStorageFromConfigSafely(
  config: StorageConfig | undefined,
  projectRoot: string | null,
): Promise<ResolvedStorageStores> {
  try {
    return await resolveStorageFromConfig(config, {
      ...(projectRoot ? { baseDir: projectRoot } : {}),
    });
  } catch (err) {
    if (
      err instanceof Error &&
      /MODULE_NOT_FOUND|Cannot find module/i.test(err.message) &&
      err.message.includes('better-sqlite3')
    ) {
      throw new Error(
        'sqlite driver requires `better-sqlite3` — install it as a ' +
          'dependency of your project (`pnpm add better-sqlite3`) and re-run.',
      );
    }
    throw err;
  }
}

/**
 * Pre-banner status lines describing the resolved storage. Pure so
 * tests can pin the copy; writes to stdout via the caller.
 *
 *   - No manifest storage block  → silent (nothing to say; defaults apply)
 *   - Explicit memory-only       → one line confirming in-memory
 *   - Sqlite declared            → one line per sqlite surface
 */
function describeStorageStatus(
  config: StorageConfig | undefined,
  resolved: ResolvedStorageStores,
): string[] {
  if (!config) return [];
  const lines: string[] = [];
  if (config.renders) {
    lines.push(
      resolved.renderStore
        ? `storage: renders  → sqlite (${config.renders.driver === 'sqlite' ? config.renders.path : '—'})`
        : `storage: renders  → in-memory`,
    );
  }
  if (config.vectors) {
    lines.push(
      resolved.vectors
        ? `storage: vectors  → sqlite (${config.vectors.driver === 'sqlite' ? config.vectors.path : '—'})`
        : `storage: vectors  → in-memory`,
    );
  }
  if (config.threads) {
    // Threads always resolve to a real store when declared — memory
    // mounts `InMemoryThreadStore`, sqlite mounts `SqliteThreadStore`.
    // "in-memory (ephemeral)" is the honest label; data vanishes on
    // restart.
    if (config.threads.driver === 'sqlite') {
      lines.push(
        `storage: threads  → sqlite (${config.threads.path}) — durable`,
      );
    } else {
      lines.push(`storage: threads  → in-memory — ephemeral`);
    }
  }
  return lines;
}

/**
 * Pre-banner status lines describing the indexed blueprint manifests.
 * Pure so tests can pin the copy; writes to stdout via the caller.
 *
 *   - Empty declaration → silent
 *   - Non-empty         → `blueprints: N declared` + one line per UI
 */
function describeBlueprintStatus(uis: readonly DiscoveredUi[]): string[] {
  if (uis.length === 0) return [];
  const lines: string[] = [`blueprints: ${uis.length} declared`];
  for (const ui of uis) {
    lines.push(`  - ${ui.id} (${ui.manifest.name})`);
  }
  return lines;
}

/**
 * Stderr lines describing blueprint-manifest discovery issues. Emitted
 * BEFORE the refusal-to-start exit, so the operator sees the specific
 * files + messages alongside the summary. Pure; caller writes to
 * stderr.
 */
function describeBlueprintIssues(issues: readonly DiscoveryIssue[]): string[] {
  return issues.map(
    (issue) => `ggui serve: blueprints: ${issue.path} — ${issue.message}`,
  );
}

/**
 * Pre-banner status lines describing the indexed primitive catalogs.
 * Pure; caller writes to stdout.
 *
 *   - No catalogs → silent (zero-config / nothing declared)
 *   - Non-empty   → `primitives: N catalog(s)` + one line each with
 *                    import-specifier + `(count, source)`.
 *
 * Format intentionally matches the blueprint status block so operators
 * see one coherent pre-banner.
 */
function describePrimitiveStatus(
  catalogs: readonly DiscoveredPrimitiveCatalog[],
): string[] {
  if (catalogs.length === 0) return [];
  const lines: string[] = [
    `primitives: ${catalogs.length} catalog(s) declared`,
  ];
  for (const c of catalogs) {
    lines.push(
      `  - ${c.import} (${c.manifest.primitives.length} primitives, ${c.source})`,
    );
  }
  return lines;
}

/**
 * Stderr lines describing primitive-manifest discovery issues. Same
 * escalation discipline as {@link describeBlueprintIssues} — emitted
 * BEFORE the refusal-to-start exit so each declared source + failure
 * reason is visible alongside the summary.
 */
function describePrimitiveIssues(
  issues: readonly PrimitiveDiscoveryIssue[],
): string[] {
  return issues.map(
    (issue) => `ggui serve: primitives: ${issue.path} — ${issue.message}`,
  );
}

/**
 * Pre-banner status line for the loaded theme. Pure; caller writes to
 * stdout. Matches the shape of the storage / blueprint / primitive
 * pre-banner lines so operators see one coherent header.
 *
 *   - `source: 'default'` → `theme: (default — @ggui-ai/design)`
 *   - `source: 'file'`    → `theme: <relative-ish path>`
 *
 * The default branch is emitted even when no `theme` is declared so
 * the operator always sees which theme backs the running server —
 * "silently using lightTheme" is the worst kind of surprise for
 * branded deployments.
 */
function describeThemeStatus(theme: LoadedTheme): string[] {
  if (theme.source === 'default') {
    return [`theme: (default — @ggui-ai/design lightTheme)`];
  }
  if (theme.source === 'preset') {
    const overrides =
      theme.overrides && Object.keys(theme.overrides).length > 0
        ? ` (+${Object.keys(theme.overrides).length} override${
            Object.keys(theme.overrides).length === 1 ? '' : 's'
          })`
        : '';
    return [`theme: ${theme.preset} · ${theme.mode}${overrides}`];
  }
  return [`theme: ${theme.path} · ${theme.mode}`];
}

/**
 * Stderr line for a theme-load issue. Single-line because `loadTheme`
 * returns at most one issue per call (unlike blueprint / primitive
 * discovery which walk many files).
 */
function describeThemeIssue(issue: ThemeLoadIssue): string[] {
  return [`ggui serve: theme: ${issue.path} — ${issue.message}`];
}

/**
 * Pre-banner status lines for resolved mcpMount entries. Pure; caller
 * writes to stdout. Matches the shape of the blueprint / primitive /
 * theme pre-banner lines so operators see one coherent header.
 *
 *   - Empty list → silent (zero-config default)
 *   - Non-empty  → `mcpMounts: N declared` + one line each with
 *                  mount name + declared module spec.
 */
function describeMcpMountStatus(
  mounts: readonly DiscoveredMcpMount[],
): string[] {
  if (mounts.length === 0) return [];
  const lines: string[] = [`mcpMounts: ${mounts.length} declared`];
  for (const m of mounts) {
    lines.push(
      `  - ${m.mount.name} (${m.mount.handlers.length} tools, ${m.spec})`,
    );
  }
  return lines;
}

/**
 * Stderr lines describing `mcpMounts` discovery issues. Emitted BEFORE
 * the refusal-to-start exit so operators see the specific failing
 * spec + underlying cause. Same escalation discipline as blueprint /
 * primitive discovery.
 */
function describeMcpMountIssues(
  issues: readonly McpMountDiscoveryIssue[],
): string[] {
  return issues.map(
    (issue) => `ggui serve: mcpMounts: ${issue.path} — ${issue.message}`,
  );
}

/**
 * Narrow `DiscoveredMcpMount[]` (whose `handlers` is `unknown[]` by
 * construction — see module JSDoc on `mcp-mount-discovery.ts`) to the
 * `McpServerMount[]` the server backend expects. The factory contract
 * already requires handlers to be `SharedHandler`-shaped; the
 * structural validation in project-config is intentionally type-thin
 * so it doesn't reverse-depend on `@ggui-ai/mcp-server`. Cast here is
 * the single documented adapter point where that gap closes — not a
 * workaround, a dep-graph seam.
 *
 * Per-handler structural validation (name uniqueness, zod shape
 * presence) happens inside `composeHandlersWithMounts` at
 * `createGguiServer` construction time, which will throw with a
 * mount-labeled error if any mount's handlers are malformed.
 */
function narrowMcpMounts(
  discovered: readonly DiscoveredMcpMount[],
): McpServerMount[] {
  return discovered.map((d) => ({
    name: d.mount.name,
    handlers: d.mount.handlers as ReadonlyArray<
      SharedHandler<ZodRawShape, ZodRawShape>
    >,
  }));
}

async function runDevCommand(args: string[]): Promise<number> {
  const parsed = parseDevFlags(args);
  if (parsed.error) {
    process.stderr.write(`ggui dev: ${parsed.error}\n`);
    return 1;
  }

  // `ggui dev` flips the dev-mode bit so the mcp-server mounts the
  // `/devtools/*` namespace and the SPA shows the link. Set it on
  // process.env BEFORE the dev-stack boots — `createGguiServer` reads
  // `GGUI_MODE` at construction time. Operators can still override
  // explicitly (`GGUI_MODE=prod ggui dev`) since `??=` skips
  // re-assignment.
  process.env.GGUI_MODE ??= 'dev';

  // Resolve agent adapter up front so bad `--agent` paths fail
  // before we bother binding a socket. Actual subprocess spawn
  // happens inside `runDev` — this pass only validates the
  // command mapping.
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  if (parsed.agent) {
    const resolution = resolveAgentCommand(parsed.agent, process.cwd());
    if (!resolution.ok) {
      process.stderr.write(`ggui dev: ${resolution.error}\n`);
      return 1;
    }
    runtime = buildAgentRuntime(resolution);
  }

  // Managed-mode prerequisite — when `--tunnel` AND an `--agent` was
  // supplied, allocate a free port up-front and hand it to the
  // dev-stack so it can forward it (via `portHint` + `PORT` env)
  // into the supervised runtime. The tunnel provider will use this
  // same port to forward inbound bridge traffic to the agent.
  // Without `--agent`, there's nothing to bind, so we skip.
  //
  // Without `--tunnel`, we skip allocation entirely to preserve the
  // current "agent picks its own port" behaviour for OSS users
  // running plain `ggui dev --agent …`.
  let runtimePort: number | undefined;
  if (parsed.tunnel && runtime) {
    runtimePort = await pickFreePort();
  }

  try {
    const bootstrap = await runDev({
      serve: !parsed.noServe,
      port: parsed.port,
      host: parsed.host,
      runtime,
      runtimePort,
    });

    if (!bootstrap.server) {
      // --no-serve: one-shot inspection path. Exit cleanly.
      return 0;
    }

    // Print the hub URL explicitly — dev-stack's banner lists the
    // endpoints but not the composed URL. The CLI's banner is the
    // headline the developer sees: "here's where you go." Always
    // emitted, whether or not we end up auto-opening.
    const hubUrl = resolveHubUrl(bootstrap.server.host, bootstrap.server.port);
    const decision = shouldAutoOpen({
      serving: true,
      noOpen: parsed.noOpen,
      isTty: process.stdout.isTTY === true,
      env: process.env,
    });

    const banner: string[] = ['', `  hub  →  ${hubUrl}`];
    if (decision.open) {
      const result = launchBrowser(hubUrl);
      banner.push(
        result.ok
          ? `          opening browser…`
          : `          (couldn't launch browser: ${result.error})`,
      );
    } else {
      banner.push(`          auto-open skipped: ${decision.reason}`);
    }

    // Managed-mode scaffold. With `--tunnel`, the CLI asks a
    // `TunnelProvider` to open a managed tunnel for the single local
    // host. Today the only provider is the "null" reference, which
    // always returns `{ status: 'unavailable' }`; this exercises the
    // seam and prints honest copy without shipping a public-tunnel
    // story before remote authentication is resolved.
    const tunnelShutdown = { close: null as null | (() => Promise<void>) };
    if (parsed.tunnel) {
      // Resolve a tunnel provider via the discovery seam. The flag
      // itself stays as a hook for future ggui.ai tunnel providers
      // (Cloudflare tunnel, Tailscale funnel, ...) -- selectTunnelProvider
      // returns a null provider with a clear "not configured" hint
      // when no `GGUI_TUNNEL_PROVIDER` is set, so local dev keeps
      // running unchanged regardless of result.
      const provider = await selectTunnelProvider();
      const tunnelController = new AbortController();
      // `localUrl` is the host root (without the `/hub` path) so
      // providers can wrap the whole origin rather than a single
      // route. `authToken` stays `null` in this scaffold — the null
      // provider ignores it, and how a token gets surfaced is left
      // for whenever a real provider lands.
      const session = await openTunnel(provider, {
        localUrl: hubUrl.replace(/\/hub$/, ''),
        authToken: null,
        project: {
          slug: bootstrap.manifest.app.slug,
          name: bootstrap.manifest.app.name,
        },
        runtimePort: bootstrap.runtimePort,
        signal: tunnelController.signal,
      });
      banner.push(...describeTunnelSession(session));
      if (session.status === 'ready') {
        tunnelShutdown.close = async () => {
          tunnelController.abort();
          await session.close();
        };
      }
    }

    banner.push('');
    process.stdout.write(`${banner.join('\n')}\n`);

    // Keep the process alive while the server runs. SIGINT / SIGTERM
    // shut the server down and resolve the promise so the bin exits
    // with code 0. The tunnel session (if any) is closed before the
    // server so the managed layer drops BEFORE the host it wraps.
    await waitForShutdown(bootstrap.server, tunnelShutdown);
    return 0;
  } catch (error) {
    if (error instanceof GguiDevError) {
      process.stderr.write(`ggui dev: ${error.message}\n`);
      return 1;
    }
    if (error instanceof GguiJsonLoadError) {
      process.stderr.write(`ggui dev: ${error.message}\n`);
      if (error.cause && error.cause instanceof Error) {
        process.stderr.write(`  cause: ${error.cause.message}\n`);
      }
      return 1;
    }
    throw error;
  }
}

async function waitForShutdown(
  server: { close(): Promise<void> },
  tunnel: { close: (() => Promise<void>) | null },
): Promise<void> {
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      // Close the managed layer FIRST so it drops cleanly before
      // the host it wraps. If no tunnel is active `tunnel.close`
      // is null and this step is a no-op. Errors inside the tunnel
      // teardown never block the server close — the local loop
      // ending cleanly is the priority.
      const tunnelCloseP = tunnel.close
        ? tunnel.close().catch(() => {
            /* best-effort */
          })
        : Promise.resolve();
      tunnelCloseP.then(() => server.close().finally(resolve));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

/**
 * Choose a `TunnelProvider` for managed-mode.
 *
 * Decision tree:
 *
 *   1. Attempt provider discovery via `GGUI_TUNNEL_PROVIDER` (explicit
 *      override). Users / hosts / CI pipelines can swap in alternate
 *      providers this way without recompiling the CLI.
 *
 *   2. If no explicit override is set, return a null provider with
 *      a "not configured" hint. The CLI does not bundle a canonical
 *      default; a replacement will land with the managed-tunnel
 *      transport (Cloudflare tunnel, Tailscale funnel, ...).
 *
 * The open CLI never imports from a closed tunnel package directly;
 * the discovery layer is the only path through which a real provider
 * reaches `ggui dev --tunnel`.
 */
async function selectTunnelProvider(): Promise<TunnelProvider> {
  // Step 1 -- explicit override via GGUI_TUNNEL_PROVIDER.
  const envDiscovery = await discoverTunnelProvider();
  switch (envDiscovery.kind) {
    case 'found':
      return envDiscovery.provider;
    case 'error':
      return createNullTunnelProvider({
        reason: `tunnel provider discovery failed`,
        hint: envDiscovery.reason,
      });
    case 'none':
      // Fall through to "not configured".
      break;
  }

  // Step 2 -- no canonical default currently. Surface the
  // "not configured" state with an actionable hint.
  return createNullTunnelProvider({
    reason: 'no tunnel provider configured',
    hint:
      '--tunnel: no provider configured. ' +
      'Set GGUI_TUNNEL_PROVIDER to a module that exports ' +
      'createTunnelProvider(), or omit --tunnel to keep local dev.',
  });
}

function readVersion(): string {
  // `package.json` sits one level above the compiled `dist/cli.js`.
  // Read it via `import.meta.url` so the code works identically in
  // dev (tsc `dist/`) and after an `npm publish` unpack.
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, '..', 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

main(process.argv).then(
  (code) => {
    process.exit(code);
  },
  (error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`ggui: ${message}\n`);
    process.exit(2);
  },
);
