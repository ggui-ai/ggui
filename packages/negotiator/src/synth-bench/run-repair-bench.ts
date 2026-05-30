/**
 * Repair-path bench runner — the round-trip QUALITY probe.
 *
 * Where {@link evaluateAgainstCorpus} runs synthesize-from-intent and
 * scores SHAPE, this runs the production forgiving-handshake create-path
 * — `ensureConformingContract(draft, intent)` — over {@link
 * REPAIR_CORPUS} and scores whether the produced contract is round-trip
 * USABLE, not merely valid.
 *
 * Per entry it records:
 *   - `origin` — `agent` (draft was clean, returned verbatim via the
 *     fast path) vs `synth` (repaired in-place). The repair discriminator.
 *   - `shape` — {@link scoreSynthesizedContract} ride-along (which specs).
 *   - `roundTrip` — {@link scoreContractRoundTrip}: the headline signal.
 *     A reshape that breaks the agent's seed round-trip fails here even
 *     though `lintContract` passes the contract.
 *
 * The bench's pass verdict is the ROUND-TRIP score when an entry carries
 * a round-trip expectation, falling back to shape otherwise. So the
 * top-line precision answers "how often does the negotiator produce a
 * round-trip-usable contract from an agent draft?" — the contract-
 * quality number the shape bench cannot see.
 *
 * Live LLM probe — opt-in CLI (run-repair-bench-cli.ts), NOT in CI. The
 * deterministic scorer pinning lives in round-trip-score.test.ts.
 */

import type { DataContract, SuggestionFinding } from '@ggui-ai/protocol';
import { ensureConformingContract } from '../ensure-conforming-contract.js';
import type { LLMCaller } from '../llm-caller.js';
import { scoreSynthesizedContract, type ScoreResult } from './run-bench.js';
import {
  scoreContractRoundTrip,
  type RoundTripScore,
} from './round-trip-score.js';
import { REPAIR_CORPUS, type BenchEntry } from './corpus.js';

export interface RepairBenchOutcome {
  readonly entry: BenchEntry;
  /** ensureConformingContract always returns a contract (possibly `{}`). */
  readonly contract: DataContract;
  /** `agent` = clean draft returned verbatim; `synth` = repaired in-place. */
  readonly origin: 'agent' | 'synth';
  /** How the contract was produced (the efficiency tier): verbatim /
   *  normalized (deterministic, no LLM) / llm-repair / fallback-empty. */
  readonly method: 'verbatim' | 'normalized' | 'llm-repair' | 'fallback-empty';
  /** Structural shape score (ride-along secondary signal). */
  readonly shape: ScoreResult;
  /** Round-trip usability — null when the entry declares no round-trip
   *  expectation (then `shape` carries the verdict). */
  readonly roundTrip: RoundTripScore | null;
  /** The error/warn findings the negotiator surfaced back to the agent. */
  readonly findings: readonly SuggestionFinding[];
  readonly reasoning: string;
  readonly latencyMs: number;
}

/**
 * An outcome passes on its ROUND-TRIP score when one exists (the sharper
 * gate), else on its shape score. Round-trip is the point of this bench.
 */
export function repairOutcomePass(outcome: RepairBenchOutcome): boolean {
  return outcome.roundTrip !== null
    ? outcome.roundTrip.pass
    : outcome.shape.pass;
}

export interface RepairBenchReport {
  readonly outcomes: readonly RepairBenchOutcome[];
  readonly totals: {
    readonly all: number;
    readonly pass: number;
    readonly fail: number;
    /** Drafts returned verbatim by the lint-clean fast path. */
    readonly originAgent: number;
    /** Drafts repaired in-place by the synth loop. */
    readonly originSynth: number;
    /** Entries carrying a round-trip expectation. */
    readonly roundTripScored: number;
    /** Of those, how many round-trip cleanly. */
    readonly roundTripPass: number;
    /** roundTripPass / roundTripScored — the contract-quality headline. */
    readonly roundTripPrecision: number;
    /** pass / all across all entries. */
    readonly precision: number;
  };
  /** Histogram of round-trip failure kinds across the run. */
  readonly byFailureKind: Readonly<Record<string, number>>;
  readonly latency: { readonly p50Ms: number; readonly p95Ms: number };
}

export interface RunRepairBenchOptions {
  readonly limit?: number;
  readonly onProgress?: (
    outcome: RepairBenchOutcome,
    index: number,
    total: number,
  ) => void;
}

