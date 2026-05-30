// oss/misc/benchmark/src/contract-synthesis/reporter.ts
//
// Aggregates contract-synthesis run results into a per-model summary and a
// console table. The KPIs depend on which path was measured:
//
//   ensure (production-faithful): the headline is the ZERO-LLM rate
//     (verbatim + normalized) — drafts resolved instantly with no model
//     call. Then the method distribution and, when the LLM repair loop
//     did run, its latency. "Keep it short" literally = maximize zero-LLM.
//
//   synth (prompt-tuning lens): the headline is first-pass rate
//     (attempts === 1) and avg attempts (1..5).
//
// Small-corpus reporting discipline: min/median/max, never p50/p95.

import type { ContractSynthRunResult, SynthVia } from './runner.js';

export interface ModelSummary {
  readonly model: string;
  readonly provider: string;
  readonly via: SynthVia;
  readonly runs: number;
  readonly converged: number;
  readonly convergeRate: number;
  /** ensure: zero-LLM (verbatim+normalized) rate. synth: first-pass (1 attempt) rate. */
  readonly fastRate: number;
  /** Mean attempts over converged runs (synth path; 0 on ensure path). */
  readonly avgAttemptsConverged: number;
  readonly minAttempts: number;
  readonly medianAttempts: number;
  readonly maxAttempts: number;
  readonly avgLatencyMs: number;
  readonly medianLatencyMs: number;
  /** ensure-path method tally. */
  readonly methods: {
    readonly verbatim: number;
    readonly normalized: number;
    readonly llmRepair: number;
    readonly fallbackEmpty: number;
  };
  readonly capHits: number;
  readonly errors: number;
  readonly cold: { runs: number; fastRate: number; avgAttempts: number };
  readonly repair: { runs: number; fastRate: number; avgAttempts: number };
}

export interface ContractSynthReport {
  readonly schemaVersion: 'contract-synthesis.v0';
  readonly via: SynthVia;
  readonly timestamp: string;
  readonly models: readonly ModelSummary[];
  readonly results: readonly ContractSynthRunResult[];
}

function median(nums: readonly number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2 : (s[m] ?? 0);
}
function mean(nums: readonly number[]): number {
  return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length;
}

function modeSlice(
  rows: readonly ContractSynthRunResult[],
): { runs: number; fastRate: number; avgAttempts: number } {
  const runs = rows.length;
  const fast = rows.filter((r) => r.oneShot).length;
  const conv = rows.filter((r) => r.converged);
  return {
    runs,
    fastRate: runs === 0 ? 0 : fast / runs,
    avgAttempts: mean(conv.map((r) => r.attempts ?? 0)),
  };
}

function summarizeModel(
  model: string,
  provider: string,
  via: SynthVia,
  rows: readonly ContractSynthRunResult[],
): ModelSummary {
  const runs = rows.length;
  const converged = rows.filter((r) => r.converged);
  const attempts = converged.map((r) => r.attempts ?? 0).filter((a) => a > 0);
  const fast = rows.filter((r) => r.oneShot).length;
  return {
    model,
    provider,
    via,
    runs,
    converged: converged.length,
    convergeRate: runs === 0 ? 0 : converged.length / runs,
    fastRate: runs === 0 ? 0 : fast / runs,
    avgAttemptsConverged: mean(attempts),
    minAttempts: attempts.length ? Math.min(...attempts) : 0,
    medianAttempts: median(attempts),
    maxAttempts: attempts.length ? Math.max(...attempts) : 0,
    avgLatencyMs: mean(rows.map((r) => r.latencyMs)),
    medianLatencyMs: median(rows.map((r) => r.latencyMs)),
    methods: {
      verbatim: rows.filter((r) => r.method === 'verbatim').length,
      normalized: rows.filter((r) => r.method === 'normalized').length,
      llmRepair: rows.filter((r) => r.method === 'llm-repair').length,
      fallbackEmpty: rows.filter((r) => r.method === 'fallback-empty').length,
    },
    capHits: rows.filter((r) => r.capHit).length,
    errors: rows.filter((r) => r.error !== undefined).length,
    cold: modeSlice(rows.filter((r) => r.mode === 'cold')),
    repair: modeSlice(rows.filter((r) => r.mode === 'repair')),
  };
}

