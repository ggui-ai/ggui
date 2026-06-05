/**
 * Lightweight render smoke test for compiled components.
 *
 * Uses ReactDOMServer.renderToString() to verify the component
 * can render without throwing. Catches runtime errors that tsc misses
 * (undefined.toLowerCase(), missing prop access, etc.)
 *
 * Returns null on success, or an error message string on failure.
 *
 * **Execution model**: the actual `renderToString` runs in a
 * subprocess via `@ggui-ai/sandbox` — LLM-generated TSX never
 * executes in the parent Node process. The subprocess gets:
 *
 *   - wall-clock timeout (12s — generous for weird LLM output)
 *   - stdout cap (512 KiB — worker's JSON verdict is tiny; cap is
 *     defensive)
 *   - V8 heap cap (256 MB — bounds runaway allocations)
 *   - owned tmpdir as cwd (cleaned up at finish)
 *   - env allowlist (PATH/HOME/TMPDIR bootstrap only — no secrets
 *     from the parent process.env reach the child)
 *
 * See `@ggui-ai/sandbox/README.md` for the honest boundary: this
 * setup does NOT block network egress, does NOT prevent FS reads
 * outside cwd, and does NOT cap CPU. Those need OS primitives that
 * aren't portable from Node user-space.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { runSandboxed } from '@ggui-ai/sandbox';
import type { PropsSpec, JsonObject, JsonValue } from '@ggui-ai/protocol';

/**
 * Generate sample props from a PropsSpec contract.
 * Uses `example` values from each PropEntry when available,
 * otherwise synthesizes plausible defaults from the JSON Schema.
 */
export function generateSampleProps(spec: PropsSpec): JsonObject {
  const props: JsonObject = {};

  for (const [name, entry] of Object.entries(spec.properties)) {
    // Prefer explicit example value
    if (entry.example !== undefined) {
      props[name] = entry.example;
      continue;
    }

    // Prefer explicit default value
    if (entry.default !== undefined) {
      props[name] = entry.default;
      continue;
    }

    // Synthesize from JSON Schema
    props[name] = synthesizeFromSchema(entry.schema);
  }

  return props;
}

function synthesizeFromSchema(schema: { type?: string; items?: unknown; properties?: JsonObject; required?: string[] }): JsonValue | undefined {
  switch (schema.type) {
    case 'string': return 'sample';
    case 'number': return 0;
    case 'boolean': return false;
    case 'array': {
      const itemSchema = schema.items as { type?: string } | undefined;
      if (itemSchema) return [synthesizeFromSchema(itemSchema) ?? null];
      return [];
    }
    case 'object': {
      const obj: JsonObject = {};
      if (schema.properties) {
        for (const [k, v] of Object.entries(schema.properties)) {
          obj[k] = synthesizeFromSchema(v as { type?: string });
        }
      }
      return obj;
    }
    default: return undefined;
  }
}

/**
 * Timeout for a single render smoke test. Generous — some LLM-
 * produced components hit pathological code paths (deep prop-drill
 * recursion, accidental infinite loops on null-guarded maps). 12s is
 * well above the ~100ms real renderToString cost + ~50ms subprocess
 * spawn, while still bounding runaway execution.
 */
const RENDER_TIMEOUT_MS = 12_000;

/**
 * stdout byte cap. The worker writes a single JSON verdict
 * (`{ok: true}` or `{ok: false, error: "..."}`), which is tiny — a
 * few KiB is plenty for the longest useful error message. Cap
 * defensively at 512 KiB so a pathological worker can't flood.
 */
const RENDER_STDOUT_CAP = 512 * 1024;

/**
 * V8 heap cap for the worker. 256 MB bounds runaway allocations
 * (e.g. a component that builds a massive array in render) while
 * leaving headroom for `react-dom/server` + esbuild's own heap.
 */
const RENDER_NODE_HEAP_MB = 256;

/**
 * Resolve the worker entry + the spawn command to launch it.
 *
 *   - **Built (`dist/`)**: the compiled `render-check-worker.js`
 *     lives at `dist/tools/render-check-worker.js`. Some consumers
 *     import via subpath entries (e.g. `@ggui-ai/ui-gen/adapters`)
 *     that inline this function into a different dist directory
 *     (e.g. `dist/adapters/index.js`); the worker lookup must still
 *     find the worker file in `dist/tools/`. We search siblings AND
 *     `../tools/` to cover both.
 *   - **Dev / test (vitest imports `src/`)**: only the `.ts` source
 *     exists at `src/tools/render-check-worker.ts`; spawn
 *     `node --import tsx <tsPath>`. tsx is already a dev-dep of core
 *     for the `dev` / `bench` scripts, so it's a safe assumption in
 *     the test environment.
 *
 * Fails loudly at first call when none of the candidates exist —
 * that means a broken build, not a missing test fixture.
 */
