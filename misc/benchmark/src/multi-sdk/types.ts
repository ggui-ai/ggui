// core/src/benchmarks/multi-sdk/types.ts

import type { GadgetDescriptor, ModelTier, LlmProvider, DataContract, JsonObject } from '@ggui-ai/protocol';
import type { DimensionScores, EvaluationResult } from '@ggui-ai/ui-gen/evaluation/types';
import type { EvalResult } from '@ggui-ai/ui-gen/evaluation';
import type { ProviderName, AdapterResult, AdapterMode } from '@ggui-ai/ui-gen/adapters/types';
import type { ModelRoles, RenderingContext } from '@ggui-ai/ui-gen/harness/result-types';
import type { BenchmarkStorage } from './storage/types.js';

export { PROVIDER_DISPLAY_NAMES } from '@ggui-ai/ui-gen/adapters/types';

// Re-export for use in this module
export type { ProviderName, AdapterResult, AdapterMode };

// =============================================================================
// Benchmark Floor (OSS vs Hosted — the bench's public-interface split axis)
// =============================================================================

/**
 * Benchmark floor — which deployment-shape a variant represents.
 *
 * `oss`    — honest open-source baseline. No hosted blueprint registry
 *            path, no hosted-only defaults. Today's bench default — any
 *            variant with no explicit floor is treated as `oss` so
 *            historical runs remain interpretable.
 *
 * `hosted` — hosted/default path enabled. Today there is NO active
 *            divergence — system prompt, tools, criteria, runtime render,
 *            and model routing are identical to OSS. The flag is the
 *            reporting seam: as hosted-vs-OSS differences land in the
 *            generation path they route through it.
 *
 * See `./floor.md` for the full rationale + current caveat list.
 */
export type BenchmarkFloor = 'oss' | 'hosted';

/** Default floor when none is specified — preserves today's behavior. */
export const DEFAULT_BENCHMARK_FLOOR: BenchmarkFloor = 'oss';

// =============================================================================
// Benchmark Variant (a single SDK + model combo)
// =============================================================================

export interface BenchmarkVariant {
  /** Unique identifier (e.g., 'claude-fast', 'openai-balanced'). For
   * floor-tagged variants the id is typically suffixed with the floor
   * (e.g., 'claude-fast-hosted') — `applyFloor` in variants.ts does
   * this automatically. */
  id: string;
  /** Which SDK adapter to use */
  sdkName: ProviderName;
  /** Model tier */
  tier: ModelTier;
  /** Explicit model ID override (LiteLLM format, e.g., 'anthropic/claude-haiku-4-5') */
  modelId?: string;
  /** Model-specific options (e.g., speed_priority for Claude fast mode) */
  modelOptions?: JsonObject;
  /** Hybrid configuration: different models for draft vs review */
  hybrid?: HybridConfig;
  /** Adapter mode: raw API or agent SDK */
  mode?: AdapterMode;
  /** Model roles for hybrid generation (thinking/coding/evaluation/default) */
  modelRoles?: ModelRoles;
  /** Rendering context — device + shell type for layout-aware generation */
  rendering?: RenderingContext;
  /** Planning mode: 'stuffed' (default) or 'agentic' (tool-calling loop) */
  planningMode?: 'stuffed' | 'agentic';
  /**
   * Which deployment-shape this variant exercises. When omitted the
   * runner treats it as {@link DEFAULT_BENCHMARK_FLOOR} (`oss`) so
   * pre-floor variant definitions continue to behave as they did.
   */
  floor?: BenchmarkFloor;

  /**
   * UI generator slug. Identifies which registered `UiGenerator`
   * impl runs this variant. Optional — defaults to
   * {@link DEFAULT_GENERATOR_SLUG} (`ui-gen-default-haiku-4-5`, the
   * open-source seed) so existing bench corpus / fixtures don't need
   * to be migrated.
   *
   * Bench reports break out comparisons along this axis: same
   * commit × same SDK × different generators side-by-side. See
   * {@link BenchmarkReport.byGenerator} for the comparison matrix.
   *
   * Recognized slugs:
   *   - `ui-gen-default-haiku-4-5` — the open-source seed; routes
   *     through `dispatchGeneration`.
   *   - `ui-gen-advanced-opus-4-7` — iterative two-stage validator
   *     loop. Requires Playwright in the bench env; skipped with a
   *     clear log line when Playwright is missing.
   *
   * Unknown slugs are surfaced as a per-task error result so the
   * report still has a row for the (commit, variant) pair.
   */
  generator?: string;
}

