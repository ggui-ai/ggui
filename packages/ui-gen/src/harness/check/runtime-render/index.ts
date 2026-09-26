// packages/ui-gen/src/harness/check/runtime-render/index.ts
//
// Public surface for runtime render evaluation.
//
// runRenderCheck() takes a compiled component + mockup props + contract,
// renders it in happy-dom with a probe-backed WireConfig, and verifies:
//   - it renders without throw                              (block)
//   - declared actions fire when the bound UI is clicked    (block)
//   - declared props appear in the DOM                      (warn)
//   - declared stream events update the DOM when emitted    (warn)

import { installProductionActShim } from "./production-act-shim.js";
import type { RenderCheckHostBounds } from "./render-check-host.js";

export {
  RENDER_CHECK_KINDS,
  runRenderCheck,
  type RenderCheckKind,
  type RenderCheckResult,
  type RenderCheckIssue,
} from "./render-check.js";
export { createProbe, createProbeWireConfig, type Probe } from "./probe.js";
export { prepareMockupProps, type MockupPropsResult } from "./prepare-mockup.js";
export {
  DEFAULT_RUNTIME_RENDER_CHECK,
  classifyRenderCrashFix,
  createRuntimeRenderCheck,
  isRecoverableRenderCrash,
  parseRuntimeSubcategory,
  type RuntimeRenderProbeConfig,
} from "./adapter.js";
export type { RenderCheckHostBounds, RenderCheckHostOptions } from "./render-check-host.js";

/**
 * Pre-warm the runtime-render probe's runtime dependencies so the first
 * actual probe call hits a warm Node module cache.
 *
 * The probe lazily loads `happy-dom`, `@testing-library/react`,
 * `@testing-library/user-event`, and `@ggui-ai/wire` on first invocation
 * — total cold cost ~700-1500ms. Bench runners can call this once at
 * startup to amortize that cost; subsequent per-cell probe calls fall
 * to ~50-200ms.
 *
 * Resolves these specifiers from THIS module's filesystem location, so
 * Node walks up from `packages/ui-gen/dist/harness/check/runtime-render/`
 * to find them in `packages/ui-gen/node_modules/...`. Bench callers
 * cannot pre-import them directly — they aren't in the bench package's
 * own `node_modules`.
 *
 * Fire-and-forget. If a dep is missing the per-cell probe will surface
 * the error on first use; pre-warm just no-ops on import failure.
 *
 * Returns the wall-clock spent loading.
 */
export async function warmupRuntimeRenderProbe(): Promise<{
  ms: number;
  loaded: number;
  missing: number;
}> {
  const start = Date.now();
  let loaded = 0;
  let missing = 0;
  const tryLoad = async (specifier: string) => {
    try {
      await import(specifier);
      loaded += 1;
    } catch {
      missing += 1;
    }
  };
  // Must run before RTL's first import in this process — hosts that
  // call this warmup at process start (server-side blueprint
  // validation) land RTL in the module cache, with its act snapshot
  // taken, here — long before the first real probe call. See
  // production-act-shim.ts's docstring for why.
  installProductionActShim();
  await Promise.all([
    tryLoad("happy-dom"),
    tryLoad("@testing-library/react"),
    tryLoad("@testing-library/user-event"),
    tryLoad("@ggui-ai/wire"),
  ]);
  return { ms: Date.now() - start, loaded, missing };
}

/**
 * The component the boot warm renders: a constant element, an empty
 * contract — nothing to click, nothing to cover, one compile and one
 * render in the worker.
 */
const WARMUP_COMPONENT = "export default function Warmup() { return <div>warm</div>; }";

/**
 * Warm the PROCESS that runs every probe (ggui#1380): spawn one real check
 * worker on a trivial component through the same host every probe uses.
 * Afterwards the node binary, the worker's module tree and esbuild's
 * service have all run once on this machine (OS page cache warm), and the
 * result says whether that process can run a check at all — which
 * `warmupRuntimeRenderProbe` (an import in THIS process) cannot tell.
 *
 * `bounds` are the subprocess bounds for the one run; a serving deployment
 * passes the same bounds it will probe with. Never throws: a worker that
 * cannot run is `{ ok: false, reason }`, so a boot sequence can log it and
 * decide, instead of dying in a fire-and-forget.
 */
export async function warmupRuntimeRenderWorker(
  bounds?: Partial<RenderCheckHostBounds>
): Promise<{ ok: true; ms: number } | { ok: false; ms: number; reason: string }> {
  const start = Date.now();
  try {
    // Lazy: the host pulls `@ggui-ai/sandbox` (spawn machinery); keep it off
    // the import graph of everything that only needs the in-process check.
    const { runRenderCheckViaWorker } = await import("./render-check-host.js");
    const result = await runRenderCheckViaWorker(
      { sourceCode: WARMUP_COMPONENT, mockupProps: {}, contract: {} },
      bounds !== undefined ? { bounds } : {}
    );
    const ms = Date.now() - start;
    if (result.incomplete !== undefined) {
      return {
        ok: false,
        ms,
        reason: `the warm-up check did not finish within ${result.incomplete.boundMs} ms (stopped at ${result.incomplete.elapsedMs} ms)`,
      };
    }
    const blocking = result.issues.find(
      (i) => i.outcome === "failed" || i.outcome === "unverified"
    );
    if (blocking !== undefined) {
      return { ok: false, ms, reason: `${blocking.check} ${blocking.outcome}: ${blocking.reason}` };
    }
    return { ok: true, ms };
  } catch (err) {
    // The host itself never throws for a worker fault; what reaches here is
    // the spawn layer refusing to run at all (an invalid bound, no binary).
    return {
      ok: false,
      ms: Date.now() - start,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
