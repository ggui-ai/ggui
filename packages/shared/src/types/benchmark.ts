/**
 * Display-oriented benchmark types.
 * Consumed by apps/benchmarks (Next.js) and core/ (via toDisplayReport).
 * These are a serialization-safe subset of the runner-internal types.
 */

export interface BenchmarkReportDisplay {
  meta: BenchmarkMeta;
  results: BenchmarkRunResultDisplay[];
  variantSummaries: VariantSummaryDisplay[];
  commitSummaries: CommitSummaryDisplay[];
  sdkComparison: Record<string, Record<string, SdkComparisonEntry>>;
  /**
   * Per-generator comparison matrix —
   * `byGenerator[slug][commitId][sdkName]` = aggregate metrics.
   * Optional because older reports don't carry it; single-generator
   * runs emit a one-key map. Field shape matches
   * `GeneratorComparisonMatrix` in `@ggui-ai/benchmark/multi-sdk/types`;
   * duplicated here instead of cross-imported so shared types stay
   * free of the core workspace dep.
   */
  byGenerator?: Record<
    string,
    Record<string, Record<string, GeneratorComparisonCellDisplay>>
  >;
  /**
   * Cross-(commit, sdk) summary per generator slug. Optional for the
   * same dep-isolation reason; one entry per distinct generator that
   * produced a run.
   */
  generatorSummaries?: GeneratorSummaryDisplay[];
}

/**
 * One cell of the multi-generator comparison matrix. Mirrors
 * `GeneratorComparisonCell` in the runner-internal types.
 * `avgScore === -1` is the "not evaluated" sentinel.
 */
export interface GeneratorComparisonCellDisplay {
  generator: string;
  commitId: string;
  sdkName: string;
  runs: number;
  avgScore: number;
  avgTimeMs: number;
  avgCostUsd: number;
  successRate: number;
}

/**
 * Cross-(commit, sdk) summary per generator slug. Mirrors
 * `GeneratorSummary` in the runner-internal types.
 */
export interface GeneratorSummaryDisplay {
  generator: string;
  runs: number;
  avgScore: number;
  avgTimeMs: number;
  avgCostUsd: number;
  successRate: number;
}

export interface BenchmarkMeta {
  reportId: string;
  timestamp: string;
  version: string;
  totalVariants: number;
  totalCommits: number;
  totalRuns: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  durationMs: number;
  /**
   * Disclosure of the LLM judge PANEL that produced every `score` in
   * this report — one entry per distinct judge model. Absent when no
   * result was evaluated (skip-evaluation runs).
   */
  judges?: JudgeDisclosureDisplay[];
}

/** Which model + prompt version produced the quality scores. */
export interface JudgeDisclosureDisplay {
  model: string;
  promptVersion: string;
}

export interface VariantInfo {
  id: string;
  sdkName: string;
  tier: string;
  modelId?: string;
}

export interface CommitInfo {
  id: string;
  name: string;
  complexity: string;
}

export interface GenerationResultDisplay {
  generationTimeMs: number;
  turnsUsed: number;
  tokens: { input: number; output: number; total: number };
  passesUsed?: number;
}

/**
 * The 5 dimensions the aesthetic judge actually measures. Mirrors
 * `AestheticScores` in `@ggui-ai/benchmark/multi-sdk/post-eval`;
 * duplicated here (named, not an index signature) so the compiler
 * catches dimension drift between the runner and the viewer.
 */
export interface EvaluationDimensionsDisplay {
  layout: number;
  designTokens: number;
  hierarchy: number;
  polish: number;
  dataPresentation: number;
}

/**
 * One judge's contribution to the panel for a single evaluated run.
 * Mirrors `SingleJudgeResult` (minus token counts, which are
 * cost-accounting internals not surfaced to the viewer) from
 * `@ggui-ai/benchmark/multi-sdk/post-eval`.
 */
export interface PanelJudgeBreakdownDisplay {
  judge: JudgeDisclosureDisplay;
  score: number;
  dimensions: EvaluationDimensionsDisplay;
  critique?: string;
}

export interface EvaluationResultDisplay {
  passed: boolean;
  /** Panel aggregate score (mean of the surviving judges). */
  score: number;
  /** Panel aggregate per-dimension means. */
  dimensions: EvaluationDimensionsDisplay;
  /** Distinct judge disclosures (model + prompt version) on this panel. */
  judges: JudgeDisclosureDisplay[];
  /** Per-judge breakdown — one entry per judge that responded. */
  panel: PanelJudgeBreakdownDisplay[];
  /** max−min of the surviving judges' weighted scores — disagreement signal. */
  spread: number;
  critique?: string;
  evalTimeMs?: number;
}

export interface TierEvaluationDisplay {
  issues: Array<{
    tier: number;
    result: string;
    category: string;
    description: string;
  }>;
  pass: string[];
}

export interface PostGenerationDisplay {
  hasStreamSpec: boolean;
  hasGeneratorMeta: boolean;
  compiledCodeBytes: number;
  sourceCodeBytes?: number;
  dataFreeCheck?: { isDataFree: boolean; violations: string[] };
  /**
   * Plugin-aware bench commits (commits that declare `appGadgets`)
   * get a deterministic wrapper-usage check. Mirrors
   * `PostGenerationResult.gadgetUsage` from
   * `packages/benchmark/src/multi-sdk/types.ts`. Absent on commits
   * with no `appGadgets` declared OR when the generation produced
   * no sourceCode.
   */
  gadgetUsage?: {
    declared: readonly string[];
    used: readonly string[];
    missing: readonly string[];
  };
}

export interface BenchmarkRunResultDisplay {
  variant: VariantInfo;
  commit: CommitInfo;
  generation: GenerationResultDisplay | null;
  evaluation: EvaluationResultDisplay | null;
  tierEvaluation?: TierEvaluationDisplay;
  estimatedCostUsd: number;
  error?: string;
  timestamp: string;
  postGeneration?: PostGenerationDisplay;
}

export interface VariantSummaryDisplay {
  variantId: string;
  sdkName: string;
  tier: string;
  modelId: string;
  avgScore: number;
  avgTimeMs: number;
  avgCostUsd: number;
  /**
   * Generation success rate (generation produced output without
   * erroring) — NOT a quality-threshold pass rate.
   */
  successRate: number;
  totalRuns: number;
}

export interface CommitSummaryDisplay {
  commitId: string;
  name: string;
  complexity: string;
  bestVariantId: string;
  worstVariantId: string;
  avgScore: number;
}

export interface SdkComparisonEntry {
  avgScore: number;
  avgTimeMs: number;
  avgCostUsd: number;
  successRate: number;
}
