/**
 * Advanced UI generator — `ui-gen-advanced-opus-4-7`.
 *
 * Iterative two-stage validator-feedback loop. Sibling to the default
 * generator at `@ggui-ai/ui-gen/create-ui-generator.ts`. The default
 * ships a single-pass generation flow; this generator wraps it with:
 *
 *   1. Fast stage (every iteration) — happy-dom `runRenderCheck` on
 *      the source. Catches contract-wiring bugs (missing useAction,
 *      stream subscription typos), render-time throws, prop coverage
 *      gaps. ~50-200ms per call after warm-up.
 *
 *   2. Slow stage (final gate before commit) — Playwright real-browser
 *      `validateContractBehavior` from `@ggui-ai/ui-visual-tester`.
 *      Catches behavioural bugs the fast stage misses: click-and-observe
 *      against the per-action classification gate (agent-bound vs
 *      context-bound).
 *
 *   3. Iterative loop — generate → fast → (if pass) slow → return on
 *      pass, regenerate with appended complaints on fail. Max 3
 *      iterations. Always-persist regardless of final score (the
 *      blueprint store decides whether to mark sub-threshold variants
 *      as matchable; this generator just returns its best try).
 *
 * Playwright is a HARD dep injection — pass `{ chromium }` from
 * `playwright-core` via `createAdvancedUiGenerator({ playwright })`.
 * Missing the dep throws on every `generate()` call (not at factory
 * time) so a config file dropping the registration is observable.
 *
 * Default OSS install does NOT ship Playwright. Cloud operators opt
 * into this generator by deploying `ggui-protocol-pod-advanced`, the
 * pod image variant that bakes Playwright + Chromium.
 */
export {
  createAdvancedUiGenerator,
  type CreateAdvancedUiGeneratorOptions,
  type AdvancedGeneratorPlaywright,
  type ValidationDiagnostic,
  type ValidationStageResult,
  type ValidationIteration,
  ADVANCED_GENERATOR_SLUG,
  ADVANCED_GENERATOR_TIER,
  ADVANCED_GENERATOR_MODEL,
} from './generator.js';

export {
  buildFastStageComplaints,
  buildSlowStageComplaints,
  buildIterationFeedback,
} from './feedback.js';
