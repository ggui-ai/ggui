/**
 * `runDev` — orchestration entry point for the shared open dev
 * engine. The `@ggui-ai/cli` bin and any other host that wants to
 * bring up the full local dev loop (registry + HTTP + SSE + auth)
 * calls this function and keeps the returned handle alive.
 *
 * Responsibilities:
 *
 *   1. Find the project's `ggui.json` by walking up from `cwd`.
 *   2. Load + validate it via `@ggui-ai/project-config/node`.
 *   3. Discover the UIs under `blueprints.include`.
 *   4. Build a `LocalUiRegistry` and (optionally) start the HTTP
 *      server with a bearer-gated policy.
 *   5. Print a concrete summary so the developer can confirm what
 *      the engine actually sees.
 *
 * Optional: when the caller passes an
 * {@link AgentRuntimeAdapter} via `options.runtime`, the dev stack
 * calls `runtime.start(...)` after the HTTP server is listening
 * and ties the runtime's lifetime to the server's close. No agent
 * framework is hardcoded — the seam is framework-neutral.
 *
 * Kept deliberately narrow: the host (CLI, future `ggui dev
 * --tunnel`, the local hub) owns arg parsing, log formatting beyond
 * the baseline summary, and the decision of which runtime adapter
 * to supply. `runDev` is the single seam every local-dev host
 * composes against.
 */
import { dirname, resolve } from 'node:path';
import {
  discoverFromGguiJsonPath,
  findGguiJson,
  loadGguiJson,
  type DiscoveryResult,
} from '@ggui-ai/project-config/node';
import type { GguiJsonV1 } from '@ggui-ai/project-config';
import type {
  AgentRuntimeAdapter,
  AgentRuntimeHandle,
} from '@ggui-ai/agent-runtime';
import { LocalUiRegistry } from './local-registry/local-registry.js';
import { startDevServer, type DevServerHandle } from './dev-server/http.js';
import { createSecurityPolicy } from './dev-server/auth.js';
import {
  RuntimeSupervisor,
  formatRuntimeEventLine,
} from './runtime-supervisor.js';

/** Default port the read-only dev registry binds to. */
export const DEFAULT_DEV_PORT = 6780;
/** Default bind address. Loopback-only so LAN peers can't reach the dev server by accident. */
export const DEFAULT_DEV_HOST = '127.0.0.1';

/**
 * Options the command accepts. All optional — the zero-config call
 * (`runDev({})`) uses `process.cwd()` and stdout.
 */
export interface DevOptions {
  /**
   * Where to start looking for `ggui.json`. Defaults to
   * `process.cwd()`. Useful for tests and programmatic embeds.
   */
  cwd?: string;

  /**
   * Writer for informational output. Defaults to `console.log`. The
   * command never writes to stderr from success paths — errors
   * throw so the caller decides how to render them.
   */
  log?: (line: string) => void;

  /**
   * Don't start the HTTP dev server; just load + discover and
   * return. Tests use this to keep the runner fast; the CLI leaves
   * it off so `ggui dev` actually serves.
   */
  serve?: boolean;

  /** Bind port. Defaults to {@link DEFAULT_DEV_PORT}. `0` = OS-assigned. */
  port?: number;

  /** Bind host. Defaults to {@link DEFAULT_DEV_HOST} (loopback). */
  host?: string;

  /**
   * Optional port the supervised agent runtime should bind. When
   * provided AND `options.runtime` is supplied, the dev stack:
   *
   *   1. Sets `PORT=<runtimePort>` in the runtime's start env. This
   *      matches the convention every `ggui dev` agent template
   *      already respects (and Node's default `process.env.PORT`
   *      idiom).
   *   2. Surfaces the same value as
   *      {@link AgentRuntimeStartInput.portHint} so adapters that
   *      don't read `PORT` directly can still honour it.
   *   3. Echoes the chosen port on {@link DevBootstrap.runtimePort}
   *      so the CLI orchestration layer can forward it to a
   *      {@link TunnelProvider}.
   *
   * `undefined` preserves the current behaviour — the agent picks
   * whatever port it wants, and the dev-stack doesn't care.
   *
   * This is narrow scope on purpose: the dev-stack only *forwards*
   * the port; the CLI owns allocation + tunnel-side use.
   */
  runtimePort?: number;

  /**
   * Optional agent runtime adapter. When present AND `serve !== false`,
   * the dev stack calls `runtime.start(...)` after the HTTP registry
   * is listening and tears it down on `server.close()`. The returned
   * {@link DevBootstrap.runtime} exposes the live handle so callers
   * (CLI banner, the hub, custom supervisors) can subscribe to
   * status / log events.
   *
   * Leaving this out runs the UI loop only — the pre-supervision
   * shape `ggui dev` has shipped. Framework-specific adapters
   * (Claude Agent SDK, OpenAI Agents, etc.) live in their own
   * packages; this seam is deliberately framework-neutral.
   */
  runtime?: AgentRuntimeAdapter;
}

