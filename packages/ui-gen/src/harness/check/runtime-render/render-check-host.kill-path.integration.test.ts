// @vitest-environment node
//
// ggui#1380 C2 — the kill path, with REAL spawns (like
// render-check-isolation.test.ts). Three pins:
//
//   1. a component that hangs synchronously is stopped at the CONFIGURED
//      bound: `incomplete` is `{ kind: 'timeout', boundMs: <the input> }`,
//      no issues, `elapsedMs ≥ bound`, and the wall-clock stays under
//      bound + grace + slack — the host's bounds are inputs, not constants;
//   2. an esbuild-shaped grandchild (a child that reads stdin and exits on
//      EOF — what esbuild's service is) does not outlive the run: a fixture
//      worker spawns one, writes both pids to a file, then hangs; after the
//      run under the host's bounds for the same input neither pid is alive.
//      No process-group kill in this cut — the stdin-EOF shape is the pin;
//   3. the entry guard: the worker runs `main()` when it is the PROCESS
//      ENTRY — spawned the way the host spawns it when no dist exists (the
//      source `.ts` through the tsx `--import` route, `resolveWorkerSpawn()`),
//      it answers with a verdict; spawned through a SYMLINKED path it still
//      answers (the guard resolves both sides through the filesystem). A
//      wrong guard exits without a verdict, which the host maps to
//      `unverified` — so this pin fails loudly instead of silently turning
//      every probe into "could not run". The dist-only fact — that the
//      worker ships as its own entry so `import.meta.url` names it — is a
//      CONFIG pin (render-check-worker.entry.test.ts), not a build here.
//
// Not a unit test (real children and grandchildren, > 100 ms, real deps):
// hence the `.integration.test.ts` suffix; ui-gen's single vitest config
// runs it in the same job.
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runSandboxed } from '@ggui-ai/sandbox';
import {
  mapSandboxResultToCheckResult,
  resolveRenderCheckHostBounds,
  resolveWorkerSpawn,
  runRenderCheckViaWorker,
} from './render-check-host.js';

/** Bounds ≥ 2.5 s so a slow host never makes the pin flaky. */
const BOUND_MS = 3_000;
/** Spawn + tsx boot + kill delivery on a loaded host. */
const SLACK_MS = 4_000;

const HANGING_COMPONENT = `
export default function Component() {
  for (;;) { /* hangs synchronously — never yields to the event loop */ }
  return null;
}
`;

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ESRCH') return false;
    // EPERM = alive but not ours; anything else is a real error.
    throw err;
  }
}

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the kill path at the configured bound (ggui#1380 C2)', () => {
  it('a synchronously hanging component is stopped at bounds.timeoutMs — incomplete, no issues', async () => {
    const t0 = Date.now();
    const result = await runRenderCheckViaWorker(
      { sourceCode: HANGING_COMPONENT, mockupProps: {} },
      { bounds: { timeoutMs: BOUND_MS } },
    );
    const wallMs = Date.now() - t0;
    const grace = resolveRenderCheckHostBounds({ timeoutMs: BOUND_MS }).gracePeriodMs;

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([]);
    expect(result.incomplete?.kind).toBe('timeout');
    expect(result.incomplete?.boundMs).toBe(BOUND_MS);
    expect(result.incomplete?.elapsedMs).toBeGreaterThanOrEqual(BOUND_MS);
    expect(wallMs).toBeLessThanOrEqual(BOUND_MS + grace + SLACK_MS);
  }, 30_000);

  it('an esbuild-shaped grandchild (stdin-EOF exit) does not outlive the run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ggui-kill-path-'));
    scratch.push(dir);
    const pidFile = join(dir, 'pids.txt');
    const fixture = join(dir, 'fixture.mjs');
    // The grandchild reads stdin and exits on EOF — the service shape.
    // The fixture keeps the pipe's write end open and hangs synchronously,
    // so the pipe closes only when the fixture itself dies.
    writeFileSync(
      fixture,
      [
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        'const child = spawn(process.execPath, [',
        "  '-e',",
        "  \"process.stdin.resume(); process.stdin.on('end', () => process.exit(0));\",",
        "], { stdio: ['pipe', 'ignore', 'ignore'] });",
        'writeFileSync(process.argv[2], `${process.pid}\\n${child.pid}\\n`);',
        'for (;;) {}',
        '',
      ].join('\n'),
    );

    const bounds = resolveRenderCheckHostBounds({ timeoutMs: BOUND_MS });
    const result = await runSandboxed({
      command: process.execPath,
      args: [fixture, pidFile],
      timeoutMs: bounds.timeoutMs,
      gracePeriodMs: bounds.gracePeriodMs,
      nodeHeapMb: bounds.heapMb,
    });
    expect(result.outcome).toBe('timeout');

    const pids = readFileSync(pidFile, 'utf8').trim().split('\n').map(Number);
    expect(pids).toHaveLength(2);
    const [workerPid, grandchildPid] = pids;
    if (workerPid === undefined || grandchildPid === undefined) throw new Error('pid file did not carry two pids');
    expect(Number.isInteger(workerPid) && workerPid > 0).toBe(true);
    expect(Number.isInteger(grandchildPid) && grandchildPid > 0).toBe(true);

    await vi.waitFor(
      () => {
        expect(pidIsAlive(workerPid)).toBe(false);
        expect(pidIsAlive(grandchildPid)).toBe(false);
      },
      { timeout: 5_000, interval: 50 },
    );
  }, 30_000);

  async function spawnWorkerAsEntry(args: readonly string[]): Promise<{ exitCode: number | null; outcome: string; ok: boolean; unverified: number }> {
    const t0 = Date.now();
    const sandbox = await runSandboxed({
      command: process.execPath,
      args: [...args],
      timeoutMs: 30_000,
      nodeHeapMb: 512,
      stdin: JSON.stringify({
        sourceCode: 'export default function Component() { return <div>warm</div>; }',
        mockupProps: {},
        contract: {},
      }),
      env: { NODE_ENV: 'production' },
    });
    const verdict = mapSandboxResultToCheckResult(sandbox, t0);
    return {
      exitCode: sandbox.exitCode,
      outcome: sandbox.outcome,
      ok: verdict.ok,
      unverified: verdict.issues.filter((i) => i.outcome === 'unverified').length,
    };
  }

  it('the worker answers with a verdict when spawned as the process entry — the way the host spawns it here (source through tsx)', async () => {
    const spawn = resolveWorkerSpawn();
    expect(spawn.command).toBe(process.execPath);
    const result = await spawnWorkerAsEntry(spawn.args);
    expect(result.outcome).toBe('exit');
    expect(result.exitCode).toBe(0);
    expect(result.unverified).toBe(0);
    expect(result.ok).toBe(true);
  }, 30_000);

  it('the worker answers through a SYMLINKED spawn path too — the entry guard resolves both sides through the filesystem', async () => {
    const spawn = resolveWorkerSpawn();
    const workerPath = spawn.args[spawn.args.length - 1];
    if (workerPath === undefined) throw new Error('the host spawn carries no worker path');
    const dir = mkdtempSync(join(tmpdir(), 'ggui-worker-link-'));
    scratch.push(dir);
    const link = join(dir, `worker-link${workerPath.endsWith('.ts') ? '.ts' : '.js'}`);
    symlinkSync(realpathSync(workerPath), link);
    const result = await spawnWorkerAsEntry([...spawn.args.slice(0, -1), link]);
    expect(result.outcome).toBe('exit');
    expect(result.exitCode).toBe(0);
    expect(result.unverified).toBe(0);
    expect(result.ok).toBe(true);
  }, 30_000);
});
