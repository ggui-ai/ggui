/**
 * Which in-loop evaluation legs a generation runs (ggui#1513).
 *
 * The harness gates its evaluation rounds on this, and nothing else does:
 * the text evaluator runs when `evaluation.enabled`, and the visual judge
 * runs when `visualEvaluation.enabled` or when a quality config asks for it
 * (`qualityConfig.visualEval`). A host that needs to know whether a
 * generation's token counts (`GenerationMetadata`) can include evaluation
 * calls reads it here, with the options it configured the generator with,
 * instead of keeping its own copy of the rule.
 */
import type { QualityConfig } from "../evaluation/types-public.js";

/** The switches that turn an in-loop evaluation leg on. */
export interface InLoopEvaluationSwitches {
  readonly evaluation?: { readonly enabled: boolean };
  readonly visualEvaluation?: { readonly enabled: boolean };
  readonly qualityConfig?: Pick<QualityConfig, "visualEval">;
}

/** The in-loop evaluation legs these options turn on. */
export function inLoopEvaluation(options: InLoopEvaluationSwitches): {
  readonly text: boolean;
  readonly visual: boolean;
} {
  return {
    text: options.evaluation?.enabled === true,
    visual: options.visualEvaluation?.enabled === true || options.qualityConfig?.visualEval === true,
  };
}

/**
 * True when these options turn either leg on: a generation built with them
 * can spend tokens on evaluation calls as well as on its coding turns.
 */
export function runsInLoopEvaluation(options: InLoopEvaluationSwitches): boolean {
  const legs = inLoopEvaluation(options);
  return legs.text || legs.visual;
}