export function buildReport(
  results: readonly ContractSynthRunResult[],
  via: SynthVia,
  timestamp: string,
): ContractSynthReport {
  const byModel = new Map<string, ContractSynthRunResult[]>();
  for (const r of results) {
    const key = `${r.provider}::${r.model}`;
    const arr = byModel.get(key) ?? [];
    arr.push(r);
    byModel.set(key, arr);
  }
  const models: ModelSummary[] = [];
  for (const [, rows] of byModel) {
    const first = rows[0];
    if (first === undefined) continue;
    models.push(summarizeModel(first.model, first.provider, via, rows));
  }
  return { schemaVersion: 'contract-synthesis.v0', via, timestamp, models, results: [...results] };
}

const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;
const ms = (n: number): string => `${(n / 1000).toFixed(1)}s`;

export function renderReport(report: ContractSynthReport): string {
  const lines: string[] = [];
  const isEnsure = report.via === 'ensure';
  lines.push('');
  lines.push(
    `  Contract-Synthesis Convergence — per model  (path: ${report.via}${
      isEnsure ? ' = production-faithful' : ' = raw LLM loop'
    })`,
  );
  if (isEnsure) {
    lines.push(
      '  model                          runs  conv   zero-LLM  verb/norm/repair/fallback  avgLat',
    );
    for (const m of report.models) {
      const name = `${m.provider}/${m.model}`.slice(0, 28).padEnd(30);
      const md = m.methods;
      lines.push(
        `  ${name} ${String(m.runs).padStart(4)}  ${pct(m.convergeRate).padStart(4)}  ` +
          `${pct(m.fastRate).padStart(8)}  ` +
          `${`${md.verbatim}/${md.normalized}/${md.llmRepair}/${md.fallbackEmpty}`.padStart(25)}  ` +
          `${ms(m.avgLatencyMs).padStart(6)}`,
      );
    }
    lines.push('');
    lines.push('  zero-LLM = verbatim + normalized (instant, no model call). higher = better.');
  } else {
    lines.push(
      '  model                          runs  conv   1-shot  avgAtt  min/med/max  avgLat  capHit  err',
    );
    for (const m of report.models) {
      const name = `${m.provider}/${m.model}`.slice(0, 28).padEnd(30);
      lines.push(
        `  ${name} ${String(m.runs).padStart(4)}  ${pct(m.convergeRate).padStart(4)}  ` +
          `${pct(m.fastRate).padStart(6)}  ${m.avgAttemptsConverged.toFixed(2).padStart(6)}  ` +
          `${`${m.minAttempts}/${m.medianAttempts}/${m.maxAttempts}`.padStart(11)}  ` +
          `${ms(m.avgLatencyMs).padStart(6)}  ${String(m.capHits).padStart(6)}  ${String(m.errors).padStart(3)}`,
      );
    }
  }
  lines.push('');
  const fastLabel = isEnsure ? 'zero-LLM rate' : '1-shot rate';
  lines.push(`  cold vs repair (${fastLabel} / avg attempts)`);
  for (const m of report.models) {
    const name = `${m.provider}/${m.model}`.slice(0, 28).padEnd(30);
    lines.push(
      `  ${name} cold ${pct(m.cold.fastRate)}/${m.cold.avgAttempts.toFixed(2)}   ` +
        `repair ${pct(m.repair.fastRate)}/${m.repair.avgAttempts.toFixed(2)}`,
    );
  }
  lines.push('');

  const misses = report.results.filter((r) => !r.metTarget);
  if (misses.length > 0) {
    lines.push('  ⚠ cases over target / non-converged (the work-list):');
    for (const r of misses) {
      const tag = !r.converged
        ? r.error
          ? 'ERROR'
          : 'NO-CONVERGE'
        : r.method
          ? r.method
          : `${r.attempts ?? '?'} att`;
      lines.push(
        `    ${r.provider}/${r.model} × ${r.caseId} — ${tag}` +
          (r.error ? ` (${r.error.slice(0, 60)})` : ''),
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}
