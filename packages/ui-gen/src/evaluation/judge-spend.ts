/**
 * ggui#1640 — one judged frame's (or one visual evaluation's) spend, summed over EVERY leg the judge reports.
 *
 * The judge reports its legs apart: the scoring calls' `inputTokens` / `outputTokens`, and, since ggui#1436, the
 * report-only criteria call's `criteriaTokens`. A caller that sums only the first leg under-counts, and a dollar
 * ceiling built on that sum stops late. {@link judgedFrameTokens} is the one sum. The two `satisfies` tables below list
 * every `*Tokens` member of the results it reads, so a leg added to either result type fails the build here until the
 * sum counts it.
 */
import type { CriteriaCallTokens, StoredCaptureVerdict, VisualEvaluationResult } from './visual-evaluator.js';

/** A spend in tokens: input and output, over every leg. */
export interface JudgeSpend {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** The members of `T` whose names end in `Tokens`. */
type TokenMember<T> = { [K in keyof T]-?: K extends `${string}Tokens` ? K : never }[keyof T];

/** Which leg each `*Tokens` member belongs to. A member missing here, or listed and gone, is a compile error. */
const STORED_VERDICT_LEGS = {
  inputTokens: 'scoring',
  outputTokens: 'scoring',
  criteriaTokens: 'criteria',
} as const satisfies Record<TokenMember<StoredCaptureVerdict>, 'scoring' | 'criteria'>;
const VISUAL_RESULT_LEGS = {
  inputTokens: 'scoring',
  outputTokens: 'scoring',
  criteriaTokens: 'criteria',
} as const satisfies Record<TokenMember<VisualEvaluationResult>, 'scoring' | 'criteria'>;
void STORED_VERDICT_LEGS;
void VISUAL_RESULT_LEGS;

/** The legs {@link judgedFrameTokens} reads, as both result types carry them. */
export interface JudgedTokens {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly criteriaTokens?: CriteriaCallTokens;
}

/** A judged frame's spend over every leg: the scoring calls plus the report-only criteria call, when one ran. */
export function judgedFrameTokens(result: JudgedTokens): JudgeSpend {
  return {
    inputTokens: (result.inputTokens ?? 0) + (result.criteriaTokens?.inputTokens ?? 0),
    outputTokens: (result.outputTokens ?? 0) + (result.criteriaTokens?.outputTokens ?? 0),
  };
}
