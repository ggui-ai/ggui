/**
 * Host side of the isolated runtime render check (#592).
 *
 * Spawns `render-check-worker.ts` in a sandboxed subprocess and maps
 * every sandbox outcome onto the check's own `RenderCheckResult`
 * vocabulary, so callers see one result shape whether the check ran
 * in-process (DOM-owning environments) or isolated (plain Node).
 *
 * Outcome mapping policy (mirrors the adapter's escaped-error
 * doctrine — component faults are `failed`, harness faults are
 * `unverified`, and nothing throws):
 *
 *   - worker exit 0 + parseable verdict → the verdict, verbatim.
 *   - timeout                    → `incomplete` (ggui#1299): the check
 *     did not finish, which is NOT a verdict on the component. The bound
 *     is wall-clock, and on a contended host an ordinary component
 *     crosses it; mapping it to `failed` reported crashes that never
 *     happened. It carries its elapsed ms, and the host load (below)
 *     says how busy the host was. React's own runaway guards ("Too many
 *     re-renders", "Maximum update depth exceeded") throw, so they still
 *     reach `render-no-throw` as `failed`; what now reads `incomplete`
 *     is a check that ran out of wall-clock time, whatever the cause.
 *   - overflow                   → `failed` (a pathological logging or
 *     error loop; output volume does not depend on host load).
 *   - spawn-error / non-zero exit / unparseable stdout
 *                                → `unverified` (the harness could not
 *     run the check; never blame the component for our plumbing).
 *
 * Every isolated check records the host's 1-minute load average at its
 * start and end, and the CPUs available, on `stats.hostLoad`.
 *
 * Spawn resolution copies the proven `src/tools/render-check.ts`
 * pattern: prefer the built `dist/.../render-check-worker.js`; in
 * dev/test (vitest imports `src/`), fall back to `node --import tsx`
 * on the `.ts` source. tsup inlines THIS module into several dist
 * entries (`dist/index.js`, `dist/harness/index.js`,
 * `dist/check/index.js`, `dist/advanced/index.js`, …), so the
 * candidate list walks from each of those locations to the one real
 * `dist/harness/check/runtime-render/render-check-worker.js`.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism, loadavg } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runSandboxed } from '@ggui-ai/sandbox';
import type { SandboxResult } from '@ggui-ai/sandbox';
import type { ProbeHostLoad } from '../../../evaluation/types-public.js';
import type { RenderCheckResult, RunRenderCheckInput } from './render-check.js';

/**
 * The subprocess bounds of one isolated check (ggui#1380). They are
 * INPUTS of the host, not constants: a serving deployment runs the probe
 * under its own memory and latency budget and sets them per check
 * instance (`createRuntimeRenderCheck`); the evaluation lane runs on the
 * defaults below, which are the values the host always used.
 */
export interface RenderCheckHostBounds {
  /**
   * Wall-clock bound for one isolated check. The rich probe renders,
   * clicks every declared action, and re-renders streams — slower than
   * the smoke worker's 12s budget; 30s bounds runaway components while
   * staying far under any generation-turn budget.
   */
  readonly timeoutMs: number;
  /**
   * V8 heap cap. The worker realm loads react-dom, happy-dom and
   * testing-library on top of the component itself; 512 MB leaves
   * headroom while still bounding pathological allocation.
   */
  readonly heapMb: number;
  /**
   * Grace between SIGTERM and SIGKILL once the bound is crossed. The
   * effective value is `min(gracePeriodMs, floor(timeoutMs / 2))` —
   * `runSandboxed` requires the grace to be strictly below the bound, so
   * a short bound never trips its RangeError.
   */
  readonly gracePeriodMs: number;
}

export const DEFAULT_RENDER_CHECK_HOST_BOUNDS: RenderCheckHostBounds = {
  timeoutMs: 30_000,
  heapMb: 512,
  gracePeriodMs: 2_000,
};

/**
 * Fill the caller's partial bounds from the defaults and clamp the grace
 * below the bound. Exported so the kill-path pin can run a fixture under
 * exactly the numbers the host would pass for the same input.
 */
