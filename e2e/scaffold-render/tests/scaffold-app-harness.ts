/**
 * Boots the SCAFFOLDED published app for the sub-tier-B render + cache-hit
 * scenarios. `spawnScaffoldedApp({sdk})` runs the shared setup once
 * (build → Verdaccio → publish → assemble), then scaffolds + installs + boots
 * the app's `pnpm dev` (4 servers), and resolves once the web server answers.
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

export interface ScaffoldAppHandle {
  /** http://localhost:6890 — the Vite SPA (render scenario). */
  readonly webUrl: string;
  /** http://localhost:6781 — the ggui MCP server (cache-hit scenario). */
  readonly gguiUrl: string;
  /**
   * http://localhost:679x — the agent backend for this SDK (claude 6790,
   * openai 6791, google 6792). The web SPA resolves its agent from a
   * `?agent=` query param FIRST (App.tsx), so the render scenario navigates
   * to `${webUrl}/?agent=${agentUrl}` — robust against the env not reaching
   * vite (`dev:web` runs plain vite, which never reads the app-root .env.local).
   */
  readonly agentUrl: string;
  /** Absolute path of the scaffolded app dir. */
  readonly scaffoldDir: string;
  /** All script stdout/stderr captured so far — for failure dumps. */
  stdout(): string;
  /** Tear down the whole `pnpm dev` tree and wait for the ports to free. */
  close(): Promise<void>;
}

const ROOT = resolve(__dirname, '../../../..');
const SETUP = resolve(ROOT, 'oss/e2e/scaffold-render/scripts/setup.sh');
const BOOT = resolve(ROOT, 'oss/e2e/scaffold-render/scripts/scaffold-and-boot.sh');
const REGISTRY = process.env['REGISTRY'] ?? 'http://localhost:4874';

// Fixed host ports the scaffolded `pnpm dev` binds: ggui 6781, mcps 6782,
// agent 6790/6791/6792 (per SDK: claude/openai/google), web 6890. One booted
// app at a time host-side (Playwright workers:1); the container cells give each
// SDK its own localhost so the matrix can run without colliding.
const WEB_PORT = 6890;
const GGUI_PORT = 6781;
// Per-SDK agent backend port (dev.mjs AGENT_PORT, fixed per shell).
const AGENT_PORT: Record<SdkId, number> = {
  'claude-agent-sdk': 6790,
  'openai-agents-sdk': 6791,
  'google-adk': 6792,
};
// All ports any SDK's dev tree may bind — checked on teardown so a leak from
// any agent variant (6790/6791/6792) is caught, not just claude's.
const APP_PORTS: readonly number[] = [GGUI_PORT, 6782, 6790, 6791, 6792, WEB_PORT];

// build + publish + assemble runs ONCE per worker process; cache the result.
let templatesSrc: string | undefined;

async function ensureSetup(): Promise<string> {
  if (templatesSrc) return templatesSrc;
  const work = mkdtempSync(join(tmpdir(), 'scaffold-render-'));
  const src = join(work, 'tpl');
  await run('bash', [SETUP], { ...process.env, TEMPLATES_SRC: src, REGISTRY });
  templatesSrc = src;
  return src;
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

async function assertPortsFree(): Promise<void> {
  // A stale server from a sibling worktree on 6781/6890 would make our
  // readiness poll latch onto the WRONG process (a false green). Fail loudly
  // before booting. (See the e2e-stale-servers-across-worktrees hazard.)
  for (const port of [GGUI_PORT, WEB_PORT]) {
    if (await isAnswering(`http://localhost:${port}`)) {
      throw new Error(
        `port ${port} is already answering before boot — a stale ggui/dev server ` +
          `(likely a sibling worktree) holds it. Kill it first ` +
          `(e.g. \`lsof -ti:${port} | xargs -r kill\`, or \`pnpm dev:stop\` in that app).`,
      );
    }
  }
}

export async function spawnScaffoldedApp(opts: { sdk: SdkId }): Promise<ScaffoldAppHandle> {
  await assertPortsFree();
  const tpl = await ensureSetup();
  const appBase = mkdtempSync(join(tmpdir(), `app-${opts.sdk}-`));
  const appDir = join(appBase, 'app');
  let buf = '';
  const child: ChildProcess = spawn('bash', [BOOT], {
    env: { ...process.env, SDK: opts.sdk, APP_DIR: appDir, TEMPLATES_SRC: tpl, REGISTRY },
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
  const gguiUrl = `http://localhost:${GGUI_PORT}`;
  // Wait for BOTH web (render scenario) AND ggui (cache-hit hits it directly).
  // The 4 servers boot in parallel; ggui can lag web, so a web-only wait races
  // the cache-hit's first MCP call → ECONNREFUSED on 6781.
  const ready = await waitForReady([webUrl, gguiUrl], child, () => buf);
  if (!ready) {
    await killGroup(child);
    throw new Error(
      `scaffolded app (${opts.sdk}) did not become ready. Recent output:\n${buf.slice(-3000)}`,
    );
  }

  return {
    webUrl,
    gguiUrl,
    agentUrl: `http://localhost:${AGENT_PORT[opts.sdk]}`,
    scaffoldDir: appDir,
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
  // scaffold install + 4-server boot. The one-time build+publish+assemble is
  // already done by ensureSetup before this is called.
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `scaffold-and-boot exited early (code ${child.exitCode}). Output:\n${dump().slice(-3000)}`,
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
      console.warn(`[scaffold-render] failed to ${sig} process group ${pid}: ${code ?? String(e)}`);
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
  // the next spawnScaffoldedApp's assertPortsFree().
}
