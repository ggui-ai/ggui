/**
 * Three seed cases for the v0 SLO harness.
 *
 * Each case pins:
 *   - a stable `id` (written into {@link SloRunResult.caseId})
 *   - the {@link SloBranchPath} the case drives
 *   - an `emitterPlan` — timing shape the harness uses to simulate
 *     the branch (see ./README.md "emitter-simulated" caveat)
 *   - the push input shape (intent wording)
 *
 * **Why simulated plans, not real blueprint/generator wiring?**
 * The open-source `ggui_push` handler doesn't branch on
 * blueprint-finder results — in the open-source build, stack-item
 * generation is not wired into the push path. Instead of blocking
 * the SLO harness on that, it drives the branches by configuring
 * what the emitter does. When real branch wiring exists, the
 * emitter-plan fields give way to actual blueprint/generator deps —
 * the SLO schema and summarizer don't change.
 *
 * The corpus deliberately picks distinct `intent` wordings so logs
 * are readable; it does NOT reuse BENCHMARK_COMMITS because v0 SLO
 * is protocol-level, not ui-gen-harness-level, and the commit corpus
 * carries contract/props we don't exercise here.
 */

import type { SloBranchPath } from './types.js';

/**
 * Emitter behavior the harness simulates for a case. Keep this
 * small — it's a test fixture, not a second emitter interface.
 */
export interface SloEmitterPlan {
  /**
   * Number of `emit()` calls the fake emitter will make before
   * returning. `0` means the emitter runs but never lands a frame
   * (legitimate edge case — surfaces `firstFrameAt: null` while
   * `previewFinalizedAt` is non-null).
   *
   * For v0 we never wire `0`-frame emitters on cases expected to
   * produce frames; the path exists in schema so null-handling
   * stays load-bearing.
   */
  readonly frames: number;
  /**
   * Delay before first `emit()` call, in milliseconds.
   * `blueprint_hit` cases target a tight budget (tens of ms);
   * `generation_miss` cases simulate a longer ramp (hundreds of ms).
   */
  readonly firstFrameDelayMs: number;
  /**
   * Delay between successive `emit()` calls. Only meaningful when
   * `frames > 1`.
   */
  readonly interFrameDelayMs: number;
}

export interface SloCase {
  readonly id: string;
  readonly path: SloBranchPath;
  /** Handshake input `intent` — used as-is. */
  readonly intent: string;
  /**
   * When `null`, the harness wires no emitter and the branch
   * behaves as an OSS-only push with provisional preview absent.
   * The push still succeeds; preview stamps are null.
   */
  readonly emitterPlan: SloEmitterPlan | null;
  /**
   * What the harness should tag the run with. The runner copies
   * these verbatim onto `SloRunTags` — keeping the "why this case
   * is classified this way" decision in the corpus, not the runner.
   */
  readonly usedBlueprint: boolean;
  readonly usedGeneration: boolean;
}

export const SLO_V0_CASES: readonly SloCase[] = [
  {
    id: 'blueprint-hit-weather',
    path: 'blueprint_hit',
    intent: 'show current weather for Tokyo',
    // Simulates a cached blueprint: single frame, fast.
    emitterPlan: {
      frames: 1,
      firstFrameDelayMs: 25,
      interFrameDelayMs: 0,
    },
    usedBlueprint: true,
    usedGeneration: false,
  },
  {
    id: 'generation-miss-dashboard',
    path: 'generation_miss',
    intent: 'build a dashboard with metrics and a chart',
    // Simulates a generation loop: multiple frames over a few
    // hundred ms. Matches the shape of a real streaming preview.
    emitterPlan: {
      frames: 4,
      firstFrameDelayMs: 60,
      interFrameDelayMs: 50,
    },
    usedBlueprint: false,
    usedGeneration: true,
  },
  {
    id: 'oss-miss-survey',
    path: 'oss_miss',
    intent: 'create a customer feedback survey',
    // OSS-only runtime: no provisional preview deps wired.
    // Expect null preview stamps — this is the null-as-signal case.
    emitterPlan: null,
    usedBlueprint: false,
    usedGeneration: false,
  },
];
