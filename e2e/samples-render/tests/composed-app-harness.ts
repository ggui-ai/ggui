/**
 * Boots the COMPOSED published-cohort app for the sub-tier-B render, cache-hit
 * and seed-pool scenarios. `spawnComposedApp({sdk})` runs the shared setup once
 * (build → Verdaccio → publish), then composes the app directly from
 * `oss/samples/*` (compose-app.mjs), installs + boots its `pnpm dev`
 * (4 servers), and resolves once the web server answers.
 *
 * Not a spec — no `.spec.`/`.test.` suffix, so Playwright's testMatch skips it.
 *
 * Teardown is load-bearing: `dev.mjs` spawns its 4 servers in their OWN
 * detached process groups and only tears them down via its own SIGTERM
 * handler. So `close()` SIGTERMs the script's group (which reaches the
 * `pnpm dev` → node dev.mjs process), lets dev.mjs drain its children, and
 * only SIGKILLs as a backstop. A direct SIGKILL would skip dev.mjs's handler
 * and ORPHAN all four servers, holding ports 6781/6782/6790/6890 for the next
 * run. `close()` then waits for the ports to actually free.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export type SdkId = 'claude-agent-sdk' | 'openai-agents-sdk' | 'google-adk';

export interface ComposedAppHandle {
  /** http://localhost:6890 — the Vite SPA (render scenario). */
  readonly webUrl: string;
  /** http://localhost:6781 — the ggui MCP server (cache-hit scenario). */
  readonly gguiUrl: string;
  /**
   * http://localhost:6790 — the agent backend, unified across all SDK variants
   * (dev.mjs). The web SPA resolves its agent from a `?agent=` query param
   * FIRST (App.tsx), so the render scenario navigates to
   * `${webUrl}/?agent=${agentUrl}` — robust against the env not reaching vite
   * (`dev:web` runs plain vite, which never reads the app-root .env.local).
   */
  readonly agentUrl: string;
  /** Absolute path of the composed app dir. */
  readonly appDir: string;
  /** All script stdout/stderr captured so far — for failure dumps. */
  stdout(): string;
  /** Tear down the whole `pnpm dev` tree and wait for the ports to free. */
  close(): Promise<void>;
}

const ROOT = resolve(__dirname, '../../../..');
const SETUP = resolve(ROOT, 'oss/e2e/samples-render/scripts/setup.sh');
const BOOT = resolve(ROOT, 'oss/e2e/samples-render/scripts/compose-and-boot.sh');
const REGISTRY = process.env['REGISTRY'] ?? 'http://localhost:4874';

// Fixed host ports the composed `pnpm dev` binds: ggui 6781, mcps 6782,
// agent 6790 (unified across SDKs), web 6890. One booted app at a time
// host-side (Playwright workers:1); the container cell gives the app its own
// localhost.
const WEB_PORT = 6890;
const GGUI_PORT = 6781;
// Agent backend port — unified to 6790 across all SDK variants (dev.mjs AGENT_PORT).
const AGENT_PORT = 6790;
// All ports the composed dev tree binds — checked on teardown so a leak is
// caught before the next boot.
const APP_PORTS: readonly number[] = [GGUI_PORT, 6782, AGENT_PORT, WEB_PORT];

// build + publish runs ONCE per worker process; latch the result.
let setupDone = false;

async function ensureSetup(): Promise<void> {
  if (setupDone) return;
  const t0 = Date.now();
  await run('bash', [SETUP], { ...process.env, REGISTRY });
  setupDone = true;
  // eslint-disable-next-line no-console -- per-step timing in the run log.
  console.log(`[harness] ⏱ one-time setup (build+publish): ${secs(t0)}s`);
}

/** Whole-second elapsed since `t0` (ms), for the ⏱ timing log lines. */
function secs(t0: number): string {
  return ((Date.now() - t0) / 1000).toFixed(1);
}

function run(cmd: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise<void>((res, rej) => {
    const c = spawn(cmd, [...args], { env, stdio: 'inherit' });
    c.on('error', rej);
    c.on('exit', (code) =>
      code === 0 ? res() : rej(new Error(`${cmd} ${args.join(' ')} exited ${code ?? 'null'}`)),
    );
  });
}

