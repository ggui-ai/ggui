// oss/misc/benchmark/src/multi-sdk/reporter.ts

import type {
  BenchmarkReportDisplay,
  BenchmarkRunResultDisplay,
  CommitSummaryDisplay,
  GenerationResultDisplay,
  EvaluationResultDisplay,
  TierEvaluationDisplay,
  PostGenerationDisplay,
  VariantSummaryDisplay,
  SdkComparisonEntry,
} from '@ggui-ai/shared';
import type {
  AestheticScores,
  BenchmarkReport,
  BenchmarkRunResult,
  CommitSummary,
  GeneratorComparisonCell,
  GeneratorComparisonMatrix,
  GeneratorSummary,
  JudgeDisclosure,
  ProviderName,
  SdkComparisonMatrix,
  VariantSummary,
} from './types';
import {
  DEFAULT_GENERATOR_SLUG,
  PROVIDER_DISPLAY_NAMES,
} from './types';

/**
 * Generate a full benchmark report from individual run results.
 */
export function generateReport(
  results: BenchmarkRunResult[],
  totalDurationMs: number
): BenchmarkReport {
  const successResults = results.filter((r) => r.generation !== null);

  // Judge disclosure: every PostEvalResult carries the pinned judge.
  // Surface it once at meta level; absent when nothing was evaluated.
  const judge: JudgeDisclosure | undefined = results.find(
    (r) => r.evaluation !== null,
  )?.evaluation?.judge;

  return {
    meta: {
      timestamp: new Date().toISOString(),
      totalDurationMs,
      totalVariants: new Set(results.map((r) => r.variant.id)).size,
      totalCommits: new Set(results.map((r) => r.commit.id)).size,
      totalRuns: results.length,
      successCount: successResults.length,
      failureCount: results.length - successResults.length,
      successRate: results.length > 0 ? successResults.length / results.length : 0,
      ...(judge !== undefined ? { judge } : {}),
    },
    results,
    variantSummaries: buildVariantSummaries(results),
    commitSummaries: buildCommitSummaries(results),
    sdkComparison: buildSdkComparison(results),
    byGenerator: buildGeneratorComparisonMatrix(results),
    generatorSummaries: buildGeneratorSummaries(results),
  };
}

/**
 * Build the multi-generator comparison matrix. The matrix is shaped
 * `matrix[generatorSlug][commitId][sdkName] = cell`. Cells aggregate
 * the runs that produced a generation result; failures count in
 * `runs` but contribute `0` to `avgTimeMs`/`avgCostUsd` and `-1` to
 * `avgScore` (the bench's "not evaluated" sentinel).
 *
 * Runs with a missing/empty `generator` field on the result are
 * bucketed under {@link DEFAULT_GENERATOR_SLUG} so reports stay
 * comparable across older and newer fixture corpora.
 */
export function buildGeneratorComparisonMatrix(
  results: BenchmarkRunResult[],
): GeneratorComparisonMatrix {
  // Bucket: generator → commitId → sdkName → runs
  type CellRuns = BenchmarkRunResult[];
  const buckets = new Map<string, Map<string, Map<string, CellRuns>>>();
  for (const r of results) {
    const slug = (r.generator?.trim() ?? '') || DEFAULT_GENERATOR_SLUG;
    let byCommit = buckets.get(slug);
    if (!byCommit) {
      byCommit = new Map();
      buckets.set(slug, byCommit);
    }
    let bySdk = byCommit.get(r.commit.id);
    if (!bySdk) {
      bySdk = new Map();
      byCommit.set(r.commit.id, bySdk);
    }
    const runs = bySdk.get(r.variant.sdkName) ?? [];
    runs.push(r);
    bySdk.set(r.variant.sdkName, runs);
  }

  const matrix: GeneratorComparisonMatrix = {};
  for (const [slug, byCommit] of buckets) {
    matrix[slug] = {};
    for (const [commitId, bySdk] of byCommit) {
      matrix[slug][commitId] = {};
      for (const [sdk, runs] of bySdk) {
        matrix[slug][commitId][sdk] = aggregateGeneratorCell({
          generator: slug,
          commitId,
          sdkName: sdk as ProviderName,
          runs,
        });
      }
    }
  }
  return matrix;
}