export async function evaluateRepairCorpus(
  deps: { readonly llm: LLMCaller },
  options: RunRepairBenchOptions = {},
  corpus: readonly BenchEntry[] = REPAIR_CORPUS,
): Promise<RepairBenchReport> {
  let subset: readonly BenchEntry[] = corpus;
  if (options.limit !== undefined) {
    subset = subset.slice(0, options.limit);
  }

  const outcomes: RepairBenchOutcome[] = [];
  for (let i = 0; i < subset.length; i++) {
    const entry = subset[i]!;
    const startedAt = Date.now();
    // The real production create-path: lint the draft → verbatim if clean
    // (origin agent), repair-in-place otherwise (origin synth). NEVER
    // throws; an unrepairable draft yields the empty `{}` contract.
    const result = await ensureConformingContract(
      { llm: deps.llm },
      {
        draft: entry.draft,
        intent: entry.intent,
        ...(entry.appGadgets !== undefined
          ? { appGadgets: entry.appGadgets }
          : {}),
      },
    );
    const latencyMs = Date.now() - startedAt;
    const shape = scoreSynthesizedContract(result.contract, entry.expected);
    const roundTrip =
      entry.roundTrip !== undefined
        ? scoreContractRoundTrip(result.contract, entry.roundTrip)
        : null;
    const outcome: RepairBenchOutcome = {
      entry,
      contract: result.contract,
      origin: result.origin,
      method: result.method,
      shape,
      roundTrip,
      findings: result.findings,
      reasoning: result.reasoning,
      latencyMs,
    };
    outcomes.push(outcome);
    options.onProgress?.(outcome, i, subset.length);
  }

  return summarizeRepair(outcomes);
}

export function summarizeRepair(
  outcomes: readonly RepairBenchOutcome[],
): RepairBenchReport {
  const all = outcomes.length;
  const pass = outcomes.filter(repairOutcomePass).length;
  const fail = all - pass;
  const originAgent = outcomes.filter((o) => o.origin === 'agent').length;
  const originSynth = outcomes.filter((o) => o.origin === 'synth').length;

  const scored = outcomes.filter((o) => o.roundTrip !== null);
  const roundTripScored = scored.length;
  const roundTripPass = scored.filter((o) => o.roundTrip?.pass === true).length;
  const roundTripPrecision =
    roundTripScored === 0 ? 0 : roundTripPass / roundTripScored;

  const byFailureKind: Record<string, number> = {};
  for (const o of outcomes) {
    for (const f of o.roundTrip?.failures ?? []) {
      byFailureKind[f.kind] = (byFailureKind[f.kind] ?? 0) + 1;
    }
  }

  const latencies = outcomes.map((o) => o.latencyMs).sort((a, b) => a - b);
  return {
    outcomes,
    totals: {
      all,
      pass,
      fail,
      originAgent,
      originSynth,
      roundTripScored,
      roundTripPass,
      roundTripPrecision,
      precision: all === 0 ? 0 : pass / all,
    },
    byFailureKind,
    latency: {
      p50Ms: percentile(latencies, 0.5),
      p95Ms: percentile(latencies, 0.95),
    },
  };
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx] ?? 0;
}

export function formatRepairBenchReport(report: RepairBenchReport): string {
  const lines: string[] = [];
  const t = report.totals;
  lines.push('=== repair bench report (round-trip quality) ===');
  lines.push('');
  lines.push(
    `Round-trip usable:   ${t.roundTripPass}/${t.roundTripScored} (${(t.roundTripPrecision * 100).toFixed(1)}%)`,
  );
  lines.push(`Repair origin:       agent×${t.originAgent} synth×${t.originSynth}`);
  // Efficiency tiers — verbatim + normalized are FREE (no LLM); only
  // llm-repair pays a model call. A high normalized count = the cheap
  // deterministic tier doing the work the LLM loop used to.
  const byMethod = new Map<string, number>();
  for (const o of report.outcomes) {
    byMethod.set(o.method, (byMethod.get(o.method) ?? 0) + 1);
  }
  const methodStr = ['verbatim', 'normalized', 'llm-repair', 'fallback-empty']
    .filter((m) => byMethod.has(m))
    .map((m) => `${m}×${byMethod.get(m)}`)
    .join(' ');
  lines.push(`Method (LLM cost):   ${methodStr}`);
  lines.push(
    `Overall pass:        ${t.pass}/${t.all} (${(t.precision * 100).toFixed(1)}%)`,
  );
  lines.push(
    `Latency:             p50=${report.latency.p50Ms}ms p95=${report.latency.p95Ms}ms`,
  );

  const kinds = Object.entries(report.byFailureKind);
  if (kinds.length > 0) {
    lines.push('');
    lines.push('Round-trip failures by kind:');
    for (const [kind, count] of kinds.sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${kind.padEnd(20)} ×${count}`);
    }
  }

  const failed = report.outcomes.filter((o) => !repairOutcomePass(o));
  if (failed.length > 0) {
    lines.push('');
    lines.push('Failures:');
    for (const o of failed) {
      lines.push(
        `  [origin ${o.origin}] ${o.entry.id}: ${o.entry.intent.slice(0, 56)}`,
      );
      // Shape mismatches (gating only — advisory name checks omitted here).
      for (const f of o.shape.failures) {
        lines.push(`    shape ${f.kind}: ${f.hint.slice(0, 120)}`);
      }
      for (const f of o.roundTrip?.failures ?? []) {
        lines.push(`    round-trip ${f.kind}: ${f.hint.slice(0, 160)}`);
      }
      lines.push(`    reasoning: ${o.reasoning.slice(0, 120)}`);
    }
  }

  return lines.join('\n');
}

export function runRepairBench(
  deps: { readonly llm: LLMCaller },
  options: RunRepairBenchOptions = {},
): Promise<RepairBenchReport> {
  return evaluateRepairCorpus(deps, options);
}