/**
 * Default generator slug used when {@link BenchmarkVariant.generator}
 * is absent. Pinned to the open-source seed so older fixtures keep
 * producing identical results.
 */
export const DEFAULT_GENERATOR_SLUG = 'ui-gen-default-haiku-4-5' as const;

/**
 * The advanced-generator slug. Recognized by the bench runner; when
 * a variant requests it, the runner uses `createAdvancedUiGenerator`
 * from `@ggui-ai/ui-gen/advanced`. Requires Playwright in the bench
 * env (gated at runtime — the runner emits a skip when missing).
 */
export const ADVANCED_GENERATOR_SLUG = 'ui-gen-advanced-opus-4-7' as const;

export interface HybridConfig {
  /** Model for initial draft generation */
  draftModel: string;
  /** Model for review/fix phase */
  reviewModel: string;
}

// =============================================================================
// Benchmark Commit — bench fixture (named "commit" for the generation
// commit unit, NOT the retired ggui_commit tool)
// =============================================================================

export interface BenchmarkCommit {
  /** Unique identifier (e.g., 'weather-card') */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description for reports */
  description: string;
  /** Complexity classification */
  complexity: 'simple' | 'medium' | 'complex';
  /** Expected minimum quality score (for regression detection) */
  expectedMinScore?: number;

  /** Shell type for layout-adaptive boilerplate */
  shellType?: string;
  /** Target screen size for responsive layout */
  screen?: string;

  // ── CommitWithGeneration fields ──

  /** Natural language prompt for generation */
  prompt: string;
  /** Full data contract — interaction mode, props schema, stream spec, actions */
  contract: DataContract;
  /** Initial data matching the contract.propsSpec schema */
  props?: JsonObject;
  /** UX/presentation instructions */
  instructions?: string;

  /**
   * Personalization variance hint. Carries the persona / aesthetic /
   * context signal the generator should reflect in the produced UI.
   * Two commits with the same contract but different
   * `variance.persona` should produce two distinct visual outputs —
   * that's the bench's personalization scenario.
   *
   * **Plumbing:** the runner threads variance into the user prompt
   * as a textual block (`## Variance Hint\nPersona: …`) appended to
   * the user prompt. This is a no-op at the contract / handshake
   * level — variance influences the LLM only via the prompt-text
   * channel.
   */
  variance?: BenchmarkCommitVariance;

  /**
   * Operator-registered gadget catalog for this commit. Mirrors what
   * a self-hosted server's `ggui.json#app.gadgets` would seed at
   * boot — registered wrappers the bench's cold-gen LLM is allowed
   * to reference from `contract.clientCapabilities.gadgets`.
   *
   * When set, the runner threads this into `dispatchGeneration` so
   * the code-gen system prompt's `clientCapabilities — registered
   * catalog` table renders these wrappers (instead of the default
   * `STDLIB_GADGETS` seed). Used for plugin-aware bench
   * commits (Leaflet, Mapbox, …) that exercise the wrapper-
   * authoring path end-to-end.
   *
   * Pre-plugin-slice commits leave this absent — the prompt falls
   * through to STDLIB, byte-identical to the original bench shape.
   */
  appGadgets?: readonly GadgetDescriptor[];

  /**
   * Per-package `.d.ts` content for the gadgets in {@link appGadgets},
   * keyed by npm package name. Mirrors what the production render
   * handler parallel-fetches from each gadget's `typesUrl` — the
   * runner threads it into `dispatchGeneration` so the coding agent's
   * typecheck overlays the real wrapper types (a mistyped gadget call
   * surfaces a blocking error instead of collapsing to `any`).
   *
   * Hand-maintained inline (like {@link appGadgets}) so the bench
   * commit stays self-contained — no workspace cross-dependency on the
   * sample gadget's built output. Stdlib gadgets (`@ggui-ai/gadgets`)
   * need no entry; their `.d.ts` ships into the typecheck VFS already.
   * Absent → third-party gadget imports collapse to `any` (degraded,
   * not a generation blocker).
   */
  gadgetTypes?: Readonly<Record<string, string>>;
}

