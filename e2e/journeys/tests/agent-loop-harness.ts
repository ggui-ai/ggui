/**
 * Agent-loop harness — boots the four-process ggui demo
 * (ggui + mcp-todo + sample-agent + ggui-basic-web) via workspace
 * `pnpm --filter` against `oss/samples/*`, then returns handles so a
 * spec can drive the browser against the Vite SPA frontend URL.
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
 *     four real sample processes booted as a vertical slice. No
 *     clean-room invariants, no env scrub.
 *
 * Why these specs aren't just the templates' chat-smoke: templates pin
 * `@ggui-ai/*@0.1.0-rc.3` and resolve from npm/Verdaccio. That's a
 * publish-gate, not a dev path — every iteration needs rebuild +
 * republish + reinstall (~5 min/cycle). These specs target source
 * directly, so a triad edit is ~30s away from a live e2e signal.
 *
 * Architecture (frontend/backend split, 2026-05-28):
 *   - `sample-agent` is a brand-agnostic MCP-Apps-spec backend (one
 *     per SDK). Pure HTTP API. No bundled chat shell.
 *   - `ggui-basic-web` is the reference frontend. ONE Vite SPA
 *     consumed by all 3 SDKs, swapped via
 *     `VITE_AGENT_ENDPOINT_URL`.
 *
 * Beacons consumed:
 *   - ggui CLI       `READY http://<host>:<port>\n`
 *   - mcp-todo       `[mcp-todo] ready: http://localhost:<port>/mcp`
 *   - sample-agent   `[sample-agent] chat UI ready: http://localhost:<port>`
 *   - web (vite)     `Local:   http://<host>:<port>/` (Vite's ready line)
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

/**
 * Per-worker port allocation.
 *
 * Each parallel Playwright worker gets a 100-port window — wide enough
 * to never collide with another worker's processes (we only need 5
 * ports per worker). The base values below are worker 0's allocation;
 * worker N adds `N * WORKER_PORT_OFFSET` to each.
 *
 * Worker 0 → ggui 6781, todo 6782, agent 6790, sandbox 7790, web 6890
 * Worker 1 → ggui 6881, todo 6882, agent 6890, sandbox 7890, web 6990
 * Worker 2 → ggui 6981, todo 6982, agent 6990, sandbox 7990, web 7090
 *
 * The agent port is the same regardless of SDK — only one SDK's
 * backend is booted per worker. The SDK identity is purely a package
 * selector now; ports are per-WORKER, not per-SDK.
 */
const WORKER_PORT_OFFSET = 100;

const PORT_BASE = {
  ggui: 6781,
  todo: 6782,
  agent: 6790,
  sandbox: 7790,
  web: 6890,
} as const;

export interface HarnessPortSet {
  readonly ggui: number;
  readonly todo: number;
  readonly agent: number;
  readonly sandbox: number;
  readonly web: number;
}

export function portsForWorker(workerIndex: number): HarnessPortSet {
  const off = workerIndex * WORKER_PORT_OFFSET;
  return {
    ggui: PORT_BASE.ggui + off,
    todo: PORT_BASE.todo + off,
    agent: PORT_BASE.agent + off,
    sandbox: PORT_BASE.sandbox + off,
    web: PORT_BASE.web + off,
  };
}

/**
 * Convenience worker-0 port set. Preserved as a named export for spec
 * authors who want to assert specific ports in custom flows. The real
 * harness call path uses {@link portsForWorker} keyed by
 * `testInfo.parallelIndex`.
 */
export const HARNESS_PORTS: HarnessPortSet = portsForWorker(0);

/**
 * One of the three SDK identities. Drives which workspace package the
 * agent process is filtered to and which env var holds the BYOK key.
 */
