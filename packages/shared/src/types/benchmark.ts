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
  /**
   * Cells whose judge panel produced a score. Optional: reports
   * published before 2026-08-20 predate the field.
   */
  evaluatedCount?: number;
  /**
   * `evaluatedCount` over the generation-succeeded cells (the judgeable
   * subset); 0 when nothing generated. Raw ratio, like `successRate`.
   * Optional for the same pre-2026-08-20 reason.
   */
  judgeCoverage?: number;
  /**
   * Present (true) when evaluation ran but judge coverage fell under the
   * runner's floor — this run's aggregate scores rest on too few judged
   * cells to be representative. Viewers must annotate scores from a
   * degraded run rather than presenting them as full-coverage means.
   */
  judgeCoverageDegraded?: true;
  /**
   * Per-criterion coverage of the in-loop evaluator over the run's
   * tier-evaluated cells. A criterion that never ran fail-opens into
   * `pass` inside the evaluator, so a pass with skipped coverage is zero
   * evidence — this is the disclosure. `unknown` = cells whose eval
   * predates the instrument (or lacks that criterion's row). Cells whose
   * evaluator was bypassed by design (all rows `not-applicable`) sit
   * outside the coverage denominator but are counted as `notApplicable`.
   * Absent when no cell carries the instrument — an all-bypass run is
   * PRESENT (nothing applicable), which is not the same as pre-instrument.
   */
  criteriaCoverage?: CriterionCoverageSummaryDisplay[];
  /**
   * Present (true) when some criterion ran on fewer than the runner's
   * floor of tier-evaluated cells — its pass/warn/fail counts are not
   * representative. Viewers must annotate.
   */
  criteriaCoverageDegraded?: true;
  /**
   * Report JSON shape version. `'benchmark-report.v2'` (#973): per-cell
   * `runtimeProbeVerdict` / `contractBehavior` / `visualCanvases`.
   * `'benchmark-report.v1'` from 2026-09-07: generator ids de-modeled
   * (`ui-gen-default` / `ui-gen-advanced`). Absent = v0, whose generator ids
   * carried model names (`ui-gen-default-haiku-4-5`).
   */
  schemaVersion?: 'benchmark-report.v1' | 'benchmark-report.v2';
  /** SPDX id of the published dataset license. */
  dataLicense?: string;
}

/**
 * Run-level roll-up of one eval criterion's coverage. `ran + skipped +
 * unknown` = the cells the criterion applied to (the denominator).
 */
export interface CriterionCoverageSummaryDisplay {
  criterion: string;
  tier: 1 | 2;
  ran: number;
  skipped: number;
  unknown: number;
  /**
   * Cells the evaluator bypassed by design for this criterion — outside
   * the denominator, counted so "nothing applicable" is visible. Absent
   * on reports published before 2026-09-03 (read as 0).
   */
  notApplicable?: number;
}

/**
 * One cell's coverage row for one eval criterion (mirrors ui-gen's
 * `CriterionCoverage`). `not-applicable` = the evaluator was bypassed by
 * design for this cell (same-image low-risk); `reason` says why.
 */
export interface CriterionCoverageDisplay {
  criterion: string;
  tier: 1 | 2;
  status: 'ran' | 'skipped' | 'not-applicable';
  reason?: string;
}

/** Which model + prompt version produced the quality scores. */
export interface JudgeDisclosureDisplay {
  model: string;
  promptVersion: string;
  /**
   * Sampling the judge ACTUALLY ran with, as reported by the harness router
   * (the panel requests temperature 0; families that reject sampling
   * params get `'provider-default'` plus the reason). Absent on reports
   * published before 2026-09-02 or when the router reported nothing —
   * unknown, never assumed.
   */
  sampling?: { temperature: number | 'provider-default'; strippedReason?: string };
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
  /**
   * The triad the cell ran under — present only when the run set the
   * arm switch (`--design-mode`); absent on default runs. Vocabulary
   * mirrors `DesignMode` in `@ggui-ai/ui-gen` (pinned at compile time
   * in the benchmark reporter — this package cannot depend on ui-gen).
   */
  designMode?: 'constrained' | 'free';
  /**
   * The canvas class the free prompt stated for this cell — present
   * only when the run set it or ran the free arm. Mirrors `CanvasClass`
   * in `@ggui-ai/ui-gen` (same compile-time pin).
   */
  canvas?: 'xs-chat-card' | 'mobile-fullscreen-small' | 'md' | 'lg' | 'xl';
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
  /**
   * Per-criterion ran/skipped rows for this cell's eval. Absent when the
   * eval predates the instrument — coverage unknown, never assumed ran.
   * A criterion in `pass` with status `skipped` carried no verdict.
   */
  criteriaCoverage?: CriterionCoverageDisplay[];
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
  /** Runner's per-cell runtime-probe verdict (`benchmark-report.v2`, #973). */
  runtimeProbeVerdict?: RuntimeProbeVerdictDisplay;
  /** `validateContractBehavior` re-run in-task for this cell (`benchmark-report.v2`, #973). */
  contractBehavior?: ContractBehaviorDisplay;
  /** Per-canvas visual scores + PNG artefact refs (`benchmark-report.v2`, #973). */
  visualCanvases?: VisualCanvasArtefactDisplay[];
  postGeneration?: PostGenerationDisplay;
}

/** Mirrors `ContractBehaviorResult` in `@ggui-ai/benchmark/multi-sdk/contract-behavior`. */
export interface ContractBehaviorDisplay {
  status: 'ran' | 'skipped';
  ok?: boolean;
  failures?: ReadonlyArray<{ kind: 'action-no-effect' | 'action-not-rendered' | 'render-failed' | 'timeout'; actionName?: string; diagnostic: string }>;
  reason?: string;
  durationMs?: number;
}

/** Mirrors `VisualCanvasArtefact` in `@ggui-ai/benchmark/multi-sdk/canvas` — the PNG itself is never in the report. */
export interface VisualCanvasArtefactDisplay {
  canvas: 'xs-chat-card' | 'mobile-fullscreen-small' | 'md' | 'lg' | 'xl';
  viewport: { width: number; height: number };
  score: number;
  passed: boolean;
  artefact: { path: string; sha256: string; bytes: number };
}

/**
 * Mirrors `RuntimeProbeVerdict` in `@ggui-ai/benchmark/multi-sdk/runtime-probe`.
 * `skipped` is never a pass and always carries `reason`.
 */
export interface RuntimeProbeVerdictDisplay {
  status: 'ran' | 'skipped';
  passed: boolean;
  failures: number;
  warnings: number;
  reason?: string;
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