/**
 * Result of a successful `ggui dev` bootstrap — the loaded manifest
 * + absolute path to its source. Returned so tests (and future
 * embedders) can drive the command without parsing stdout.
 */
export interface DevBootstrap {
  manifestPath: string;
  manifest: GguiJsonV1;
  /**
   * UIs discovered under `blueprints.include`. Malformed manifests
   * show up in `discovery.issues`; the command still boots so the
   * valid UIs are reachable.
   */
  discovery: DiscoveryResult;
  /**
   * Local registry wrapping the discovered UIs. Callers can query
   * `list()` / `get(id)` / `getBundle(id)` directly without going
   * through HTTP — useful for tests and embedders.
   */
  registry: LocalUiRegistry;
  /**
   * Running HTTP handle. Present iff `options.serve !== false`. Caller
   * is responsible for shutting it down via `server.close()` —
   * which also stops the supervised runtime when one is wired in.
   */
  server: DevServerHandle | null;
  /**
   * Live agent runtime handle when `options.runtime` was supplied.
   * `null` otherwise. Consumers MAY subscribe for status / log /
   * error events. Ownership stays with `runDev`: calling
   * `server.close()` stops the runtime before the HTTP socket
   * closes so there are no half-state races.
   */
  runtime: AgentRuntimeHandle | null;
  /**
   * Ring-buffered supervisor attached to {@link runtime}. Hosts
   * (CLI banner refresh, the hub snapshot endpoint, HTTP status
   * routes) call `runtimeSupervisor.snapshot()` for a consistent
   * point-in-time view without having to subscribe themselves.
   * `null` when no runtime was supplied OR the adapter's
   * `start()` threw.
   */
  runtimeSupervisor: RuntimeSupervisor | null;

  /**
   * The port the supervised agent runtime was asked to bind via
   * {@link DevOptions.runtimePort}. Echoed here so CLI-layer
   * orchestration (tunnel providers, banner renderers) can forward
   * it to downstream consumers without re-reading DevOptions.
   *
   * `null` when {@link DevOptions.runtimePort} was not set, OR when
   * `options.runtime` was absent (no agent to bind).
   *
   * Note: this is the *requested* port. The seam has no built-in
   * way for an adapter to report back the port it actually bound
   * on — adapters MUST honour `portHint` / `PORT` to keep this
   * value honest. Framework-specific adapters that can't comply
   * document that separately.
   */
  runtimePort: number | null;
}

export class GguiDevError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GguiDevError';
  }
}

/**
 * Boot the local dev stack up to the "manifest loaded" milestone.
 *
 * Throws {@link GguiDevError} when no `ggui.json` is found in the
 * walk. Re-throws the underlying `GguiJsonLoadError` from
 * `@ggui-ai/project-config/node` when the file exists but fails to
 * load — callers can inspect `.cause` (a `ZodError` for schema
 * failures) for issue details.
 */