function resolveWorkerSpawn(): { command: string; args: string[] } {
  // Sibling-first, then `../tools/`. When this function is inlined
  // into `dist/adapters/index.js`, sibling resolves to a nonexistent
  // `dist/adapters/render-check-worker.js`; the `../tools/` candidate
  // then lands on the real `dist/tools/render-check-worker.js`.
  const jsCandidates = [
    new URL('./render-check-worker.js', import.meta.url),
    new URL('../tools/render-check-worker.js', import.meta.url),
  ];
  const tsCandidates = [
    new URL('./render-check-worker.ts', import.meta.url),
    new URL('../tools/render-check-worker.ts', import.meta.url),
  ];
  for (const jsUrl of jsCandidates) {
    const jsPath = fileURLToPath(jsUrl);
    if (existsSync(jsPath)) {
      return { command: process.execPath, args: [jsPath] };
    }
  }
  for (const tsUrl of tsCandidates) {
    const tsPath = fileURLToPath(tsUrl);
    if (existsSync(tsPath)) {
      // Pre-resolve tsx to an absolute file: URL so Node can find it
      // regardless of the subprocess's cwd (the sandbox mints a fresh
      // tmpdir for cwd by default; relative tsx lookup would fail).
      const require_ = createRequire(import.meta.url);
      const tsxLoader = pathToFileURL(require_.resolve('tsx')).href;
      return {
        command: process.execPath,
        args: ['--import', tsxLoader, tsPath],
      };
    }
  }
  const tried = [...jsCandidates, ...tsCandidates]
    .map((u) => fileURLToPath(u))
    .join(', ');
  throw new Error(
    `render-check: worker not found at any of: ${tried}. Did \`pnpm build\` run?`,
  );
}

export async function tryRender(
  compiledCode: string,
  sourceCode: string,
  sampleProps?: JsonObject,
): Promise<string | null> {
  // `compiledCode` is intentionally ignored — the worker re-compiles
  // as CJS internally. Keeping the parameter preserves the callsite
  // signature so upstream callers (tools.ts, lambda-handler.ts) don't
  // churn.
  void compiledCode;

  const payload = JSON.stringify({ sourceCode, sampleProps });
  const spawn = resolveWorkerSpawn();

  const result = await runSandboxed({
    command: spawn.command,
    args: spawn.args,
    timeoutMs: RENDER_TIMEOUT_MS,
    maxStdoutBytes: RENDER_STDOUT_CAP,
    nodeHeapMb: RENDER_NODE_HEAP_MB,
    stdin: payload,
    // Forward only what the worker needs. NODE_ENV lets React pick
    // production vs development builds; everything else stays at the
    // sandbox's default allowlist (PATH/HOME/TMPDIR bootstrap).
    env: {
      NODE_ENV: process.env.NODE_ENV ?? 'production',
    },
  });

  if (result.outcome === 'timeout') {
    return `GguiSession timeout: component did not finish within ${RENDER_TIMEOUT_MS}ms (likely infinite loop or runaway recursion).`;
  }
  if (result.outcome === 'overflow-stdout' || result.outcome === 'overflow-stderr') {
    return `GguiSession error: worker produced excessive output (${result.outcome}). The component is likely in a pathological state.`;
  }
  if (result.outcome === 'canceled') {
    return 'GguiSession error: smoke test was canceled before completing.';
  }
  if (result.outcome === 'spawn-error') {
    return `GguiSession error: failed to start worker — ${result.errorMessage}`;
  }
  if (result.outcome !== 'exit') {
    return `GguiSession error: unexpected sandbox outcome '${result.outcome}'.`;
  }

  // Worker exited cleanly. Parse its verdict.
  if (result.exitCode !== 0) {
    const tail = result.stderr.trim() || result.stdout.trim();
    return `GguiSession error: worker exited ${result.exitCode}${tail ? ` — ${tail}` : ''}`;
  }

  const stdout = result.stdout.trim();
  if (stdout.length === 0) {
    return 'GguiSession error: worker exited without producing a verdict.';
  }

  type Verdict = { ok: true } | { ok: false; error: string };
  let verdict: Verdict;
  try {
    verdict = JSON.parse(stdout) as Verdict;
  } catch (err) {
    return `GguiSession error: malformed worker verdict — ${
      err instanceof Error ? err.message : String(err)
    }`;
  }

  return verdict.ok ? null : verdict.error;
}
