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
   * Per-floor summary view — OSS vs hosted. Optional because
   * pre-floor-split reports (historical) don't carry it, and
   * single-floor runs emit a length-1 array. Field shape matches
   * `FloorSummary` in `@ggui-ai/benchmark/multi-sdk/types`;
   * duplicated here instead of cross-imported so shared types stay
   * free of the core workspace dep.
   */
  floorSummaries?: FloorSummaryDisplay[];
  /**
   * Per-generator comparison matrix —
   * `byGenerator[slug][commitId][sdkName]` = aggregate metrics.
   * Optional because older reports don't carry it; single-generator
   * runs emit a one-key map. Field shape matches
   * `GeneratorComparisonMatrix` in `@ggui-ai/benchmark/multi-sdk/types`;
   * duplicated here for the same dep-isolation reason as
   * `floorSummaries`.
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

export interface FloorSummaryDisplay {
  floor: 'oss' | 'hosted';
  runs: number;
  avgTimeMs: number;
  avgScore: number;
  successRate: number;
  capHitRate: number;
  errorBuckets: {
    pass: number;
    patchInvalid: number;
    selfCheckFail: number;
    diffFail: number;
  };
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

export interface EvaluationResultDisplay {
  passed: boolean;
  score: number;
  dimensions?: Record<string, number>;
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
  /** S3 key for the compiled component JS (so frontend can fetch directly) */
  compiledCodeS3Key?: string;
}

export interface VariantSummaryDisplay {
  variantId: string;
  sdkName: string;
  tier: string;
  modelId: string;
  avgScore: number;
  avgTimeMs: number;
  avgCostUsd: number;
  passRate: number;
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
