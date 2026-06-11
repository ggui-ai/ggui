// packages/ui-gen/src/evaluation/index.ts
//
// Public barrel for `@ggui-ai/ui-gen/evaluation` — the merged type
// vocabulary AND runtime cluster.
//
// Step 3 (2026-04-27): cloud's evaluation/ directory ported in. Two
// type families coexist (no name overlap):
//   - `./types-public.js` — the vocabulary the harness writes against
//     (`EvalIssue`, `EvalTier`, `Priority`, `EvalResult`, `EvalCriterion`,
//     `QualityConfig`, axis-check predicates, criteria registry).
//   - `./types.js` — the post-eval result shape (`DimensionScores`,
//     `EvaluationResult`, `EvaluationIssue`, `QualityMetadata`,
//     `EvaluationConfig`, `EvaluationContext`).
// Plus the runtime cluster (`runEvaluationLoop`, `runEvaluation`,
// `runAxisChecks`, evaluator MCP server, prompts, message parsing).

// Vocabulary the harness legs depend on (was: flat `packages/ui-gen/src/evaluation.ts`).
export type {
  Priority,
  EvalIssue,
  EvalTier,
  EvalOutcome,
  EvalCategory,
  EvalResult,
  EvalCriterion,
  QualityMode,
  QualityConfig,
  AxisCheck,
  AxisCheckInput,
} from './types-public.js';
export {
  CRITERIA,
  DEFAULT_QUALITY_CONFIG,
  matches,
  priorityForIssue,
  isBlocked,
  getActionableIssues,
  getCriteriaByPriority,
  getCriterionById,
  getLLMCriteria,
  buildCodingCriteriaSummary,
} from './types-public.js';

// Cloud-ported runtime cluster.
export { runEvaluationLoop } from './loop.js';
export type { EvaluationLoopOptions, EvaluationLoopResult } from './loop.js';
export { runEvaluation } from './evaluator.js';
export { createEvaluationToolsServer, computeEvaluationScore } from './mcp-server.js';
export type { EvaluateScoreInput } from './mcp-server.js';
export { getEvaluatorSystemPrompt, buildFixPrompt } from './prompts.js';
export {
  extractEvalResult,
  extractCompiledCode,
  extractCompiledCodeFromMessage,
  extractSourceCode,
  extractSourceCodeFromMessage,
  extractToolResultTexts,
} from './message-parsing.js';
export type { SdkMessage } from './message-parsing.js';
export {
  MAX_EVAL_ROUNDS_HARD_LIMIT,
  DEFAULT_EVAL_MAX_ROUNDS,
} from './types.js';
export type {
  DimensionScores,
  EvaluationIssue,
  EvaluationResult,
  QualityMetadata,
  EvaluationConfig,
  EvaluationContext,
} from './types.js';
export { runAxisChecks } from './axis-checks/index.js';
export type { RunAxisChecksInput } from './axis-checks/index.js';
