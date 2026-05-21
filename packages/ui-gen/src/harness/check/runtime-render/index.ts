// packages/ui-gen/src/harness/check/runtime-render/index.ts
//
// Public surface for runtime render evaluation.
//
// runRenderCheck() takes a compiled component + mockup props + contract,
// renders it in happy-dom with a probe-backed WireConfig, and verifies:
//   - it renders without throw                       (block)
//   - declared actions fire when the wired UI is clicked   (block)
//   - declared wiredTools are callable from the UI         (block, if present)
//   - declared clientTools register their handlers         (block, if present)
//   - declared props appear in the DOM                     (warn)
//   - declared stream events update the DOM when emitted   (warn)

export { runRenderCheck, type RenderCheckResult, type RenderCheckIssue } from "./render-check.js";
export { createProbe, createProbeWireConfig, type Probe } from "./probe.js";
export { prepareMockupProps, type MockupPropsResult } from "./prepare-mockup.js";
export {
  DEFAULT_RUNTIME_RENDER_CHECK,
  classifyRenderCrashFix,
  isRecoverableRenderCrash,
} from "./adapter.js";

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
export async function warmupRuntimeRenderProbe(): Promise<{ ms: number; loaded: number; missing: number }> {
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
  await Promise.all([
    tryLoad("happy-dom"),
    tryLoad("@testing-library/react"),
    tryLoad("@testing-library/user-event"),
    tryLoad("@ggui-ai/wire"),
  ]);
  return { ms: Date.now() - start, loaded, missing };
}
