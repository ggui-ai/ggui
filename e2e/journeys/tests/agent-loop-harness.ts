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
  //
  // Wait up to 15s for ports to clear — a prior describe's `afterAll`
  // kills its children, but the OS takes a moment to release the bind
  // (especially with WebSocket upgrades holding connections half-open).
  // Without this poll, back-to-back describes in the matrix would race
  // their teardown vs the next describe's pre-flight.
  // Sample-agents auto-bind a sandbox-proxy server at `agent_port + 1000`
  // (see `oss/samples/agents/<sdk>/src/index.ts` SANDBOX_PROXY_PORT
  // default — 6790→7790, 6791→7791, 6792→7792). The proxy listener
  // outlives a SIGTERM by the same OS-bind-release window as the agent
  // itself, so we MUST include it in the pre-flight + drain loop or
  // back-to-back describes in the matrix race their teardown.
  const portsToCheck: Array<{ port: number; label: string }> = [
    { port: ports.ggui, label: 'ggui' },
    { port: ports.todo, label: 'todo' },
    { port: agentPort, label: `agent (${opts.sdk})` },
    {
      port: agentPort + 1000,
      label: `sandbox-proxy (${opts.sdk})`,
    },
  ];
  let squatted = portsToCheck.filter(({ port }) => portInUse(port));
  for (let i = 0; i < 15 && squatted.length > 0; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    squatted = portsToCheck.filter(({ port }) => portInUse(port));
  }
  if (squatted.length > 0) {
    throw new Error(
      `agent-loop harness: port(s) still bound after 15s wait: ` +
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
    // After SIGKILL the OS still takes a beat to release the bind; the
    // next describe's pre-flight check in this matrix runs immediately.
    // Wait up to 10s for our 3 ports to actually clear so the next
    // describe doesn't trip on its own predecessor.
    // Drain matches pre-flight — include sandbox-proxy (agent + 1000)
    // so the next describe's pre-flight doesn't see a stale bind.
    const myPorts = [ports.ggui, ports.todo, agentPort, agentPort + 1000];
    for (let i = 0; i < 10; i++) {
      if (myPorts.every((p) => !portInUse(p))) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
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
  // `detached: true` puts the child in its own process group so
  // `process.kill(-pid, signal)` in `killProc` signals every descendant
  // — including the pnpm → sh → node CLI chain. Without this, SIGKILL
  // only reaches the outer pnpm wrapper; the actual ggui-serve / tsx
  // process is reparented to PID 1 and keeps holding port 6781.
  const child: SpawnedChild = spawn(
    'pnpm',
    ['--filter', opts.pkg, '--silent', 'start'],
    {
      cwd: WORKSPACE_ROOT,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
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
  // Signal the whole process group (negative pid). The child was
  // spawned with `detached: true` so it's the process-group leader;
  // `-child.pid` reaches every descendant — pnpm → sh → node CLI.
  // Without this, only the top-level pnpm wrapper dies; the actual
  // ggui-serve / tsx process is reparented to PID 1 and continues
  // holding the bound port.
  const pgid = child.pid ? -child.pid : null;
  const sig = (s: NodeJS.Signals): void => {
    if (pgid !== null) {
      try {
        process.kill(pgid, s);
      } catch {
        /* group may already be gone */
      }
    }
    try {
      child.kill(s);
    } catch {
      /* best-effort */
    }
  };
  sig('SIGTERM');
  await new Promise<void>((res) => {
    const onExit = (): void => res();
    child.once('exit', onExit);
    setTimeout(() => {
      sig('SIGKILL');
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

import type { FrameLocator, Locator } from '@playwright/test';

/**
 * Find a clickable toggle widget for a todo item authored by an LLM.
 *
 * LLM-authored UIs vary: some agents produce a labeled
 * `<input type="checkbox" aria-label="buy milk">` (claude, openai), some
 * produce an UNLABELED `<checkbox>` next to a `<p>buy milk</p>` paragraph
 * (gemini). The first case matches `getByRole('checkbox', { name })`;
 * the second does NOT — the checkbox has empty accessible name.
 *
 * This helper handles both. It returns the first matching strategy:
 *   1. Named role-based (checkbox/switch/menuitemcheckbox/button by name)
 *   2. Row-proximity: ancestor of the text node that contains a
 *      checkbox/switch — picks up the unlabeled-checkbox-next-to-text
 *      pattern Gemini emits.
 *
 * Callers do `await target.click()` once and let the chain pick the
 * first viable widget.
 */
export function findTodoToggleable(
  frame: FrameLocator,
  name: RegExp,
): Locator {
  const namedRoles = frame
    .getByRole('checkbox', { name })
    .or(frame.getByRole('switch', { name }))
    .or(frame.getByRole('menuitemcheckbox', { name }))
    .or(frame.getByRole('button', { name }));

  // Row-proximity fallback for unlabeled checkboxes (Gemini pattern).
  // xpath ancestor walk finds the smallest ancestor of the text node
  // that contains an interactive checkbox/switch element.
  const rowWithCheckbox = frame
    .getByText(name)
    .first()
    .locator(
      'xpath=ancestor-or-self::*[.//input[@type="checkbox"] or .//*[@role="checkbox"] or .//*[@role="switch"]][1]',
    );
  const rowCheckbox = rowWithCheckbox
    .getByRole('checkbox')
    .or(rowWithCheckbox.getByRole('switch'))
    .or(rowWithCheckbox.locator('input[type="checkbox"]'));

  return namedRoles.or(rowCheckbox).first();
}

/**
 * Assert a todo item appears in a "completed/checked" state. Same
 * labeled-vs-unlabeled split as {@link findTodoToggleable}.
 */
export function findTodoCheckedIndicator(
  frame: FrameLocator,
  name: RegExp,
): Locator {
  const namedChecked = frame
    .getByRole('checkbox', { name, checked: true })
    .or(frame.getByRole('switch', { name, checked: true }));

  // Row-proximity: the unlabeled checkbox in the buy-milk row is checked.
  const rowWithCheckbox = frame
    .getByText(name)
    .first()
    .locator(
      'xpath=ancestor-or-self::*[.//input[@type="checkbox"] or .//*[@role="checkbox"] or .//*[@role="switch"]][1]',
    );
  const rowChecked = rowWithCheckbox
    .getByRole('checkbox', { checked: true })
    .or(rowWithCheckbox.getByRole('switch', { checked: true }))
    .or(rowWithCheckbox.locator('input[type="checkbox"]:checked'));

  // Some agents instead re-render with "done"/"completed"/"✓" text near
  // the item — accept that as evidence too.
  const completionTextNear = frame.getByText(
    new RegExp(
      `${name.source}[\\s\\S]{0,40}(done|completed|✓|☑|complete)|` +
        `\\b(done|completed|✓|☑|complete)\\b[\\s\\S]{0,40}${name.source}`,
      'i',
    ),
  );

  return namedChecked.or(rowChecked).or(completionTextNear).first();
}