export type SdkId = 'claude-agent-sdk' | 'openai-agents-sdk' | 'google-adk';

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
  /**
   * URL Playwright navigates to. Points at the Vite SPA preview
   * server on the worker-local web port, with the agent backend URL
   * threaded as the `?agent=<url>` query param so the SPA wires up to
   * THIS worker's agent backend at runtime (no per-worker rebuild).
   */
  readonly agentUrl: string;
  /** ggui MCP base URL. */
  readonly gguiUrl: string;
  /** todo MCP base URL. */
  readonly todoUrl: string;
  /** Kill all 4 child processes. Idempotent. */
  close: () => Promise<void>;
  /** Captured stdout from each spawn, for failure dumps. */
  stdout: () => {
    ggui: string;
    todo: string;
    agent: string;
    web: string;
  };
  /** Captured stderr from each spawn, for failure dumps. */
  stderr: () => {
    ggui: string;
    todo: string;
    agent: string;
    web: string;
  };
}

export interface SpawnAgentLoopOptions {
  readonly sdk: SdkId;
  /**
   * Playwright `testInfo.parallelIndex` — 0-based per-worker integer.
   * Drives port allocation so concurrent workers don't collide on
   * binds. Default 0 = the single-worker layout (back-compat for
   * specs that haven't threaded the worker index yet).
   */
  readonly workerIndex?: number;
}

/**
 * Spawn ggui + todo + agent + web in workspace mode for one Playwright
 * worker. Resolves once all four boot beacons are observed. Hard-throws
 * on any beacon timeout — the journey then fails fast and the spec
 * dump prints captured stdio.
 *
 * Per-worker isolation: every spawned process binds a worker-local
 * port (see {@link portsForWorker}), so up to 3 workers can run
 * concurrently without collision. The Vite preview server uses the
 * SAME built `dist/` for every worker — `playwright.config.ts`'s
 * `globalSetup` builds it once before any worker starts, so build-race
 * is impossible; only the preview bind port and the runtime `?agent=`
 * URL query param vary per worker.
 */
