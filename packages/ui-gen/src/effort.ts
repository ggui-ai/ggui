// The `effort` reader table (ggui#1059, A2). The wire carries ONLY the level
// name (`generation.profile.effort`, protocol #1058); this table is the
// cold-gen READER that maps a name onto the harness's dials, versioned here
// so a level's meaning (and its price line) can move without a wire change.
//
// Boundaries, stated once:
//  - `effort` renders NO prompt text — the prompt is byte-identical under any
//    level (`profile-cross.pin.test.ts`). Dials only.
//  - Absent ⇒ the deployment's own options, untouched. The table is applied
//    only when a level is named.
//  - `selfEvalPassThreshold` is the GENERATOR's in-loop visual
//    self-evaluation threshold (`visualEvaluation.passThreshold`). A serving
//    layer's own acceptance bar is a different number and does not move with
//    `effort`.
//  - `modelTier` / `judgeTier` are REQUESTS to the deployment's router
//    (`fast | balanced | premium`), never a model id: a deployment with one
//    key is never promoted by a profile. The harness does not act on them;
//    the caller that owns model selection reads them from this table.
import type { AppGenerationProfileEffort, ModelTier } from "@ggui-ai/protocol";

/** Bump when a level's meaning changes; the price line beside it follows. */
export const EFFORT_TABLE_VERSION = 1;

export interface EffortDials {
  /** Coding-loop turn cap (`maxAttempts`). */
  readonly maxAttempts: number;
  /** Evaluation rounds the harness may spend (`maxEvalRounds`). */
  readonly maxEvalRounds: number;
  /** The generator's in-loop visual self-evaluation threshold, 0–100 — not a serving layer's acceptance bar. */
  readonly selfEvalPassThreshold: number;
  /** Requested coding-model tier — a request to the deployment's router, never a model id. */
  readonly modelTier: ModelTier;
  /** Requested judge-model tier — same nature. */
  readonly judgeTier: ModelTier;
}

export const EFFORT_DIALS: Readonly<Record<AppGenerationProfileEffort, EffortDials>> = {
  low: { maxAttempts: 5, maxEvalRounds: 1, selfEvalPassThreshold: 65, modelTier: "fast", judgeTier: "fast" },
  medium: { maxAttempts: 8, maxEvalRounds: 2, selfEvalPassThreshold: 70, modelTier: "fast", judgeTier: "balanced" },
  high: { maxAttempts: 8, maxEvalRounds: 3, selfEvalPassThreshold: 75, modelTier: "balanced", judgeTier: "balanced" },
  xhigh: { maxAttempts: 10, maxEvalRounds: 3, selfEvalPassThreshold: 80, modelTier: "premium", judgeTier: "balanced" },
  ultra: { maxAttempts: 12, maxEvalRounds: 4, selfEvalPassThreshold: 85, modelTier: "premium", judgeTier: "premium" },
};

/** The dials for a named level; `undefined` when no level is named (the deployment's options stand). */
export function effortDials(effort: AppGenerationProfileEffort | undefined): EffortDials | undefined {
  return effort === undefined ? undefined : EFFORT_DIALS[effort];
}