export function resolveRenderCheckHostBounds(
  bounds: Partial<RenderCheckHostBounds> = {},
): RenderCheckHostBounds {
  const timeoutMs = bounds.timeoutMs ?? DEFAULT_RENDER_CHECK_HOST_BOUNDS.timeoutMs;
  const heapMb = bounds.heapMb ?? DEFAULT_RENDER_CHECK_HOST_BOUNDS.heapMb;
  // Refused at construction, like `maxConcurrent`: a 0 / NaN / fractional
  // bound would otherwise flow into the sandbox's flags as a nonsense number.
  // `timeoutMs` needs room for a grace of at least 1 ms below it.
  if (!Number.isInteger(timeoutMs) || timeoutMs < 2) {
    throw new RangeError(`render-check: timeoutMs must be an integer ≥ 2, got ${timeoutMs}`);
  }
  if (!Number.isInteger(heapMb) || heapMb < 1) {
    throw new RangeError(`render-check: heapMb must be a positive integer, got ${heapMb}`);
  }
  const requestedGrace = bounds.gracePeriodMs ?? DEFAULT_RENDER_CHECK_HOST_BOUNDS.gracePeriodMs;
  const gracePeriodMs = Math.max(1, Math.min(requestedGrace, Math.floor(timeoutMs / 2)));
  return { timeoutMs, heapMb, gracePeriodMs };
}

/** Options of {@link runRenderCheckViaWorker}. */
export interface RenderCheckHostOptions {
  /** Subprocess bounds; every field omitted falls to {@link DEFAULT_RENDER_CHECK_HOST_BOUNDS}. */
  readonly bounds?: Partial<RenderCheckHostBounds>;
}

/**
 * stdout cap. The verdict JSON carries issue lists with diagnostics
 * arrays — bigger than the smoke worker's one-liner, still tiny in
 * absolute terms. 2 MiB is far above any legitimate verdict.
 */
const CHECK_STDOUT_CAP = 2 * 1024 * 1024;

const WORKER_BASENAME = 'render-check-worker';

/**
 * How the host spawns the worker from THIS location: the built dist sibling
 * when one exists, else the source `.ts` through tsx. Exported so the entry
 * guard can be pinned with the same spawn the host makes (no build needed).
 */
export function resolveWorkerSpawn(): { command: string; args: string[] } {
  const jsCandidates = [
    // Sibling — when import.meta.url is already .../harness/check/runtime-render/.
    new URL(`./${WORKER_BASENAME}.js`, import.meta.url),
    // From dist/index.js.
    new URL(`./harness/check/runtime-render/${WORKER_BASENAME}.js`, import.meta.url),
    // From dist/harness/index.js.
    new URL(`./check/runtime-render/${WORKER_BASENAME}.js`, import.meta.url),
    // From dist/check/index.js, dist/advanced/index.js, dist/<flat>.js.
    new URL(`../harness/check/runtime-render/${WORKER_BASENAME}.js`, import.meta.url),
  ];
  for (const jsUrl of jsCandidates) {
    const jsPath = fileURLToPath(jsUrl);
    if (existsSync(jsPath)) {
      return { command: process.execPath, args: [jsPath] };
    }
  }
  // Dev / vitest: only the .ts source exists — run it through tsx.
  const tsCandidates = [
    new URL(`./${WORKER_BASENAME}.ts`, import.meta.url),
    new URL(`../harness/check/runtime-render/${WORKER_BASENAME}.ts`, import.meta.url),
  ];
  for (const tsUrl of tsCandidates) {
    const tsPath = fileURLToPath(tsUrl);
    if (existsSync(tsPath)) {
      const require_ = createRequire(import.meta.url);
      const tsxLoader = pathToFileURL(require_.resolve('tsx')).href;
      return { command: process.execPath, args: ['--import', tsxLoader, tsPath] };
    }
  }
  const tried = [...jsCandidates, ...tsCandidates]
    .map((u) => fileURLToPath(u))
    .join(', ');
  throw new Error(
    `render-check: isolated worker not found at any of: ${tried}. Did \`pnpm build\` run?`,
  );
}

