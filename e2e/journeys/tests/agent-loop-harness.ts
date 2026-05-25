/**
 * Agent-loop harness — boots the three-process ggui demo
 * (ggui + mcp-todo + sample-agent) via workspace `pnpm --filter` against
 * `oss/samples/*`, then returns handles so a spec can drive the browser
 * against the agent's chat UI.
 *
 * Why this exists separately from `ggui-serve-harness.ts`:
 *
 *   - `ggui-serve-harness.ts` is a clean-room harness — fresh temp CWD,
 *     env-allowlist, no parent-tree `ggui.json`. Right for journeys that
 *     prove the OSS CLI works without monorepo coupling.
 *   - The agent-loop tests need the OPPOSITE — they're the dev-iteration
 *     mirror of the per-template Playwright suites. They want workspace
 *     `@ggui-ai/*` resolution so a triad edit (system prompt /
 *     boilerplate / evaluator) shows up immediately, and they want the
 *     three real sample processes (agent, ggui, todo) booted as a
 *     vertical slice. No clean-room invariants, no env scrub.
 *
 * Why these specs aren't just the templates' chat-smoke: templates pin
 * `@ggui-ai/*@0.1.0-rc.3` and resolve from npm/Verdaccio. That's a
 * publish-gate, not a dev path — every iteration needs rebuild +
 * republish + reinstall (~5 min/cycle). These specs target source
 * directly, so a triad edit is ~30s away from a live e2e signal.
 *
 * Beacons consumed:
 *   - ggui CLI       `READY http://<host>:<port>\n`
 *   - mcp-todo       `[mcp-todo] ready: http://localhost:<port>/mcp`
 *   - sample-agent   `[sample-agent] chat UI ready: http://localhost:<port>`
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Readable } from 'node:stream';

/**
 * Concrete child-process type — `stdio: ['ignore', 'pipe', 'pipe']`
 * gives null stdin, readable stdout, readable stderr. Spelling it out
 * here avoids a cast at the spawn site.
 */
type SpawnedChild = ChildProcessByStdio<null, Readable, Readable>;
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { PACKAGES_ROOT } from './workspace-paths';

/** Ports used by the harness. Match templates/* for parity. */
export const HARNESS_PORTS = {
  ggui: 6781,
  todo: 6782,
  /** Per-SDK agent port. */
  agent: {
    'claude-agent-sdk': 6790,
    'openai-agents-sdk': 6791,
    'google-adk': 6792,
  },
} as const;

/**
 * One of the three SDK identities. Drives which workspace package the
 * agent process is filtered to and which env var holds the BYOK key.
 */
export type SdkId = keyof typeof HARNESS_PORTS.agent;

/** Per-SDK constants — package filter + required BYOK env. */
const SDK_CONFIG: Record<
  SdkId,
  { agentPackage: string; byokEnvVars: readonly string[] }
> = {
  'claude-agent-sdk': {
    agentPackage: '@ggui-samples/agent-claude-sdk',
    byokEnvVars: ['ANTHROPIC_API_KEY'],
  },
  'openai-agents-sdk': {
    agentPackage: '@ggui-samples/agent-openai-sdk',
    byokEnvVars: ['OPENAI_API_KEY'],
  },
  'google-adk': {
    agentPackage: '@ggui-samples/agent-google-adk',
    // ADK accepts either; both forwarded for whichever the dev has.
    byokEnvVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  },
};

/** Workspace root (the monorepo root — one level above PACKAGES_ROOT=oss/). */
const WORKSPACE_ROOT = resolve(PACKAGES_ROOT, '..');

/** Handle returned by {@link spawnAgentLoop}. */
export interface AgentLoopHandle {
  /** The agent's chat UI base URL (what Playwright navigates to). */
  readonly agentUrl: string;
  /** ggui MCP base URL. */
  readonly gguiUrl: string;
  /** todo MCP base URL. */
  readonly todoUrl: string;
  /** Kill all 3 child processes. Idempotent. */
  close: () => Promise<void>;
  /** Captured stdout from each spawn, for failure dumps. */
  stdout: () => { ggui: string; todo: string; agent: string };
  /** Captured stderr from each spawn, for failure dumps. */
  stderr: () => { ggui: string; todo: string; agent: string };
}

