/**
 * Rerank quality probe.
 *
 * Runs the configured `LLMCaller` over the {@link EVAL_PAIRS} eval
 * set and returns precision@1 + adversarial false-positive +
 * latency p95. The caller compares these against the quality gates
 * (precision, adversarial false-positive rate, latency, cost)
 * reported by the probe CLI.
 *
 * Eval-only — not exported from the package index.
 */
import { rerankCandidates, type RerankDecision } from '../llm-rerank.js';
import type { LLMCaller } from '../llm-caller.js';
import { EVAL_PAIRS, type EvalPair } from './pairs.js';

export interface ProbeOutcome {
  readonly pair: EvalPair;
  readonly decision: RerankDecision;
  /** Confidence threshold applied to compute correctness. */
  readonly threshold: number;
  /** Predicted matchId AFTER threshold gate (null if confidence below). */
  readonly predictedMatchId: string | null;
  /** Was the prediction correct vs gold? */
  readonly correct: boolean;
}

export interface ProbeReport {
  readonly outcomes: readonly ProbeOutcome[];
  readonly totals: {
    readonly all: number;
    readonly correct: number;
    readonly precision: number;
  };
  readonly byKind: Readonly<{
    [K in EvalPair['kind']]: {
      readonly all: number;
      readonly correct: number;
      readonly precision: number;
    };
  }>;
  readonly adversarialFalsePositiveRate: number;
  readonly latency: { readonly p50Ms: number; readonly p95Ms: number };
  readonly threshold: number;
}

export interface RunProbeOptions {
  /** Use a subset for smoke; default = all 25 pairs. */
  readonly limit?: number;
  /** Confidence threshold for considering a non-null match a hit. Default 0.6. */
  readonly threshold?: number;
  /**
   * Optional progress callback. Fired AFTER each pair completes — the
   * CLI uses this to print a per-pair line so the operator sees live
   * progress instead of waiting for the full sweep to finish.
   */
  readonly onProgress?: (outcome: ProbeOutcome, index: number, total: number) => void;
}

/**
 * Run the probe against `pairs` (defaults to {@link EVAL_PAIRS}).
 * Sequential by design — small N (~25), and concurrent calls would
 * complicate latency measurement without changing the gate decision.
 */
export async function runProbe(
  deps: { readonly llm: LLMCaller },
  options: RunProbeOptions = {},
  pairs: readonly EvalPair[] = EVAL_PAIRS,
): Promise<ProbeReport> {
  const threshold = options.threshold ?? 0.6;
  const subset = options.limit ? pairs.slice(0, options.limit) : pairs;
  const outcomes: ProbeOutcome[] = [];

  for (let i = 0; i < subset.length; i++) {
    const pair = subset[i]!;
    const decision = await rerankCandidates(deps, pair.query, pair.candidates);
    const predictedMatchId =
      decision.confidence >= threshold ? decision.matchId : null;
    const correct = predictedMatchId === pair.goldMatchId;
    const outcome: ProbeOutcome = {
      pair,
      decision,
      threshold,
      predictedMatchId,
      correct,
    };
    outcomes.push(outcome);
    options.onProgress?.(outcome, i, subset.length);
  }

  const totals = aggregate(outcomes);
  const byKind = {
    'should-match': aggregate(outcomes.filter((o) => o.pair.kind === 'should-match')),
    'no-match': aggregate(outcomes.filter((o) => o.pair.kind === 'no-match')),
    adversarial: aggregate(outcomes.filter((o) => o.pair.kind === 'adversarial')),
  };
  // Adversarial false-positive: judge accepted a candidate when gold
  // says null. Compute as `(adversarial-pairs-with-prediction-when-
  // gold-was-null) / (adversarial-pairs-with-gold-null)`.
  const adversarial = outcomes.filter((o) => o.pair.kind === 'adversarial');
  const adversarialNullGold = adversarial.filter((o) => o.pair.goldMatchId === null);
  const adversarialFalsePositives = adversarialNullGold.filter(
    (o) => o.predictedMatchId !== null,
  );
  const adversarialFalsePositiveRate =
    adversarialNullGold.length === 0
      ? 0
      : adversarialFalsePositives.length / adversarialNullGold.length;

  const latencies = outcomes
    .map((o) => o.decision.latencyMs)
    .sort((a, b) => a - b);
  const latency = {
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
  };

  return {
    outcomes,
    totals,
    byKind,
    adversarialFalsePositiveRate,
    latency,
    threshold,
  };
}

function aggregate(outcomes: readonly ProbeOutcome[]): {
  readonly all: number;
  readonly correct: number;
  readonly precision: number;
} {
  const all = outcomes.length;
  const correct = outcomes.filter((o) => o.correct).length;
  const precision = all === 0 ? 0 : correct / all;
  return { all, correct, precision };
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.floor(p * sorted.length),
  );
  return sorted[idx] ?? 0;
}

/** Pretty-print a {@link ProbeReport} for terminal output. */
export function formatReport(report: ProbeReport): string {
  const lines: string[] = [];
  lines.push('━━━ rerank quality probe ━━━');
  lines.push('');
  lines.push(`Threshold: confidence ≥ ${report.threshold}`);
  lines.push('');
  lines.push('Precision by kind:');
  for (const [kind, stats] of Object.entries(report.byKind) as Array<[
    EvalPair['kind'],
    { all: number; correct: number; precision: number },
  ]>) {
    const pct = (stats.precision * 100).toFixed(1);
    lines.push(`  ${kind.padEnd(14)} ${stats.correct}/${stats.all} (${pct}%)`);
  }
  lines.push('');
  lines.push(
    `Overall:        ${report.totals.correct}/${report.totals.all} (${(report.totals.precision * 100).toFixed(1)}%)`,
  );
  lines.push(
    `Adversarial FP: ${(report.adversarialFalsePositiveRate * 100).toFixed(1)}%`,
  );
  lines.push(
    `Latency:        p50=${report.latency.p50Ms}ms · p95=${report.latency.p95Ms}ms`,
  );
  lines.push('');
  lines.push('Gates:');
  lines.push(
    `  G1 precision@1 ≥ 85%    →  ${report.totals.precision >= 0.85 ? 'PASS' : 'FAIL'} (${(report.totals.precision * 100).toFixed(1)}%)`,
  );
  lines.push(
    `  G2 adversarial FP ≤ 5%  →  ${report.adversarialFalsePositiveRate <= 0.05 ? 'PASS' : 'FAIL'} (${(report.adversarialFalsePositiveRate * 100).toFixed(1)}%)`,
  );
  lines.push(
    `  G3 latency p95 ≤ 600ms  →  ${report.latency.p95Ms <= 600 ? 'PASS' : 'FAIL'} (p95=${report.latency.p95Ms}ms)`,
  );

  // Per-pair detail for failed predictions
  const failed = report.outcomes.filter((o) => !o.correct);
  if (failed.length > 0) {
    lines.push('');
    lines.push('Failed predictions:');
    for (const o of failed) {
      lines.push(
        `  [${o.pair.kind}] ${o.pair.id}: predicted=${o.predictedMatchId ?? 'null'}, gold=${o.pair.goldMatchId ?? 'null'}, conf=${o.decision.confidence.toFixed(2)}`,
      );
      lines.push(`    reason: ${o.decision.reason}`);
    }
  }

  return lines.join('\n');
}
