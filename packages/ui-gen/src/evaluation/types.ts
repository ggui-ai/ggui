// packages/ui-gen/src/evaluation/types.ts

/**
 * Per-dimension quality scores from the evaluator (0-100 each).
 */
export interface DimensionScores {
  /** How well the component fulfills the original prompt requirements */
  completeness: number;
  /** Visual quality: layout, typography, spacing, color usage */
  visualPolish: number;
  /** Interaction quality: hover states, transitions, form validation */
  interactivity: number;
  /** Accessibility: ARIA labels, keyboard navigation, contrast ratios */
  accessibility: number;
  /** Code quality: TypeScript types, clean structure, no anti-patterns */
  codeQuality: number;
}

/**
 * A specific issue found during evaluation.
 */
export interface EvaluationIssue {
  /** Which quality dimension this issue belongs to */
  dimension: string;
  /** Human-readable description of what is wrong */
  description: string;
  /** Severity level: critical blocks shipping, major degrades quality, minor is a polish issue */
  severity: 'critical' | 'major' | 'minor';
  /** Suggested fix for the agent to apply */
  fix: string;
}

/**
 * Result of a single evaluation round.
 */
export interface EvaluationResult {
  /** Whether the component passed the quality threshold */
  passed: boolean;
  /** Weighted average score across all dimensions (0-100) */
  finalScore: number;
  /** Per-dimension score breakdown */
  dimensions: DimensionScores;
  /** Specific issues identified in this round */
  issues: EvaluationIssue[];
  /** Free-form critique text from the evaluator LLM */
  critique?: string;
  /** Input tokens consumed by the evaluation LLM call */
  inputTokens?: number;
  /** Output tokens consumed by the evaluation LLM call */
  outputTokens?: number;
}

/**
 * Quality metadata attached to every generated component
 */
export interface QualityMetadata {
  /** Number of evaluation rounds run (0 = strict/no eval) */
  evaluationRounds: number;
  /** Final average score 0-100 */
  finalScore: number;
  /** Per-dimension breakdown */
  dimensions: DimensionScores;
  /** Whether the component passed (score >= threshold) */
  passed: boolean;
  /** Model used for evaluation */
  evaluatorModel: string;
  /** Total evaluation loop time in ms */
  evaluationTimeMs: number;
  /** S3 keys for screenshots (creative only) */
  screenshots?: string[];
}

/** Hard ceiling for evaluation rounds — never exceed this regardless of config */
export const MAX_EVAL_ROUNDS_HARD_LIMIT = 10;

/** Default (soft) max rounds for the balanced strategy */
export const DEFAULT_EVAL_MAX_ROUNDS = 10;

/**
 * Configuration for the evaluation loop
 */
export interface EvaluationConfig {
  /** Whether evaluation is enabled */
  enabled: boolean;
  /** Model to use for evaluation (default: provider's default) */
  model?: string;
  /** LLM provider for evaluation (default: same as generation provider) */
  provider?: 'claude' | 'openai' | 'google' | 'openrouter';
  /** Minimum average score to pass (default: 70) */
  passThreshold: number;
  /** Maximum evaluation rounds (soft max: 3, hard limit: 5) */
  maxRounds?: number;
  /** Budget cap per evaluation round in USD */
  maxBudgetPerEval?: number;
  /** Budget cap per fix round in USD */
  maxBudgetPerFix?: number;
}

/**
 * Context passed to the evaluator
 */
export interface EvaluationContext {
  /** TSX source code written by the generator */
  sourceCode: string;
  /** Compiled JavaScript output */
  compiledCode: string;
  /** Original user prompt */
  originalPrompt: string;
  /** DESIGN.md content (if present) */
  designContext?: string;
  /** CSS variable tokens for the app theme */
  themeTokens: string;
}