export interface SpawnAgentLoopOptions {
  readonly sdk: SdkId;
}

/**
 * Spawn ggui + todo + agent in workspace mode. Resolves once all three
 * boot beacons are observed. Hard-throws on any beacon timeout — the
 * journey then fails fast and the spec dump prints captured stdio.
 */
export async function spawnAgentLoop(
  opts: SpawnAgentLoopOptions,
): Promise<AgentLoopHandle> {
  const cfg = SDK_CONFIG[opts.sdk];
  const ports = HARNESS_PORTS;
  const agentPort = ports.agent[opts.sdk];

  // Each child inherits the caller's PATH so `pnpm` resolves. BYOK keys
  // are forwarded — these journeys are explicitly NOT clean-room.
  const baseEnv = { ...process.env };

  // Confirm at least one BYOK key is present. Bail with a clean skip-
  // worthy error if not (spec layer can convert to test.skip).
  const hasBYOK = cfg.byokEnvVars.some((k) => baseEnv[k]?.trim());
  if (!hasBYOK) {
    throw new Error(
      `agent-loop harness: ${opts.sdk} requires one of ${cfg.byokEnvVars.join(' or ')} ` +
        `to be set in process env (BYOK). Add to monorepo .env.local.`,
    );
  }

  // Pre-flight: refuse to start if our ports are squatted. Express's
  // `app.listen(...,callback)` quirk fires the callback even when the
  // underlying http.Server emits EADDRINUSE, so the CLI surfaces port
  // collisions as a downstream "server.address() unexpected shape"
  // error that obscures the real cause. Catch it here with a clear
  // message instead.
  const portsToCheck: Array<{ port: number; label: string }> = [
    { port: ports.ggui, label: 'ggui' },
    { port: ports.todo, label: 'todo' },
    { port: agentPort, label: `agent (${opts.sdk})` },
  ];
  const squatted = portsToCheck.filter(({ port }) => portInUse(port));
  if (squatted.length > 0) {
    throw new Error(
      `agent-loop harness: port(s) already bound: ` +
        squatted.map(({ port, label }) => `${port} (${label})`).join(', ') +
        '. Free them before re-running (often a previous spec\'s orphan).',
    );
  }

  const procs: { ggui?: Proc; todo?: Proc; agent?: Proc } = {};
  let closed = false;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await Promise.all(
      Object.values(procs).map((p) => p && killProc(p.child)),
    );
  };

  try {
    // 1. ggui (workspace `@ggui-samples/ggui-default` → `ggui serve`)
    procs.ggui = spawnChild({
      label: 'ggui',
      pkg: '@ggui-samples/ggui-default',
      env: { ...baseEnv, PORT: String(ports.ggui) },
    });
    await waitForBeacon(procs.ggui, /READY http:\/\//, 60_000, 'ggui');

    // 2. mcp-todo
    procs.todo = spawnChild({
      label: 'todo',
      pkg: '@ggui-samples/mcp-todo',
      env: { ...baseEnv, PORT: String(ports.todo) },
    });
    await waitForBeacon(procs.todo, /\[mcp-todo\] ready:/, 30_000, 'todo');

    // 3. agent — vite-builds the chat UI bundle first; needs more time.
    procs.agent = spawnChild({
      label: opts.sdk,
      pkg: cfg.agentPackage,
      env: {
        ...baseEnv,
        PORT: String(agentPort),
        GGUI_MCP_URL: `http://localhost:${ports.ggui}/mcp`,
        GGUI_TODO_MCP_URL: `http://localhost:${ports.todo}/mcp`,
      },
    });
    await waitForBeacon(
      procs.agent,
      /\[sample-agent\] chat UI ready:/,
      120_000,
      'agent',
    );
  } catch (err) {
    await close();
    throw err;
  }

  return {
    agentUrl: `http://localhost:${agentPort}`,
    gguiUrl: `http://localhost:${ports.ggui}`,
    todoUrl: `http://localhost:${ports.todo}/mcp`,
    close,
    stdout: () => ({
      ggui: procs.ggui?.stdout() ?? '',
      todo: procs.todo?.stdout() ?? '',
      agent: procs.agent?.stdout() ?? '',
    }),
    stderr: () => ({
      ggui: procs.ggui?.stderr() ?? '',
      todo: procs.todo?.stderr() ?? '',
      agent: procs.agent?.stderr() ?? '',
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Internals

/**
 * Devcontainer-portable port-listen check. The hosts this harness runs
 * on don't have `lsof` or `ss`, so we read `/proc/net/tcp{,6}` directly
 * — state `0A` = LISTEN, local port is the hex tail of column 2.
 */
function portInUse(port: number): boolean {
  const hex = port.toString(16).toUpperCase().padStart(4, '0');
  const pattern = new RegExp(`:${hex} 0+:0000 0A `);
  for (const path of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      const data = readFileSync(path, 'utf8');
      if (pattern.test(data)) return true;
    } catch {
      /* /proc may be inaccessible — treat as port free, harness will
         surface the real EADDRINUSE during spawn. */
    }
  }
  return false;
}

interface Proc {
  readonly child: SpawnedChild;
  readonly label: string;
  stdout: () => string;
  stderr: () => string;
}

function spawnChild(opts: {
  label: string;
  pkg: string;
  env: NodeJS.ProcessEnv;
}): Proc {
  // `--filter` is run from the monorepo root so pnpm can resolve the
  // workspace graph — the samples live at `oss/samples/*/*` per
  // pnpm-workspace.yaml.
  if (!existsSync(WORKSPACE_ROOT)) {
    throw new Error(
      `agent-loop harness: workspace root missing at ${WORKSPACE_ROOT}`,
    );
  }
  const child: SpawnedChild = spawn(
    'pnpm',
    ['--filter', opts.pkg, '--silent', 'start'],
    {
      cwd: WORKSPACE_ROOT,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let outBuf = '';
  let errBuf = '';
  child.stdout.on('data', (c: Buffer) => {
    outBuf += c.toString('utf8');
  });
  child.stderr.on('data', (c: Buffer) => {
    errBuf += c.toString('utf8');
  });
  return {
    child,
    label: opts.label,
    stdout: () => outBuf,
    stderr: () => errBuf,
  };
}

async function waitForBeacon(
  proc: Proc,
  pattern: RegExp,
  timeoutMs: number,
  label: string,
): Promise<void> {
  return new Promise<void>((res, rej) => {
    let done = false;
    const tryMatch = (): void => {
      if (done) return;
      if (pattern.test(proc.stdout())) {
        done = true;
        clearTimeout(timer);
        res();
      }
    };
    const onData = (): void => tryMatch();
    proc.child.stdout.on('data', onData);
    proc.child.stderr.on('data', onData);
    proc.child.once('exit', (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      rej(
        new Error(
          `${label} exited before beacon (code=${code} signal=${signal}). ` +
            `stdout=\n${proc.stdout()}\nstderr=\n${proc.stderr()}`,
        ),
      );
    });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      rej(
        new Error(
          `${label} beacon ${pattern} not seen in ${timeoutMs}ms. ` +
            `stdout=\n${proc.stdout()}\nstderr=\n${proc.stderr()}`,
        ),
      );
    }, timeoutMs);
    // Cover the case where the beacon already arrived before we wired up
    // listeners (very fast boots can race).
    tryMatch();
  });
}

async function killProc(child: SpawnedChild): Promise<void> {
  if (child.killed || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((res) => {
    const onExit = (): void => res();
    child.once('exit', onExit);
    setTimeout(() => {
      try {
        if (!child.killed) child.kill('SIGKILL');
      } catch {
        /* best-effort */
      }
      res();
    }, 5_000);
  });
}

// startAgentLoopForSuite was removed — `test.afterAll` can't be
// registered from inside a `test.beforeAll` callback (Playwright restricts
// hook registration to describe scope). Specs MUST register cleanup
// at describe scope instead, e.g.:
//
//   test.describe(..., () => {
//     let handle: AgentLoopHandle;
//     test.beforeAll(async () => { handle = await spawnAgentLoop({...}); });
//     test.afterAll(async () => { if (handle) await handle.close(); });
//     ...
//   });