function aggregateGeneratorCell(input: {
  generator: string;
  commitId: string;
  sdkName: ProviderName;
  runs: BenchmarkRunResult[];
}): GeneratorComparisonCell {
  const { generator, commitId, sdkName, runs } = input;
  const generated = runs.filter((r) => r.generation !== null);
  const evaluated = runs.filter((r) => r.evaluation !== null);
  const scores = evaluated
    .map((r) => r.evaluation!.score)
    .filter((s): s is number => typeof s === 'number');
  return {
    generator,
    commitId,
    sdkName,
    runs: runs.length,
    avgScore: scores.length > 0 ? avg(scores) : -1,
    avgTimeMs: generated.length > 0
      ? avg(generated.map((r) => r.generation!.generationTimeMs))
      : 0,
    avgCostUsd: generated.length > 0
      ? avg(generated.map((r) => r.estimatedCostUsd))
      : 0,
    successRate: runs.length > 0 ? generated.length / runs.length : 0,
  };
}

/**
 * Build per-generator cross-(commit, sdk) summaries, keyed by
 * generator slug. One entry per distinct slug; deterministic order
 * with the default seed first when present so side-by-side reads
 * "default → advanced."
 */
export function buildGeneratorSummaries(
  results: BenchmarkRunResult[],
): GeneratorSummary[] {
  const byGenerator = new Map<string, BenchmarkRunResult[]>();
  for (const r of results) {
    const slug = (r.generator?.trim() ?? '') || DEFAULT_GENERATOR_SLUG;
    const bucket = byGenerator.get(slug) ?? [];
    bucket.push(r);
    byGenerator.set(slug, bucket);
  }
  const summaries: GeneratorSummary[] = [];
  for (const [generator, runs] of byGenerator) {
    const generated = runs.filter((r) => r.generation !== null);
    const evaluated = runs.filter((r) => r.evaluation !== null);
    const scores = evaluated
      .map((r) => r.evaluation!.score)
      .filter((s): s is number => typeof s === 'number');
    summaries.push({
      generator,
      runs: runs.length,
      avgTimeMs: generated.length > 0
        ? avg(generated.map((r) => r.generation!.generationTimeMs))
        : 0,
      avgScore: scores.length > 0 ? avg(scores) : -1,
      avgCostUsd: generated.length > 0
        ? avg(generated.map((r) => r.estimatedCostUsd))
        : 0,
      successRate: runs.length > 0 ? generated.length / runs.length : 0,
    });
  }
  // Deterministic order: default slug first, then alphabetical so the
  // side-by-side rendering matches the operator's mental model.
  summaries.sort((a, b) => {
    if (a.generator === DEFAULT_GENERATOR_SLUG) return -1;
    if (b.generator === DEFAULT_GENERATOR_SLUG) return 1;
    return a.generator.localeCompare(b.generator);
  });
  return summaries;
}

/**
 * Build per-variant summaries averaged across prompts.
 */
function buildVariantSummaries(results: BenchmarkRunResult[]): VariantSummary[] {
  const byVariant = groupBy(results, (r) => r.variant.id);
  const summaries: VariantSummary[] = [];

  for (const [variantId, runs] of Object.entries(byVariant)) {
    const variant = runs[0].variant;
    // Generation success = produced compiled code (evaluation may be skipped)
    const generated = runs.filter((r) => r.generation !== null);
    const evaluated = runs.filter((r) => r.evaluation !== null);

    // Count three-tier evaluation outcomes
    const tierOutcomes = computeTierOutcomes(runs);

    if (generated.length === 0) {
      summaries.push({
        variantId,
        sdkName: variant.sdkName,
        tier: variant.tier,
        modelId: variant.modelId ?? `${variant.sdkName}/${variant.tier}`,
        avgScore: -1, // -1 = not evaluated (outage); never publish 0 as a real score
        avgTimeMs: 0,
        avgCostUsd: 0,
        successRate: 0,
        dimensionAvgs: zeroDimensions(),
        tierOutcomes,
      });
      continue;
    }

    const scores = evaluated.map((r) => r.evaluation!.score);
    const times = generated.map((r) => r.generation!.generationTimeMs);
    const costs = generated.map((r) => r.estimatedCostUsd);

    summaries.push({
      variantId,
      sdkName: variant.sdkName,
      tier: variant.tier,
      modelId: variant.modelId ?? `${variant.sdkName}/${variant.tier}`,
      avgScore: scores.length > 0 ? avg(scores) : -1, // -1 = not evaluated
      avgTimeMs: avg(times),
      avgCostUsd: avg(costs),
      successRate: generated.length / runs.length,
      dimensionAvgs:
        evaluated.length > 0
          ? avgDimensions(evaluated.map((r) => r.evaluation!.dimensions))
          : zeroDimensions(),
      tierOutcomes,
    });
  }

  return summaries.sort((a, b) => b.avgScore - a.avgScore);
}