export async function runDev(options: DevOptions = {}): Promise<DevBootstrap> {
  const cwd = options.cwd ?? process.cwd();
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));

  const manifestPath = findGguiJson(cwd);
  if (!manifestPath) {
    throw new GguiDevError(
      `No ggui.json found walking up from ${cwd}. ` +
        `Run this command from inside a ggui project, or create a ggui.json at the project root.`,
    );
  }

  const manifest = loadGguiJson(manifestPath);

  log(`ggui dev — ${manifest.app.name} (${manifest.app.slug})`);
  log(`  manifest: ${manifestPath}`);
  log(`  protocol: ${manifest.protocol}`);
  log(`  blueprints.include: ${describeList(manifest.blueprints.include)}`);
  log(`  primitives.packages: ${describeList(manifest.primitives.packages)}`);
  log(`  primitives.local: ${describeList(manifest.primitives.local)}`);
  log(`  theme: ${manifest.theme ?? '(default tokens)'}`);

  const discovery = await discoverFromGguiJsonPath(manifestPath, manifest);

  if (discovery.uis.length === 0 && discovery.issues.length === 0) {
    log(`  uis: (none discovered)`);
  } else {
    log(`  uis: ${discovery.uis.length} discovered`);
    for (const ui of discovery.uis) {
      log(`    - ${ui.id}  (${ui.manifest.name})`);
    }
  }

  if (discovery.issues.length > 0) {
    log(`  issues: ${discovery.issues.length}`);
    for (const issue of discovery.issues) {
      log(`    ! ${issue.path}: ${issue.message}`);
    }
  }

  // LocalUiRegistry re-runs discovery inside `refresh()`; reuse the
  // current result by handing it a ready state rather than doing the
  // same walk twice. Simplest: construct + refresh. Duplication cost
  // is one extra walk on startup, which is cheap and keeps the
  // registry's invariants (single source of truth) intact.
  const projectRoot = dirname(resolve(manifestPath));
  const registry = new LocalUiRegistry({ projectRoot, manifest });
  await registry.refresh();

  let server: DevServerHandle | null = null;
  let runtime: AgentRuntimeHandle | null = null;
  let runtimeSupervisor: RuntimeSupervisor | null = null;
  if (options.serve !== false) {
    const security = createSecurityPolicy();
    server = await startDevServer({
      registry,
      manifest,
      port: options.port ?? DEFAULT_DEV_PORT,
      host: options.host ?? DEFAULT_DEV_HOST,
      security,
      // Late-binding accessor so `/runtime/*` sees a supervisor
      // that attaches AFTER the HTTP server is listening (current
      // ordering, by design — server up first so the developer
      // can reach `/health` even if the agent fails to boot).
      getRuntimeSupervisor: () => runtimeSupervisor,
    });
    log(`  registry: http://${server.host}:${server.port}`);
    log(`    GET /health               (no auth)`);
    log(`    GET /hub                  (no auth — local dev dashboard)`);
    log(`    GET /hub/preview?ui=<id>  (no auth — preview iframe)`);
    log(`    GET /uis                  (Authorization: Bearer ...)`);
    log(`    GET /uis/:id              (Authorization: Bearer ...)`);
    log(`    GET /uis/:id/bundle       (Authorization: Bearer ...)`);
    log(`    GET /events               (SSE, Authorization: Bearer ...)`);
    if (security.tokenGenerated) {
      log(`  token (generated): ${security.token}`);
      log(`    export GGUI_DEV_TOKEN=${security.token}`);
    } else {
      log(`  token: (from GGUI_DEV_TOKEN — not echoed)`);
    }

    if (options.runtime) {
      // Supervision is additive — if `start()` throws we surface the
      // error but leave the HTTP server up so the developer can still
      // read the logged cause. Callers that want strict start-or-fail
      // wrap `runDev` and close the server on rejection.
      try {
        runtime = await options.runtime.start({
          projectRoot,
          project: {
            slug: manifest.app.slug,
            name: manifest.app.name,
            protocol: manifest.protocol,
          },
          // Forward the caller-requested runtime port two ways:
          //   - `portHint` — honoured by `@ggui-ai/agent-runtime`'s
          //     process adapter and any adapter that reads the seam's
          //     own port field.
          //   - `env.PORT` — honoured by the broad Node / framework
          //     convention. Matches what `ggui dev` and its closed-CLI
          //     predecessor have always passed to the supervised agent.
          //
          // An adapter that respects EITHER path will bind on the
          // right port. An adapter that respects NEITHER is a
          // framework-specific bug, not a dev-stack concern.
          ...(options.runtimePort !== undefined
            ? {
                portHint: options.runtimePort,
                env: { PORT: String(options.runtimePort) },
              }
            : {}),
        });
        log(`  runtime: ${options.runtime.name} (${runtime.runId})`);
        log(`    GET /runtime/status       (Authorization: Bearer ...)`);
        log(`    GET /runtime/events       (Authorization: Bearer ...)`);
        // Attach the supervisor AFTER we've logged the banner line
        // so event-line forwarding doesn't race the header. The
        // supervisor keeps a bounded ring of events for any host
        // that wants a snapshot (CLI status refresh, the dev hub,
        // the HTTP `/runtime/...` surface).
        runtimeSupervisor = new RuntimeSupervisor({
          adapter: options.runtime,
          handle: runtime,
          onEvent: (event) => log(`  ${formatRuntimeEventLine(event)}`),
        });
        // Tie the runtime's lifetime to the server's close. The
        // server's existing `close()` already sequences registry
        // shutdown + socket teardown; we pre-sequence runtime stop
        // in front of both so a runtime holding open sockets / child
        // processes has a chance to exit cleanly before the dev
        // server terminates its own connections.
        const innerClose = server.close.bind(server);
        server.close = async () => {
          if (runtime) {
            try {
              await runtime.stop();
            } catch {
              // A runtime that fails to stop must not keep the HTTP
              // server alive; swallow and continue. Callers that
              // care can subscribe to the runtime's error events.
            }
          }
          runtimeSupervisor?.close();
          await innerClose();
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`  runtime: failed to start — ${message}`);
      }
    }
  }

  return {
    manifestPath,
    manifest,
    discovery,
    registry,
    server,
    runtime,
    runtimeSupervisor,
    // Surface only when both a runtime was supplied AND the caller
    // asked for a specific port. An absent runtime means nothing to
    // bind; an unset `runtimePort` means the caller didn't care.
    runtimePort: options.runtime && options.runtimePort !== undefined ? options.runtimePort : null,
  };
}

function describeList(items: readonly string[]): string {
  if (items.length === 0) return '(none)';
  return items.join(', ');
}