/**
 * Personalization variance hint on a {@link BenchmarkCommit}.
 * Mirrors the locked MVB shape (plan §D1 + §D10) — free-form persona
 * + aesthetic strings, optional structured context, optional raw
 * style seed prompt. All fields optional; an empty `variance: {}`
 * is meaningful as "explicitly no personalization."
 */
export interface BenchmarkCommitVariance {
  /** Free-form persona tag (e.g. `'minimalist'`, `'data-dense'`). */
  readonly persona?: string;
  /** Free-form aesthetic tag (e.g. `'glassy'`, `'flat'`, `'editorial'`). */
  readonly aesthetic?: string;
  /** Small structured signal — passed verbatim into the prompt block. */
  readonly context?: JsonObject;
  /** Raw operator style hint appended to the prompt. */
  readonly seedPrompt?: string;
}

// =============================================================================
// Benchmark Run Result (single variant x commit)
// =============================================================================

export interface BenchmarkRunResult {
  /** Which variant was tested */
  variant: BenchmarkVariant;
  /** Which commit input was used */
  commit: BenchmarkCommit;
  /** Generation result (null if failed) */
  generation: AdapterResult | null;
  /** Quality evaluation (null if generation failed or skipped) */
  evaluation: EvaluationResult | import('./post-eval').PostEvalResult | null;
  /** Three-tier evaluation result (tier 0 + LLM tier 1+2 + visual) */
  tierEvaluation?: EvalResult;
  /** Calculated cost in USD */
  estimatedCostUsd: number;
  /** Error message if generation failed */
  error?: string;
  /** ISO timestamp */
  timestamp: string;
  /** Post-generation analysis (metadata extraction, data-free check) */
  postGeneration?: PostGenerationResult;
  /**
   * Which floor this run was executed under. Always set — `undefined`
   * on the variant resolves to {@link DEFAULT_BENCHMARK_FLOOR} at run
   * time, never propagates onto the result.
   */
  floor: BenchmarkFloor;
  /**
   * Path-usage observables — whether the hosted blueprint-tool path
   * was enabled + actually consulted by the agent. These are the
   * observables that make the floor dimension interpretable; the
   * floor summary aggregates them.
   */
  pathUsage: PathUsageMetrics;
  /**
   * Generator slug this run was executed under. Always set —
   * `undefined` on the variant resolves to {@link DEFAULT_GENERATOR_SLUG}
   * at run time, never propagates onto the result. Mirrors the
   * `floor` field's "default-on-resolve" pattern.
   */
  generator: string;
}

/**
 * Per-run observables for the floor dimension. Populated by the runner
 * from `generation.turnsUsed`. Hosted-vs-OSS observables are reserved
 * on this type — they stay absent until the corresponding divergence
 * lands. Keeping the shape now means later additions don't churn
 * `BenchmarkRunResult`.
 */
export interface PathUsageMetrics {
  /**
   * `true` when `generation.turnsUsed >= maxTurns` (the bench passes
   * 45 today). Aggregated per-floor as a regression signal — caps
   * are rarely the right answer for a healthy harness.
   */
  readonly capHit: boolean;
}

/**
 * Post-generation analysis results.
 * Lightweight checks that run without AWS services.
 */
export interface PostGenerationResult {
  /** Extracted metadata (category, description) from source code */
  metadata?: { category: string; description: string };
  /** Whether the component is data-free (no hardcoded request-specific data) */
  dataFreeCheck?: { isDataFree: boolean; violations: string[] };
  /** Whether the component emitted a stream spec for real-time data */
  hasStreamSpec: boolean;
  /** Whether the component emitted generator metadata markers */
  hasGeneratorMeta: boolean;
  /** Source code size in bytes */
  sourceCodeBytes?: number;
  /** Compiled code size in bytes */
  compiledCodeBytes: number;
  /**
   * Plugin-slice deterministic check: for every wrapper export
   * referenced in `commit.contract.clientCapabilities.gadgets`
   * AND registered in `commit.appGadgets`, did the generated
   * source actually use the export (call a hook / render a
   * component)? Cheap code-property test — doesn't need a real
   * browser, only flags the "LLM ignored the registered catalog"
   * failure mode. Absent when the commit has no plugin-slice
   * surface or `sourceCode` wasn't emitted.
   */
  gadgetUsage?: {
    /** Export names the contract declared. */
    declared: readonly string[];
    /** Subset of `declared` that the source code uses. */
    used: readonly string[];
    /** Subset of `declared` the source code never references. */
    missing: readonly string[];
  };
}