function failed(reason: string, t0: number): RenderCheckResult {
  return {
    ok: false,
    issues: [{ check: 'render-no-throw', outcome: 'failed', reason }],
    stats: { actionsChecked: 0, streamsChecked: 0, renderMs: Date.now() - t0 },
  };
}

function unverified(reason: string, t0: number): RenderCheckResult {
  return {
    ok: false,
    issues: [{ check: 'render-no-throw', outcome: 'unverified', reason }],
    stats: { actionsChecked: 0, streamsChecked: 0, renderMs: Date.now() - t0 },
  };
}

/**
 * Map one sandbox result onto a `RenderCheckResult`. `boundMs` is the
 * wall-clock bound the run was given, reported on a timeout. Exported for
 * the unit pins — the spawn itself is exercised by the integration test.
 */
export function mapSandboxResultToCheckResult(
  result: SandboxResult,
  t0: number,
  boundMs: number = DEFAULT_RENDER_CHECK_HOST_BOUNDS.timeoutMs,
): RenderCheckResult {
  if (result.outcome === 'timeout') {
    return {
      ok: false,
      issues: [],
      incomplete: { kind: 'timeout', elapsedMs: result.durationMs, boundMs },
      stats: { actionsChecked: 0, streamsChecked: 0, renderMs: Date.now() - t0 },
    };
  }
  if (result.outcome === 'overflow-stdout' || result.outcome === 'overflow-stderr') {
    return failed(
      `render check worker produced excessive output (${result.outcome}) — the component is likely in a pathological logging or error loop.`,
      t0,
    );
  }
  if (result.outcome === 'spawn-error') {
    return unverified(
      `render check worker failed to start — ${result.errorMessage}`,
      t0,
    );
  }
  if (result.outcome === 'canceled') {
    return unverified('render check worker was canceled before completing.', t0);
  }
  if (result.outcome !== 'exit') {
    return unverified(
      `render check worker ended with unexpected sandbox outcome '${result.outcome}'.`,
      t0,
    );
  }
  if (result.exitCode !== 0) {
    const tail = result.stderr.trim() || result.stdout.trim();
    return unverified(
      `render check worker exited ${result.exitCode}${tail ? ` — ${tail.slice(0, 600)}` : ''}`,
      t0,
    );
  }
  const stdout = result.stdout.trim();
  if (stdout.length === 0) {
    return unverified('render check worker exited without producing a verdict.', t0);
  }
  try {
    return JSON.parse(stdout) as RenderCheckResult;
  } catch (err) {
    return unverified(
      `render check worker verdict was not valid JSON — ${
        err instanceof Error ? err.message : String(err)
      }`,
      t0,
    );
  }
}

/**
 * Run the render check in an isolated subprocess. See module doc.
 * `options.bounds` sets the subprocess bounds for this run; omitted
 * fields are the evaluation lane's defaults.
 */
export async function runRenderCheckViaWorker(
  input: RunRenderCheckInput,
  options: RenderCheckHostOptions = {},
): Promise<RenderCheckResult> {
  const t0 = Date.now();
  const bounds = resolveRenderCheckHostBounds(options.bounds);
  let spawn: { command: string; args: string[] };
  try {
    spawn = resolveWorkerSpawn();
  } catch (err) {
    return unverified(err instanceof Error ? err.message : String(err), t0);
  }

  const loadAtStart = loadavg()[0] ?? 0;
  const result = await runSandboxed({
    command: spawn.command,
    args: spawn.args,
    timeoutMs: bounds.timeoutMs,
    gracePeriodMs: bounds.gracePeriodMs,
    maxStdoutBytes: CHECK_STDOUT_CAP,
    nodeHeapMb: bounds.heapMb,
    stdin: JSON.stringify(input),
    // NODE_ENV steers React's production vs development build — keep
    // parity with the caller; everything else stays on the sandbox's
    // default allowlist.
    env: { NODE_ENV: process.env.NODE_ENV ?? 'production' },
  });

  const hostLoad: ProbeHostLoad = {
    start: loadAtStart,
    end: loadavg()[0] ?? 0,
    cores: availableParallelism(),
  };
  const mapped = mapSandboxResultToCheckResult(result, t0, bounds.timeoutMs);
  return { ...mapped, stats: { ...mapped.stats, hostLoad } };
}