export async function spawnAgentLoop(
  opts: SpawnAgentLoopOptions,
): Promise<AgentLoopHandle> {
  const cfg = SDK_CONFIG[opts.sdk];
  const workerIndex = opts.workerIndex ?? 0;
  const ports = portsForWorker(workerIndex);

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
  //
  // Sample-agents bind a sandbox-proxy server at the worker-local
  // `ports.sandbox` (passed explicitly via SANDBOX_PROXY_PORT, see the
  // agent spawn below). The proxy listener outlives a SIGTERM by the
  // same OS-bind-release window as the agent itself, so we MUST
  // include it in the pre-flight + drain loop.
  const portsToCheck: Array<{ port: number; label: string }> = [
    { port: ports.ggui, label: `ggui (w${workerIndex})` },
    { port: ports.todo, label: `todo (w${workerIndex})` },
    { port: ports.agent, label: `agent (w${workerIndex} ${opts.sdk})` },
    { port: ports.sandbox, label: `sandbox-proxy (w${workerIndex})` },
    { port: ports.web, label: `web (w${workerIndex})` },
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

  const procs: { ggui?: Proc; todo?: Proc; agent?: Proc; web?: Proc } = {};
  let closed = false;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await Promise.all(
      Object.values(procs).map((p) => p && killProc(p.child)),
    );
    // After SIGKILL the OS still takes a beat to release the bind; the
    // next describe's pre-flight check in this matrix runs immediately.
    // Wait up to 10s for our ports to actually clear so the next
    // describe doesn't trip on its own predecessor. Drain matches
    // pre-flight so a back-to-back run on the same worker index never
    // sees a stale bind.
    const myPorts = [
      ports.ggui,
      ports.todo,
      ports.agent,
      ports.sandbox,
      ports.web,
    ];
    for (let i = 0; i < 10; i++) {
      if (myPorts.every((p) => !portInUse(p))) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
  };

  try {
    // 1. ggui (workspace `@ggui-samples/ggui-default` → `ggui serve`)
    procs.ggui = spawnChild({
      label: `ggui-w${workerIndex}`,
      pkg: '@ggui-samples/ggui-default',
      env: { ...baseEnv, PORT: String(ports.ggui) },
    });
    await waitForBeacon(procs.ggui, /READY http:\/\//, 60_000, 'ggui');

    // 2. mcp-todo
    procs.todo = spawnChild({
      label: `todo-w${workerIndex}`,
      pkg: '@ggui-samples/mcp-todo',
      env: { ...baseEnv, PORT: String(ports.todo) },
    });
    await waitForBeacon(procs.todo, /\[mcp-todo\] ready:/, 30_000, 'todo');

    // 3. agent — pure API backend (no bundled frontend since the
    // 2026-05-28 frontend-split). Boots quickly once tsx finishes
    // typechecking.
    procs.agent = spawnChild({
      label: `${opts.sdk}-w${workerIndex}`,
      pkg: cfg.agentPackage,
      env: {
        ...baseEnv,
        PORT: String(ports.agent),
        SANDBOX_PROXY_PORT: String(ports.sandbox),
        GGUI_MCP_URL: `http://localhost:${ports.ggui}/mcp`,
        GGUI_TODO_MCP_URL: `http://localhost:${ports.todo}/mcp`,
      },
    });
    await waitForBeacon(
      procs.agent,
      /\[sample-agent\] chat UI ready:/,
      60_000,
      'agent',
    );

    // 4. Vite SPA preview — serves the SHARED `dist/` on the
    // worker-local web port. Playwright's `globalSetup` (see
    // `playwright.config.ts`) builds `dist/` ONCE before any worker
    // starts, so every worker's `vite preview` is a pure static-file
    // serve — zero race on the build output.
    //
    // `VITE_SERVER_PORT` overrides the default 6890 baked into
    // `oss/samples/apps/ggui-basic-web/vite.config.ts` so each
    // worker's preview binds its own allocated web port. The agent
    // backend URL is NOT baked in — App.tsx reads it from the
    // `?agent=<url>` URL query param at runtime (see `navigateUrl`
    // below), so the single shared build drives every worker's
    // distinct backend.
    //
    // We explicitly run the `preview` script (not `start`, which
    // would also rebuild) to make the build/preview split
    // unambiguous and keep per-worker spawn fast.
    procs.web = spawnChild({
      label: `web-w${workerIndex}`,
      pkg: '@ggui-samples/app-ggui-basic-web',
      script: 'preview',
      env: {
        ...baseEnv,
        VITE_SERVER_PORT: String(ports.web),
        // Disable ANSI color codes — Vite's colorized output interleaves
        // escape sequences inside the text we beacon on, breaking the
        // `Local:\s+http` match (`Local[22m:` ≠ `Local:`).
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      },
    });
    await waitForBeacon(
      procs.web,
      /ready in |Local:\s+http/i,
      120_000,
      'web',
    );
  } catch (err) {
    await close();
    throw err;
  }

  // Frontend bundle is agent-agnostic — runtime config selects the
  // backend via `?agent=` URL query param. The navigate URL carries
  // the worker-local agent URL so the SPA wires up to THIS worker's
  // backend rather than any global default.
  const agentEndpoint = `http://localhost:${ports.agent}`;
  const navigateUrl =
    `http://localhost:${ports.web}/?agent=` +
    encodeURIComponent(agentEndpoint);

  return {
    agentUrl: navigateUrl,
    gguiUrl: `http://localhost:${ports.ggui}`,
    todoUrl: `http://localhost:${ports.todo}/mcp`,
    close,
    stdout: () => ({
      ggui: procs.ggui?.stdout() ?? '',
      todo: procs.todo?.stdout() ?? '',
      agent: procs.agent?.stdout() ?? '',
      web: procs.web?.stdout() ?? '',
    }),
    stderr: () => ({
      ggui: procs.ggui?.stderr() ?? '',
      todo: procs.todo?.stderr() ?? '',
      agent: procs.agent?.stderr() ?? '',
      web: procs.web?.stderr() ?? '',
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
  /**
   * pnpm script name. Defaults to `start` which matches every sample
   * package. The web spawn overrides to `preview` so each worker
   * serves the SHARED globalSetup-built `dist/` instead of rebuilding
   * per worker.
   */
  script?: string;
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
  const script = opts.script ?? 'start';
  const child: SpawnedChild = spawn(
    'pnpm',
    ['--filter', opts.pkg, '--silent', script],
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