// =============================================================================
// Benchmark Report (full benchmark output)
// =============================================================================

export interface BenchmarkReport {
  meta: {
    timestamp: string;
    totalDurationMs: number;
    totalVariants: number;
    totalCommits: number;
    totalRuns: number;
    successCount: number;
    failureCount: number;
    successRate: number;
  };
  results: BenchmarkRunResult[];
  variantSummaries: VariantSummary[];
  commitSummaries: CommitSummary[];
  sdkComparison: SdkComparisonMatrix;
  /**
   * Per-floor side-by-side summaries. Present on every report — when
   * a run only exercised one floor, the array is length 1 (no blank
   * rows). Aggregations respect runs where generation succeeded; cap-
   * hit rate counts ALL runs including failures.
   */
  floorSummaries: FloorSummary[];
  /**
   * Per-generator breakdown. For each `(commit, sdk)` cell, the
   * report records every generator that ran the cell with its score
   * / time / cost so a reader can compare default vs advanced side-
   * by-side on identical inputs. Present on every report — single-
   * generator runs produce a one-entry breakdown.
   *
   * The map is keyed first by generator slug, then by `(commitId, sdkName)`
   * cell — `byGenerator[slug][commitId][sdkName]` = aggregate metrics.
   * Lookups that don't have a matching run return `undefined`.
   */
  byGenerator: GeneratorComparisonMatrix;
  /**
   * Per-generator aggregate. One entry per distinct generator slug
   * seen in `results`. Surfaces the cross-(commit, sdk) totals —
   * useful for ranking generators by quality / cost / latency
   * without diving into the full matrix.
   */
  generatorSummaries: GeneratorSummary[];
}

/**
 * Comparison matrix for the {@link BenchmarkReport.byGenerator} slice.
 *
 *   matrix[generatorSlug][commitId][sdkName] = GeneratorComparisonCell
 *
 * Same shape as {@link SdkComparisonMatrix} but with one extra
 * generator dimension on the outside. Empty sub-maps mean "no run for
 * that combination" — the reporter omits them rather than emitting
 * sentinel rows.
 */
export type GeneratorComparisonMatrix = Record<
  string,
  Record<string, Record<string, GeneratorComparisonCell>>
>;

/**
 * One cell of the multi-generator comparison matrix. Mirrors the
 * shape of {@link SdkComparisonMatrix} cells so reporters render
 * consistently. `avgScore === -1` is the "not-evaluated" sentinel,
 * matching the rest of the bench's convention.
 */
export interface GeneratorComparisonCell {
  readonly generator: string;
  readonly commitId: string;
  readonly sdkName: ProviderName;
  readonly runs: number;
  readonly avgScore: number;
  readonly avgTimeMs: number;
  readonly avgCostUsd: number;
  readonly successRate: number;
}

/**
 * Cross-(commit, sdk) aggregate for one generator slug. The summary
 * is computed over the same generation-succeeded subset that
 * {@link VariantSummary} uses.
 */
export interface GeneratorSummary {
  readonly generator: string;
  readonly runs: number;
  readonly avgScore: number;
  readonly avgTimeMs: number;
  readonly avgCostUsd: number;
  readonly successRate: number;
}

/**
 * Aggregate per-floor view across all variants + commits. The
 * interpretation handshake with the reader:
 *
 *   - `avgTimeMs` / `avgScore` / `successRate`: computed over the
 *     subset of runs that completed generation. These are the same
 *     definitions used by {@link VariantSummary}.
 *   - `capHitRate`: counts ALL runs (numerator = cap-hits, denominator
 *     = total runs including failures). A cap-hit that also timed out
 *     still counts as a cap-hit.
 *   - `errorBuckets`: sum of `breakdown.outcomes.*` across all runs
 *     on this floor. Same fields as the existing variant breakdown —
 *     per-floor aggregation lets a reader see if one floor drives
 *     more patch-invalid churn.
 */
