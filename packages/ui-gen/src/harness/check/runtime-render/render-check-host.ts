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
 *   - timeout                    → `failed` (runaway component: the
 *     in-process check has no comparable wall-clock bound, the
 *     subprocess finally gives us one).
 *   - spawn-error / overflow / non-zero exit / unparseable stdout
 *                                → `unverified` (the harness could not
 *     run the check; never blame the component for our plumbing).
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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runSandboxed } from '@ggui-ai/sandbox';
import type { SandboxResult } from '@ggui-ai/sandbox';
import type { RenderCheckResult, RunRenderCheckInput } from './render-check.js';

/**
 * Wall-clock bound for one isolated check. The rich probe renders,
 * clicks every declared action, and re-renders streams — slower than
 * the smoke worker's 12s budget; 30s bounds runaway components while
 * staying far under any generation-turn budget.
 */
const CHECK_TIMEOUT_MS = 30_000;

/**
 * stdout cap. The verdict JSON carries issue lists with diagnostics
 * arrays — bigger than the smoke worker's one-liner, still tiny in
 * absolute terms. 2 MiB is far above any legitimate verdict.
 */
const CHECK_STDOUT_CAP = 2 * 1024 * 1024;

/**
 * V8 heap cap. The worker realm loads react-dom, happy-dom and
 * testing-library on top of the component itself; 512 MB leaves
 * headroom while still bounding pathological allocation.
 */
const CHECK_NODE_HEAP_MB = 512;

const WORKER_BASENAME = 'render-check-worker';

function resolveWorkerSpawn(): { command: string; args: string[] } {
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
 * Map one sandbox result onto a `RenderCheckResult`. Exported for the
 * unit pins — the spawn itself is exercised by the integration test.
 */
export function mapSandboxResultToCheckResult(
  result: SandboxResult,
  t0: number,
): RenderCheckResult {
  if (result.outcome === 'timeout') {
    return failed(
      `render check timed out after ${CHECK_TIMEOUT_MS}ms in the isolated worker (likely infinite loop or runaway effect in the component).`,
      t0,
    );
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
 */
export async function runRenderCheckViaWorker(
  input: RunRenderCheckInput,
): Promise<RenderCheckResult> {
  const t0 = Date.now();
  let spawn: { command: string; args: string[] };
  try {
    spawn = resolveWorkerSpawn();
  } catch (err) {
    return unverified(err instanceof Error ? err.message : String(err), t0);
  }

  const result = await runSandboxed({
    command: spawn.command,
    args: spawn.args,
    timeoutMs: CHECK_TIMEOUT_MS,
    maxStdoutBytes: CHECK_STDOUT_CAP,
    nodeHeapMb: CHECK_NODE_HEAP_MB,
    stdin: JSON.stringify(input),
    // NODE_ENV steers React's production vs development build — keep
    // parity with the caller; everything else stays on the sandbox's
    // default allowlist.
    env: { NODE_ENV: process.env.NODE_ENV ?? 'production' },
  });

  return mapSandboxResultToCheckResult(result, t0);
}