async function isAnswering(url: string): Promise<boolean> {
  try {
    const res = await fetch(url);
    await res.body?.cancel?.();
    return true;
  } catch {
    return false;
  }
}

async function assertPortsFree(remoteGgui = false): Promise<void> {
  // A stale server from a sibling worktree on these ports would make our
  // readiness poll latch onto the WRONG process (a false green). Fail loudly
  // before booting. (See the e2e-stale-servers-across-worktrees hazard.) In
  // remote-ggui (cloud) mode the local ggui (6781) is never booted, so it
  // drops out of the guard — but the AGENT port stays guarded in BOTH
  // modes: a stale agent-server on 6790 holds the PREVIOUS run's (torn
  // down) app endpoint + connector key and an empty chat store, which
  // reproduces the exact ggui#405 twin symptoms (relay failures + 404 on
  // a just-allocated chat) as a phantom.
  const guardedPorts = remoteGgui
    ? [AGENT_PORT, WEB_PORT]
    : [GGUI_PORT, AGENT_PORT, WEB_PORT];
  for (const port of guardedPorts) {
    if (await isAnswering(`http://localhost:${port}`)) {
      throw new Error(
        `port ${port} is already answering before boot — a stale ggui/dev server ` +
          `(likely a sibling worktree) holds it. Kill it first ` +
          `(e.g. \`lsof -ti:${port} | xargs -r kill\`, or \`pnpm dev:stop\` in that app).`,
      );
    }
  }
}