export interface FloorSummary {
  readonly floor: BenchmarkFloor;
  readonly runs: number;
  readonly avgTimeMs: number;
  readonly avgScore: number;
  readonly successRate: number;
  readonly capHitRate: number;
  readonly errorBuckets: {
    readonly pass: number;
    readonly patchInvalid: number;
    readonly selfCheckFail: number;
    readonly diffFail: number;
  };
}

export interface VariantSummary {
  variantId: string;
  sdkName: ProviderName;
  tier: ModelTier;
  modelId: string;
  avgScore: number;
  avgTimeMs: number;
  avgCostUsd: number;
  successRate: number;
  dimensionAvgs: DimensionScores;
  /** Three-tier evaluation outcome counts */
  tierOutcomes?: {
    pass: number;   // runs with no fail issues
    warn: number;   // runs with warns but no fails
    fail: number;   // runs with any fail issues
  };
}

export interface CommitSummary {
  commitId: string;
  commitName: string;
  complexity: 'simple' | 'medium' | 'complex';
  avgScore: number;
  bestVariantId: string;
  worstVariantId: string;
  /** Three-tier evaluation outcome counts */
  tierOutcomes?: {
    pass: number;   // runs with no fail issues
    warn: number;   // runs with warns but no fails
    fail: number;   // runs with any fail issues
  };
}

export type SdkComparisonMatrix = Record<
  string,
  Record<string, { avgScore: number; avgTimeMs: number; avgCostUsd: number; successRate: number }>
>;

// =============================================================================
// Benchmark Configuration
// =============================================================================

export interface BenchmarkConfig {
  variants?: BenchmarkVariant[];
  commits?: BenchmarkCommit[];
  concurrency?: number;
  passThreshold?: number;
  maxAttempts?: number;
  maxEvalRounds?: number;
  skipEvaluation?: boolean;
  timeoutMs?: number;
  /** Quality mode: 'fast' (fix fails only), 'auto-improve' (fix warns too), 'high-quality' (max rounds) */
  qualityMode?: 'fast' | 'auto-improve' | 'high-quality';
  apiKeys?: Partial<Record<LlmProvider, string>>;
  claudeUseBedrock?: boolean;
  /** Progress callback for streaming updates to the viewer */
  onProgress?: (event: { completed: number; total: number; message?: string }) => void;
  /** Visual evaluation config (screenshot + multimodal LLM scoring) */
  visualEvaluation?: {
    enabled: boolean;
    provider?: "claude" | "google";
    model?: string;
    passThreshold?: number;
    viewport?: { width: number; height: number };
  };
}

/**
 * Runner configuration for the new storage-aware BenchmarkRunner.
 * Superset of BenchmarkConfig — adds storage backend and typed API keys.
 */
export interface BenchmarkRunnerConfig {
  /** Storage backend for saving reports */
  storage?: BenchmarkStorage;
  /** Progress callback */
  onProgress?: (event: { completed: number; total: number; message?: string }) => void;
  /** Concurrency limit (default: 36) */
  concurrency?: number;
  /** Per-task timeout in ms (default: 600_000) */
  timeoutMs?: number;
  /** Pass threshold 0-100 (default: 70) */
  passThreshold?: number;
  /** Max coding attempts (default: 15) */
  maxAttempts?: number;
  /** Max evaluation rounds (default: 3) */
  maxEvalRounds?: number;
  /** Skip evaluation */
  skipEvaluation?: boolean;
  /** Quality mode */
  qualityMode?: 'fast' | 'auto-improve' | 'high-quality';
  /** API keys per provider */
  apiKeys?: Partial<Record<string, string>>;
  /** Use Bedrock for Claude */
  claudeUseBedrock?: boolean;
  /** Visual evaluation config */
  visualEvaluation?: {
    enabled: boolean;
    provider?: 'claude' | 'google';
    model?: string;
    passThreshold?: number;
    viewport?: { width: number; height: number };
  };
}
