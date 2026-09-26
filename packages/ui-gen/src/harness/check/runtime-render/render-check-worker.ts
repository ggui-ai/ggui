/**
 * Isolated worker for the in-loop runtime render check (#592).
 *
 * Runs `runRenderCheckInProcess` in a SUBPROCESS so the check's
 * happy-dom global install (`window`, `document`, `navigator`, … onto
 * `globalThis`) lands on THIS process's globals, never the caller's.
 *
 * Why this exists — the process-global install is a TOCTOU hazard in
 * any concurrent host: provider SDKs (OpenAI and Anthropic alike)
 * sniff `typeof window !== 'undefined' && window.document && navigator`
 * at client construction and refuse with "browser-like environment"
 * when another cell's check-window happens to be open (#592, the
 * 2026-08-19 bench run's gpt-5.6-sol hard failures). Two overlapping
 * in-process checks also corrupt each other's install/teardown. A
 * subprocess gives one private global scope per check plus real kill
 * semantics via `@ggui-ai/sandbox` on the host side.
 *
 * Wire protocol (single JSON document each way):
 *
 *   stdin:  RunRenderCheckInput  ({ sourceCode, mockupProps, contract? })
 *   stdout: RenderCheckResult    ({ ok, issues, stats })
 *   exit:   0 on any verdict (issues are data, not status); non-zero
 *           only when the worker itself is broken (malformed input,
 *           harness crash) — the host maps that to an `unverified`
 *           issue, mirroring the adapter's escaped-error semantics.
 *
 * Same file-path distribution model as `src/tools/render-check-worker.ts`
 * (the render SMOKE worker): reached by spawn path, never by import
 * specifier; registered as a tsup entry so `dist/harness/check/
 * runtime-render/render-check-worker.js` ships.
 *
 * Shutdown (ggui#1380): the compile runs on esbuild's service, a child
 * process esbuild keeps alive for the life of this worker. After the
 * verdict is written the worker calls `esbuild.stop()` so that child is
 * gone before the worker is; a worker stopped at its wall-clock bound is
 * killed by the host, and the service's stdin closing with it is what
 * ends the service in that case. `workerMain` is exported for the
 * process-shape pins; `main()` runs only when this file is the process
 * entry, so importing it never reads stdin.
 */
import { realpathSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { runRenderCheckInProcess } from './render-check.js';
import type { RunRenderCheckInput } from './render-check.js';

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/**
 * Parse one input document, run the check, write the verdict. Whatever
 * happens after parsing, esbuild's service is stopped before this
 * returns (or rejects). If the service was never started, `stop()` is a
 * no-op.
 */
export async function workerMain(raw: string): Promise<void> {
  try {
    let input: RunRenderCheckInput;
    try {
      input = JSON.parse(raw) as RunRenderCheckInput;
    } catch (err) {
      process.stderr.write(
        `render-check worker: malformed input JSON — ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      process.exitCode = 1;
      return;
    }
    if (typeof input.sourceCode !== 'string' || input.sourceCode.length === 0) {
      process.stderr.write(
        'render-check worker: input.sourceCode must be a non-empty string\n',
      );
      process.exitCode = 1;
      return;
    }

    // The in-process check never throws for component failures (they are
    // reported as issues); an escape here is a harness defect — let it
    // crash the worker so the host maps it to `unverified` with the
    // stderr tail as the reason.
    const result = await runRenderCheckInProcess(input);
    emit(result);
    // The check's async-infra grace period (React scheduler drain) holds
    // handlers for ~100ms; exit through the event loop naturally so that
    // drain completes inside the worker instead of leaking crashes.
  } finally {
    // Post-verdict work must never turn a written verdict into a failure:
    // a rejecting `stop()` would otherwise become an unhandled rejection,
    // exit code 1, and the host discarding the verdict on stdout.
    try {
      await esbuild.stop();
    } catch (err) {
      process.stderr.write(
        `render-check worker: esbuild.stop() failed — ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

async function main(): Promise<void> {
  await workerMain(await readAllStdin());
}

/** True when this file is the process entry (`node <this file>`), not an import. */
function isProcessEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  // Resolve BOTH sides through the filesystem: `import.meta.url` is this
  // file's realpath while argv[1] is whatever the spawner passed — a
  // symlinked spawn path must still read as the entry, or the worker would
  // exit with no verdict and the host would read a silent `unverified`.
  let entryReal: string;
  try {
    entryReal = realpathSync(resolvePath(entry));
  } catch {
    return false;
  }
  return entryReal === realpathSync(fileURLToPath(import.meta.url));
}

if (isProcessEntry()) {
  void main();
}
