/**
 * `ggui dev` argument parsing + runtime resolution + browser auto-open.
 *
 * Extracted from `cli.ts` so the pure logic (flag parsing, agent
 * entry → command mapping, hub URL resolution, auto-open decision)
 * is unit-testable without importing the bin's top-level `main()`
 * side effect. The bin itself stays tiny.
 *
 * Browser auto-open lives here (the CLI layer) intentionally —
 * `@ggui-ai/dev-stack` keeps owning the server/runtime stack; only
 * the `ggui` binary decides "a human is driving this, open a tab."
 * Other hosts (the future `guuey dev` shim, a hub spawned from a
 * tunnel, a test harness) pick their own launch policy.
 */
import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process';
import { DEFAULT_DEV_HOST, DEFAULT_DEV_PORT } from '@ggui-ai/dev-stack';
import {
  buildAgentRuntime,
  resolveAgentCommand,
  type AgentCommandResolution,
} from './agent-resolution.js';
import type {
  TunnelContext,
  TunnelProvider,
  TunnelSession,
  TunnelSessionReady,
  TunnelSessionUnavailable,
} from './tunnel-provider.js';

export interface ParsedDevFlags {
  port?: number;
  host?: string;
  noServe: boolean;
  noOpen: boolean;
  /**
   * Opt into managed-mode. When true, the CLI orchestration calls
   * the configured `TunnelProvider` after the local dev stack is
   * listening. The local loop always runs unchanged — `--tunnel`
   * only adds the managed layer above it.
   */
  tunnel: boolean;
  agent?: string;
  /** `'__help__'` for `--help` / `-h`; other strings = usage error. */
  error?: string;
}

/**
 * Parse the raw `ggui dev` argv tail. Returns a discriminated
 * shape — `error` field is non-undefined when the input was
 * malformed (`'__help__'` is the help sentinel, mirroring
 * `parseServeFlags`); callers render it and bail with exit code 1.
 */
export function parseDevFlags(args: readonly string[]): ParsedDevFlags {
  const out: ParsedDevFlags = { noServe: false, noOpen: false, tunnel: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--no-serve') {
      out.noServe = true;
      continue;
    }
    if (arg === '--no-open') {
      out.noOpen = true;
      continue;
    }
    if (arg === '--tunnel') {
      out.tunnel = true;
      continue;
    }
    if (arg === '--port') {
      const v = args[++i];
      if (v === undefined) return { ...out, error: '--port requires a value' };
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 65535) {
        return { ...out, error: `--port must be an integer in [0, 65535], got "${v}"` };
      }
      out.port = n;
      continue;
    }
    if (arg === '--host') {
      const v = args[++i];
      if (v === undefined) return { ...out, error: '--host requires a value' };
      out.host = v;
      continue;
    }
    if (arg === '--agent') {
      const v = args[++i];
      if (v === undefined || v.length === 0) {
        return { ...out, error: '--agent requires an entry file path' };
      }
      out.agent = v;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      return { ...out, error: '__help__' };
    }
    return { ...out, error: `unknown flag "${arg ?? ''}"` };
  }
  return out;
}

/** Help text for `ggui dev` — printed on `--help` / `-h`. */
export const DEV_HELP = `ggui dev — run the local development stack

Boots the local dev hub (UI registry + dev server) and, when
\`--agent\` is supplied, supervises your agent entry alongside it.
Sets GGUI_MODE=dev (unless already set) so the server mounts the
/devtools/* namespace and the SPA shows the link. In an interactive
terminal the hub URL auto-opens in your browser (skipped in CI, when
stdout is piped, with BROWSER=none, or with --no-open).

Usage:
  ggui dev [options]

Options:
  --port <n>        Bind port (default: ${DEFAULT_DEV_PORT}, 0 = OS-assigned).
  --host <addr>     Bind host (default: ${DEFAULT_DEV_HOST}).
  --agent <entry>   Agent entry file to supervise (e.g. src/agent.ts).
                    Resolved before the socket binds — bad paths fail fast.
  --no-serve        Do not bind the HTTP dev hub; run registry-only.
  --no-open         Skip the browser auto-open.
  --tunnel          Opt into managed-mode: after the local stack is
                    listening, the configured tunnel provider exposes it
                    remotely. The local loop runs unchanged either way.
  --help, -h        Show this help.
`;