/**
 * Build per-commit summaries averaged across variants.
 */
function buildCommitSummaries(results: BenchmarkRunResult[]): CommitSummary[] {
  const byCommit = groupBy(results, (r) => r.commit.id);
  const summaries: CommitSummary[] = [];

  for (const [commitId, runs] of Object.entries(byCommit)) {
    const commit = runs[0].commit;
    const generated = runs.filter((r) => r.generation !== null);
    const evaluated = runs.filter((r) => r.evaluation !== null);

    // Count three-tier evaluation outcomes
    const tierOutcomes = computeTierOutcomes(runs);

    if (generated.length === 0) {
      summaries.push({
        commitId,
        commitName: commit.name,
        complexity: commit.complexity,
        avgScore: -1, // -1 = not evaluated (outage); never publish 0 as a real score
        bestVariantId: 'none',
        worstVariantId: 'none',
        tierOutcomes,
      });
      continue;
    }

    // Rank by score if evaluated, otherwise by generation time (faster = better)
    const scored = evaluated.length > 0
      ? evaluated.map((r) => ({ variantId: r.variant.id, score: r.evaluation!.score }))
      : generated.map((r) => ({ variantId: r.variant.id, score: -1 }));
    scored.sort((a, b) => b.score - a.score);

    summaries.push({
      commitId,
      commitName: commit.name,
      complexity: commit.complexity,
      avgScore: evaluated.length > 0 ? avg(scored.map((s) => s.score)) : -1,
      bestVariantId: scored[0].variantId,
      worstVariantId: scored[scored.length - 1].variantId,
      tierOutcomes,
    });
  }

  return summaries;
}

/**
 * Build the SDK × tier comparison matrix.
 */
function buildSdkComparison(results: BenchmarkRunResult[]): SdkComparisonMatrix {
  const matrix: SdkComparisonMatrix = {};

  for (const result of results) {
    const sdk = result.variant.sdkName;
    const tier = result.variant.tier;

    if (!matrix[sdk]) matrix[sdk] = {};
    if (!matrix[sdk][tier]) {
      matrix[sdk][tier] = { avgScore: 0, avgTimeMs: 0, avgCostUsd: 0, successRate: 0 };
    }
  }

  // Fill with actual averages
  for (const sdk of Object.keys(matrix)) {
    for (const tier of Object.keys(matrix[sdk])) {
      const runs = results.filter(
        (r) => r.variant.sdkName === sdk && r.variant.tier === tier
      );
      const generated = runs.filter((r) => r.generation !== null);
      const evaluated = runs.filter((r) => r.evaluation !== null);

      matrix[sdk][tier] = {
        avgScore: evaluated.length > 0
          ? avg(evaluated.map((r) => r.evaluation!.score))
          : -1,
        avgTimeMs: generated.length > 0
          ? avg(generated.map((r) => r.generation!.generationTimeMs))
          : 0,
        avgCostUsd: generated.length > 0
          ? avg(generated.map((r) => r.estimatedCostUsd))
          : 0,
        successRate: runs.length > 0 ? generated.length / runs.length : 0,
      };
    }
  }

  return matrix;
}

/**
 * Render a benchmark report as a markdown string.
 */