export async function spawnComposedApp(opts: {
  sdk: SdkId;
  /**
   * When true, the composed ggui server is configured with a persistent
   * `storage.vectors = { driver:'sqlite', … }` store (and `better-sqlite3`
   * added to its deps) by `compose-and-boot.sh`. Enables `ggui export-pool`
   * to read the generated blueprints back off disk. Default: in-memory.
   */
  sqliteVectors?: boolean;
  /**
   * Absolute path to a read-only shared blueprint-pool artifact directory.
   * When set, the composed ggui server boots with `--seed-pool <dir>` so
   * its blueprints are reused by exact contract match. Default: no shared pool.
   */
  seedPoolDir?: string;
  /**
   * Point the composed app's agent at a REMOTE ggui MCP endpoint (the
   * `ggui deploy` flow) instead of spawning a local `ggui serve`. When set,
   * `compose-and-boot.sh` writes `GGUI_MCP_URL` + `GGUI_MCP_BEARER` into the
   * app's `.env.local`; the shell `dev.mjs`'s `isRemoteGguiUrl` then SKIPS
   * the local ggui service (only mcps/agent/web boot) and the agent
   * authenticates to the remote pod with the bearer. Used by the
   * cross-deployment cloud-render capstone (monorepo-only) to drive the
   * deployed `mcp.ggui.ai/apps/<appId>` through the real browser loop.
   * Default: unset → boots a local ggui (existing behavior, unchanged).
   */
  cloudGgui?: { readonly mcpUrl: string; readonly bearer: string };
}): Promise<ComposedAppHandle> {
  const remote = opts.cloudGgui;
  await assertPortsFree(remote !== undefined);
  await ensureSetup();
  const bootStart = Date.now();
  const appBase = mkdtempSync(join(tmpdir(), `app-${opts.sdk}-`));
  const appDir = join(appBase, 'app');
  let buf = '';
  const child: ChildProcess = spawn('bash', [BOOT], {
    env: {
      ...process.env,
      SDK: opts.sdk,
      APP_DIR: appDir,
      REGISTRY,
      // Slice-1 measurement: emit [ggui:agentcaps] lines so render.spec can classify per-SDK serverInfo authoring.
      GGUI_AGENTCAPS_STDERR: '1',
      // Cross-deployment seed-pool e2e (env-gated; unset → identical behavior
      // for existing callers). compose-and-boot.sh reads these to (a) wire a
      // persistent sqlite vectors store + better-sqlite3, and (b) append
      // `--seed-pool <dir>` to the ggui start script.
      ...(opts.sqliteVectors ? { GGUI_STORAGE_SQLITE: '1' } : {}),
      ...(opts.seedPoolDir !== undefined ? { GGUI_SEED_POOL: opts.seedPoolDir } : {}),
      // Cross-deployment cloud-render capstone (env-gated; unset → local ggui).
      // compose-and-boot.sh writes these to .env.local; the shell dev.mjs's
      // isRemoteGguiUrl skips the local ggui service and the agent (which reads
      // GGUI_MCP_BEARER) authenticates to the remote pod. Pass them as real env
      // vars too so dev.mjs (which reads process.env.GGUI_MCP_URL) sees them.
      ...(remote ? { GGUI_MCP_URL: remote.mcpUrl, GGUI_MCP_BEARER: remote.bearer } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdout?.on('data', (d: Buffer) => {
    buf += d.toString();
  });
  child.stderr?.on('data', (d: Buffer) => {
    buf += d.toString();
  });

  const webUrl = `http://localhost:${WEB_PORT}`;
  // In remote-ggui (cloud) mode the local ggui service is skipped, so its URL
  // is the remote pod endpoint and nothing binds 6781 locally.
  const gguiUrl = remote ? remote.mcpUrl : `http://localhost:${GGUI_PORT}`;
  // Wait for BOTH web (render scenario) AND ggui (cache-hit hits it directly).
  // The 4 servers boot in parallel; ggui can lag web, so a web-only wait races
  // the cache-hit's first MCP call → ECONNREFUSED on 6781. In remote mode only
  // web/agent/mcps boot locally — wait on web alone (the remote pod is already up).
  const readyUrls = remote ? [webUrl] : [webUrl, gguiUrl];
  const ready = await waitForReady(readyUrls, child, () => buf);
  if (!ready) {
    await killGroup(child);
    throw new Error(
      `composed app (${opts.sdk}) did not become ready. Recent output:\n${buf.slice(-3000)}`,
    );
  }
  // eslint-disable-next-line no-console -- per-step timing in the run log.
  console.log(`[harness] ⏱ ${opts.sdk} compose+install+boot: ${secs(bootStart)}s`);

  return {
    webUrl,
    gguiUrl,
    agentUrl: `http://localhost:${AGENT_PORT}`,
    appDir,
    stdout: () => buf,
    close: async () => {
      await killGroup(child);
      await waitForPortsFree();
    },
  };
}

async function waitForReady(
  urls: readonly string[],
  child: ChildProcess,
  dump: () => string,
): Promise<boolean> {
  // compose + install + 4-server boot. The one-time build+publish is already
  // done by ensureSetup before this is called.
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `compose-and-boot exited early (code ${child.exitCode}). Output:\n${dump().slice(-3000)}`,
      );
    }
    const up = await Promise.all(urls.map((u) => isAnswering(u)));
    if (up.every(Boolean)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/**
 * Signal a process group. ESRCH (the group is already gone) is the expected,
 * benign case. Anything else (EPERM/EINVAL) means the kill genuinely failed —
 * the servers may still hold their ports — so surface it instead of swallowing.
 * We log rather than throw: teardown is best-effort, and a thrown teardown
 * would mask the real test outcome. A genuine leak still trips the next
 * spawn's assertPortsFree().
 */
function signalGroup(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pid, sig);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') {
      // eslint-disable-next-line no-console -- surface a real teardown failure.
      console.warn(`[samples-render] failed to ${sig} process group ${pid}: ${code ?? String(e)}`);
    }
  }
}

async function killGroup(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  const pid = child.pid;
  // SIGTERM the whole group so dev.mjs's handler tears down its detached
  // service groups cleanly; SIGKILL backstop after a grace if it wedges.
  signalGroup(pid, 'SIGTERM');
  await new Promise<void>((done) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      done();
    };
    child.once('exit', finish);
    setTimeout(() => {
      if (child.exitCode === null) signalGroup(pid, 'SIGKILL');
      finish();
    }, 8_000).unref();
  });
}

async function waitForPortsFree(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const states = await Promise.all(
      APP_PORTS.map((p) => isAnswering(`http://localhost:${p}`)),
    );
    if (!states.some(Boolean)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  // Best-effort: don't fail teardown here. A genuine leak surfaces loudly at
  // the next spawnComposedApp's assertPortsFree().
}