// Agent-entry resolution + adapter construction live in
// `./agent-resolution.ts`. They are re-exported here so call sites
// that reach for these from `dev-command.js` keep working — and
// because `--agent` is conceptually a dev-command concern, even
// though the same helpers also back `ggui serve`.
export { resolveAgentCommand, buildAgentRuntime };
export type { AgentCommandResolution };

/**
 * Build the URL the local hub is reachable at. Normalises
 * wildcard bind addresses (`0.0.0.0` / `::`) to `127.0.0.1` so
 * the link is actually clickable — the dev's browser can't dial
 * `0.0.0.0`. Loopback host binds pass through unchanged.
 */
export function resolveHubUrl(host: string, port: number): string {
  const safeHost =
    host === '0.0.0.0' || host === '::' || host === '' ? '127.0.0.1' : host;
  return `http://${safeHost}:${port}/hub`;
}

/** Inputs that drive the auto-open decision. Pure data so tests
 * exercise every branch without touching real env / stdio. */
export interface AutoOpenContext {
  /** `true` when the command is serving a real HTTP port. The
   * `--no-serve` path never opens anything. */
  readonly serving: boolean;
  /** `true` when the user passed `--no-open` — the explicit
   * escape hatch. Highest-precedence skip reason. */
  readonly noOpen: boolean;
  /** Whether the CLI's stdout is attached to an interactive TTY.
   * Pipelines and detached contexts set this to `false`. */
  readonly isTty: boolean;
  /** Process env — read here so tests can substitute. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * Auto-open policy — `shouldAutoOpen` returns a discriminated
 * decision. The `reason` field is both a test hook and a human
 * diagnostic the CLI prints when it decides NOT to open. Never
 * returns an error; the only shape is `{ open: boolean; reason }`.
 *
 * Rules (first-match wins):
 *
 *   1. `noOpen=true`     → explicit `--no-open`.
 *   2. `serving=false`   → no server to open.
 *   3. `CI=<truthy>`     → CI runner; headless by convention.
 *   4. `BROWSER=none`    → explicit opt-out (create-react-app / expo
 *                          pattern).
 *   5. `isTty=false`     → piped / daemonised; probably scripted.
 *   6. otherwise         → open.
 */
export function shouldAutoOpen(ctx: AutoOpenContext): {
  open: boolean;
  reason: string;
} {
  if (ctx.noOpen) return { open: false, reason: '--no-open set' };
  if (!ctx.serving) return { open: false, reason: '--no-serve set' };
  const ci = ctx.env.CI;
  if (ci && ci !== '' && ci !== '0' && ci.toLowerCase() !== 'false') {
    return { open: false, reason: `CI env detected (CI=${ci})` };
  }
  if (ctx.env.BROWSER === 'none') {
    return { open: false, reason: 'BROWSER=none' };
  }
  if (!ctx.isTty) {
    return { open: false, reason: 'stdout is not a TTY' };
  }
  return { open: true, reason: 'interactive dev session' };
}

/**
 * Browser launcher — best-effort, cross-platform, dep-free.
 *
 *   - Honours `$BROWSER` when set (and not `'none'`), so users who
 *     explicitly pick a browser get their choice.
 *   - Otherwise delegates to the platform's standard opener:
 *       darwin  → `open <url>`
 *       win32   → `cmd /c start "" <url>`   (empty title avoids the
 *                                            first quoted arg being
 *                                            consumed as the window
 *                                            title — a Windows gotcha)
 *       other   → `xdg-open <url>`
 *   - Child is spawned detached with stdio ignored so our parent
 *     process is free to exit / stay alive independently; `unref()`
 *     ensures the event loop doesn't wait on it.
 *   - Async spawn errors (ENOENT when `xdg-open` isn't installed on
 *     a minimal Linux image) are caught on the `error` event — we
 *     don't surface them because by the time they fire the caller
 *     has already printed the URL and returned; they're purely
 *     cosmetic.
 *
 * Return value semantics:
 *   `ok: true`   — spawn was dispatched without a synchronous throw.
 *                  (Actual browser launch may still fail async.)
 *   `ok: false`  — synchronous spawn throw (invalid command, etc.).
 *                  Caller should treat this as "no browser opened"
 *                  and hint at the URL.
 */
export interface LaunchBrowserOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  /** Seam for tests — receives `(cmd, args)` and MUST return a
   * `ChildProcess`-shaped object with `.on()` + `.unref()`. */
  readonly spawner?: Spawner;
}