export function renderReportMarkdown(report: BenchmarkReport): string {
  const lines: string[] = [];

  lines.push('# Multi-SDK Benchmark Report');
  lines.push('');
  lines.push(`**Date:** ${report.meta.timestamp}`);
  lines.push(`**Duration:** ${(report.meta.totalDurationMs / 1000).toFixed(1)}s`);
  lines.push(
    `**Runs:** ${report.meta.totalRuns} (${report.meta.successCount} success, ${report.meta.failureCount} failed)`
  );
  lines.push(
    `**Success Rate:** ${(report.meta.successRate * 100).toFixed(1)}%`
  );
  lines.push('');

  // SDK Comparison Matrix
  lines.push('## SDK Comparison');
  lines.push('');
  lines.push('| SDK | Tier | Avg Score | Avg Time | Avg Cost | Success |');
  lines.push('|-----|------|-----------|----------|----------|---------|');

  for (const [sdk, tiers] of Object.entries(report.sdkComparison)) {
    for (const [tier, metrics] of Object.entries(tiers)) {
      const displayName = PROVIDER_DISPLAY_NAMES[sdk as ProviderName] ?? sdk;
      const scoreStr = metrics.avgScore < 0 ? 'n/a' : metrics.avgScore.toFixed(1);
      lines.push(
        `| ${displayName} | ${tier} | ${scoreStr} | ${formatMs(metrics.avgTimeMs)} | $${metrics.avgCostUsd.toFixed(4)} | ${(metrics.successRate * 100).toFixed(0)}% |`
      );
    }
  }
  lines.push('');

  // Multi-Generator Comparison.
  // Render only when more than one generator is represented in the
  // run — single-generator reports stay backward-compatible.
  if (report.generatorSummaries.length > 1) {
    lines.push('## Multi-generator Comparison');
    lines.push('');
    lines.push('| Generator | Runs | Avg Score | Avg Time | Avg Cost | Success |');
    lines.push('|-----------|------|-----------|----------|----------|---------|');
    for (const g of report.generatorSummaries) {
      const scoreStr = g.avgScore < 0 ? 'n/a' : g.avgScore.toFixed(1);
      lines.push(
        `| \`${g.generator}\` | ${g.runs} | ${scoreStr} | ${formatMs(g.avgTimeMs)} | $${g.avgCostUsd.toFixed(4)} | ${(g.successRate * 100).toFixed(0)}% |`,
      );
    }
    lines.push('');
    // Per-(commit, sdk) cell matrix — only render cells with >1 generator
    // so single-generator commits don't clutter the report.
    const cells: GeneratorComparisonCell[] = [];
    for (const slug of Object.keys(report.byGenerator)) {
      const byCommit = report.byGenerator[slug];
      for (const commitId of Object.keys(byCommit)) {
        const bySdk = byCommit[commitId];
        for (const sdk of Object.keys(bySdk)) {
          cells.push(bySdk[sdk]);
        }
      }
    }
    if (cells.length > 0) {
      lines.push('### Per (commit × SDK) cells');
      lines.push('');
      lines.push('| Generator | Commit | SDK | Runs | Avg Score | Avg Time | Avg Cost |');
      lines.push('|-----------|--------|-----|------|-----------|----------|----------|');
      cells.sort((a, b) => {
        const c = a.commitId.localeCompare(b.commitId);
        if (c !== 0) return c;
        const s = a.sdkName.localeCompare(b.sdkName);
        if (s !== 0) return s;
        return a.generator.localeCompare(b.generator);
      });
      for (const cell of cells) {
        const scoreStr = cell.avgScore < 0 ? 'n/a' : cell.avgScore.toFixed(1);
        lines.push(
          `| \`${cell.generator}\` | ${cell.commitId} | ${cell.sdkName} | ${cell.runs} | ${scoreStr} | ${formatMs(cell.avgTimeMs)} | $${cell.avgCostUsd.toFixed(4)} |`,
        );
      }
      lines.push('');
    }
  }

  // Variant Rankings
  lines.push('## Variant Rankings (by avg score)');
  lines.push('');
  lines.push('| Rank | Variant | Score | Time | Cost | Success | Tier Eval |');
  lines.push('|------|---------|-------|------|------|---------|-----------|');

  report.variantSummaries.forEach((v, i) => {
    const scoreStr = v.avgScore < 0 ? 'n/a' : v.avgScore.toFixed(1);
    const tierStr = v.tierOutcomes
      ? `${v.tierOutcomes.pass}P/${v.tierOutcomes.warn}W/${v.tierOutcomes.fail}F`
      : 'n/a';
    lines.push(
      `| ${i + 1} | ${v.variantId} | ${scoreStr} | ${formatMs(v.avgTimeMs)} | $${v.avgCostUsd.toFixed(4)} | ${(v.successRate * 100).toFixed(0)}% | ${tierStr} |`
    );
  });
  lines.push('');

  // Per-Commit Results
  lines.push('## Per-Commit Results');
  lines.push('');

  for (const ps of report.commitSummaries) {
    lines.push(`### ${ps.commitName} (${ps.complexity})`);
    lines.push('');
    lines.push(`- **Avg Score:** ${ps.avgScore.toFixed(1)}`);
    lines.push(`- **Best:** ${ps.bestVariantId}`);
    lines.push(`- **Worst:** ${ps.worstVariantId}`);
    if (ps.tierOutcomes) {
      lines.push(`- **Tier Eval:** ${ps.tierOutcomes.pass} pass, ${ps.tierOutcomes.warn} warn, ${ps.tierOutcomes.fail} fail`);
    }
    lines.push('');
  }

  // Failures
  const failures = report.results.filter((r) => r.error);
  if (failures.length > 0) {
    lines.push('## Failures');
    lines.push('');
    for (const f of failures) {
      lines.push(`- **${f.variant.id}** × ${f.commit.id}: ${f.error}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Count three-tier evaluation outcomes across a set of benchmark runs.
 * Returns undefined if no runs have tier evaluations.
 */
function computeTierOutcomes(
  runs: BenchmarkRunResult[]
): { pass: number; warn: number; fail: number } | undefined {
  const tierOutcomes = { pass: 0, warn: 0, fail: 0 };
  let hasTierEval = false;
  for (const run of runs) {
    if (!run.tierEvaluation) continue;
    hasTierEval = true;
    const hasFailure = run.tierEvaluation.issues.some((i) => i.result === 'fail');
    const hasWarning = run.tierEvaluation.issues.some((i) => i.result === 'warn');
    if (hasFailure) tierOutcomes.fail++;
    else if (hasWarning) tierOutcomes.warn++;
    else tierOutcomes.pass++;
  }
  return hasTierEval ? tierOutcomes : undefined;
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function zeroDimensions(): AestheticScores {
  return {
    layout: 0,
    designTokens: 0,
    hierarchy: 0,
    polish: 0,
    dataPresentation: 0,
  };
}

function avgDimensions(dims: AestheticScores[]): AestheticScores {
  if (dims.length === 0) return zeroDimensions();
  return {
    layout: avg(dims.map((d) => d.layout)),
    designTokens: avg(dims.map((d) => d.designTokens)),
    hierarchy: avg(dims.map((d) => d.hierarchy)),
    polish: avg(dims.map((d) => d.polish)),
    dataPresentation: avg(dims.map((d) => d.dataPresentation)),
  };
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of items) {
    const key = keyFn(item);
    if (!result[key]) result[key] = [];
    result[key].push(item);
  }
  return result;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

// =============================================================================
// Runner → Display mapping
// =============================================================================

/**
 * Map a runner-internal BenchmarkReport to a serialization-safe BenchmarkReportDisplay.
 * This strips non-serializable fields (compiled code, zod schemas, handlers)
 * and renames fields to match the display contract.
 */
export function toDisplayReport(
  report: BenchmarkReport,
  reportId: string,
  version: string,
): BenchmarkReportDisplay {
  return {
    meta: {
      reportId,
      timestamp: report.meta.timestamp,
      version,
      totalVariants: report.meta.totalVariants,
      totalCommits: report.meta.totalCommits,
      totalRuns: report.meta.totalRuns,
      successCount: report.meta.successCount,
      failureCount: report.meta.failureCount,
      successRate: report.meta.successRate,
      durationMs: report.meta.totalDurationMs,
      ...(report.meta.judge !== undefined ? { judge: report.meta.judge } : {}),
    },
    results: report.results.map(mapRunResult),
    variantSummaries: report.variantSummaries.map((v) =>
      mapVariantSummary(v, report.results),
    ),
    commitSummaries: report.commitSummaries.map(mapCommitSummary),
    sdkComparison: mapSdkComparison(report.sdkComparison),
    // Propagate the per-generator breakdown as-is. Internal and
    // display shapes match by construction (see types.ts vs
    // `GeneratorComparisonCellDisplay` / `GeneratorSummaryDisplay`).
    byGenerator: report.byGenerator,
    generatorSummaries: report.generatorSummaries,
  };
}

function mapRunResult(r: BenchmarkRunResult): BenchmarkRunResultDisplay {
  return {
    variant: {
      id: r.variant.id,
      sdkName: r.variant.sdkName,
      tier: r.variant.tier,
      modelId: r.variant.modelId,
    },
    commit: {
      id: r.commit.id,
      name: r.commit.name,
      complexity: r.commit.complexity,
    },
    generation: mapGeneration(r),
    evaluation: mapEvaluation(r),
    tierEvaluation: mapTierEvaluation(r),
    estimatedCostUsd: r.estimatedCostUsd,
    error: r.error,
    timestamp: r.timestamp,
    postGeneration: mapPostGeneration(r),
  };
}

function mapGeneration(r: BenchmarkRunResult): GenerationResultDisplay | null {
  if (!r.generation) return null;
  const gen = r.generation;
  const result: GenerationResultDisplay = {
    generationTimeMs: gen.generationTimeMs,
    turnsUsed: gen.turnsUsed,
    tokens: { input: gen.tokens.input, output: gen.tokens.output, total: gen.tokens.total },
  };
  // GenerationResult extends AdapterResult with passesUsed.
  if ('passesUsed' in gen && typeof gen.passesUsed === 'number') {
    result.passesUsed = gen.passesUsed;
  }
  return result;
}

function mapEvaluation(r: BenchmarkRunResult): EvaluationResultDisplay | null {
  if (!r.evaluation) return null;
  const ev = r.evaluation;
  return {
    passed: ev.passed,
    score: ev.score,
    dimensions: { ...ev.dimensions },
    judge: { ...ev.judge },
    critique: ev.critique,
    evalTimeMs: ev.evalTimeMs,
  };
}

function mapTierEvaluation(r: BenchmarkRunResult): TierEvaluationDisplay | undefined {
  if (!r.tierEvaluation) return undefined;
  return {
    issues: r.tierEvaluation.issues.map((i) => ({
      tier: i.tier,
      result: i.result,
      category: i.category,
      description: i.description,
    })),
    pass: [...r.tierEvaluation.pass],
  };
}

function mapPostGeneration(r: BenchmarkRunResult): PostGenerationDisplay | undefined {
  if (!r.postGeneration) return undefined;
  const pg = r.postGeneration;
  return {
    hasStreamSpec: pg.hasStreamSpec,
    hasGeneratorMeta: pg.hasGeneratorMeta,
    compiledCodeBytes: pg.compiledCodeBytes,
    sourceCodeBytes: pg.sourceCodeBytes,
    dataFreeCheck: pg.dataFreeCheck,
    // `gadgetUsage` is computed at runtime (see
    // `runner.ts:checkGadgetUsage`); forward it verbatim so the
    // serialized report carries the same `⚠missingHooks(...)` signal
    // that appears in the bench logs.
    gadgetUsage: pg.gadgetUsage,
  };
}

function mapVariantSummary(
  v: VariantSummary,
  results: BenchmarkRunResult[],
): VariantSummaryDisplay {
  const totalRuns = results.filter((r) => r.variant.id === v.variantId).length;
  return {
    variantId: v.variantId,
    sdkName: v.sdkName,
    tier: v.tier,
    modelId: v.modelId,
    avgScore: v.avgScore,
    avgTimeMs: v.avgTimeMs,
    avgCostUsd: v.avgCostUsd,
    successRate: v.successRate,
    totalRuns,
  };
}

function mapCommitSummary(c: CommitSummary): CommitSummaryDisplay {
  return {
    commitId: c.commitId,
    name: c.commitName,
    complexity: c.complexity,
    bestVariantId: c.bestVariantId,
    worstVariantId: c.worstVariantId,
    avgScore: c.avgScore,
  };
}

function mapSdkComparison(
  matrix: SdkComparisonMatrix,
): Record<string, Record<string, SdkComparisonEntry>> {
  const result: Record<string, Record<string, SdkComparisonEntry>> = {};
  for (const [sdk, tiers] of Object.entries(matrix)) {
    result[sdk] = {};
    for (const [tier, metrics] of Object.entries(tiers)) {
      result[sdk][tier] = {
        avgScore: metrics.avgScore,
        avgTimeMs: metrics.avgTimeMs,
        avgCostUsd: metrics.avgCostUsd,
        successRate: metrics.successRate,
      };
    }
  }
  return result;
}