type Spawner = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export type LaunchBrowserResult =
  | { ok: true; command: string; args: readonly string[] }
  | { ok: false; error: string };

export function launchBrowser(
  url: string,
  options: LaunchBrowserOptions = {},
): LaunchBrowserResult {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const spawn = options.spawner ?? (nodeSpawn as unknown as Spawner);

  const resolved = resolveLaunchCommand(url, platform, env);

  try {
    const child = spawn(resolved.command, resolved.args, {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    });
    // Async ENOENT / permission errors arrive here; swallow so they
    // don't crash the CLI's unhandled-rejection path. The URL is
    // already on screen.
    child.on('error', () => {
      /* best-effort; user still has the URL */
    });
    child.unref();
    return { ok: true, command: resolved.command, args: resolved.args };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Orchestrate a `TunnelProvider.open(ctx)` call.
 *
 * Why this exists as a narrow helper:
 *
 *   - Keeps `cli.ts` free of provider-result branching — the bin
 *     just prints the result line and wires `close()` to shutdown.
 *   - Collapses any thrown error into an `unavailable` session so
 *     `cli.ts` has a single shape to render. Per contract, a
 *     well-behaved provider never throws for missing
 *     configuration; but we defend against a buggy provider to
 *     preserve the "local dev must never break" invariant.
 *   - Ignores the `ctx` shape knowledge: callers pass a prepared
 *     `TunnelContext`, and this function stays pure (no env,
 *     stdio, or network access).
 */
export async function openTunnel(
  provider: TunnelProvider,
  ctx: TunnelContext,
): Promise<TunnelSession> {
  try {
    const session = await provider.open(ctx);
    // Defensive check — the seam's contract says `open` returns a
    // discriminated session, but a misbehaving provider could
    // return `undefined` / a malformed object. Collapse to
    // `unavailable` rather than letting `cli.ts` crash trying to
    // read `.status` on a non-object.
    if (
      session &&
      typeof session === 'object' &&
      'status' in session &&
      (session.status === 'ready' || session.status === 'unavailable')
    ) {
      return session;
    }
    return {
      status: 'unavailable',
      reason: `tunnel provider "${provider.name}" returned an invalid session shape`,
    };
  } catch (err) {
    return {
      status: 'unavailable',
      reason: `tunnel provider "${provider.name}" threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Describe a `TunnelSession` as lines ready for the CLI banner.
 * Pure function — no stdio access. Tests pin the exact copy so
 * banner drift is caught in review.
 *
 * Shape:
 *
 *   ready       → `[' tunnel  →  https://…']`
 *   unavailable → `[' tunnel skipped: <reason>', '         hint: <hint>']`
 *                 (hint line is omitted when `hint` is undefined)
 */
export function describeTunnelSession(session: TunnelSession): string[] {
  if (session.status === 'ready') {
    return [`  tunnel  →  ${session.remoteUrl}`];
  }
  const lines = [`  tunnel skipped: ${session.reason}`];
  if (session.hint) {
    lines.push(`          hint: ${session.hint}`);
  }
  return lines;
}

/**
 * Narrow alias surfaces so `cli.ts` can import a single type name
 * when handling a ready session. Kept here (next to `openTunnel`)
 * so the CLI doesn't have to reach into the seam module.
 */
export type { TunnelProvider, TunnelSession, TunnelSessionReady, TunnelSessionUnavailable, TunnelContext };

/** Pure command resolver — split out so tests can pin platform
 * branches without actually spawning. */
export function resolveLaunchCommand(
  url: string,
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): { command: string; args: readonly string[] } {
  const custom = env.BROWSER;
  if (custom && custom !== 'none') {
    return { command: custom, args: [url] };
  }
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') {
    // Empty string after 'start' is the window title — without it
    // Windows treats the URL as the title and drops the real arg.
    return { command: 'cmd', args: ['/c', 'start', '', url] };
  }
  return { command: 'xdg-open', args: [url] };
}
