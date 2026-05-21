/**
 * Blueprint-negotiation v0 reporter — writes JSON + prints a
 * compact per-mode console table.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { summarizeNegotiationResults } from './summarize.js';
import type {
  NegotiationMinMedianMax,
  NegotiationModeSummary,
  NegotiationReport,
  NegotiationRunResult,
} from './types.js';

const V0_NOTES: readonly string[] = [
  'Multi-registry arbitration is NOT benchable in v0 — `negotiate()` takes a single VectorStore. arbitrationCorrectnessRate is always 0; schema slot reserved for v0.5.',
  'Confidence is NOT surfaced on negotiate() result (internal only). tags.confidence is always null in v0.',
  'No real LLM calls — miss cases route through a deterministic stub. Decision latency stays near 0 on fast-path hits, minimal overhead on stubbed misses.',
  'empty-registry clean miss is a SUCCESS case, not a failure. Look for emptyRegistryCleanMissRate on the empty row — 1.0 is the healthy value.',
  'Stats are min/median/max per registry mode; p50/p95 are deliberately NOT reported at this corpus size.',
];

export function defaultReportsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, 'reports');
}

export interface WriteNegotiationReportOptions {
  readonly reportsDir?: string;
  readonly generatedAt?: string;
}

export function buildNegotiationReport(
  results: readonly NegotiationRunResult[],
  options: WriteNegotiationReportOptions = {},
): NegotiationReport {
  return {
    schemaVersion: 'blueprint-negotiation.v0',
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    floorLabel: 'v0-seed',
    notes: V0_NOTES,
    results,
    summary: summarizeNegotiationResults(results),
  };
}

export function writeNegotiationReport(
  results: readonly NegotiationRunResult[],
  options: WriteNegotiationReportOptions = {},
): { readonly path: string; readonly report: NegotiationReport } {
  const report = buildNegotiationReport(results, options);
  const dir = options.reportsDir ?? defaultReportsDir();
  mkdirSync(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/:/g, '-');
  const path = join(dir, `negotiation-${stamp}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2), 'utf8');
  return { path, report };
}

export function formatNegotiationTable(report: NegotiationReport): string {
  const lines: string[] = [];
  lines.push(
    `Blueprint-Negotiation ${report.schemaVersion} (${report.floorLabel}) — ${report.generatedAt}`,
  );
  lines.push(`  runs: ${report.results.length}`);
  for (const note of report.notes) lines.push(`  note: ${note}`);
  lines.push('');
  lines.push(
    '  mode     runs  hitRate  FP      FN      exactMatch  cleanMiss  wrongHit  error  decision(ms)',
  );
  lines.push('  ' + '-'.repeat(115));
  for (const s of report.summary) lines.push(`  ${formatRow(s)}`);
  return lines.join('\n');
}

function formatRow(s: NegotiationModeSummary): string {
  const pct = (n: number | null) =>
    n === null ? '  n/a' : `${Math.round(n * 100).toString().padStart(3)}%`;
  const runs = String(s.runs).padStart(4);
  const decision = formatStat(s.decisionTimeMs);
  return [
    s.registryMode.padEnd(8),
    runs,
    pct(s.hitRate),
    pct(s.falsePositiveRate),
    pct(s.falseNegativeRate),
    pct(s.exactMatchRateOnHits).padEnd(10),
    pct(s.emptyRegistryCleanMissRate).padEnd(9),
    pct(s.wrongHitRate).padEnd(8),
    pct(s.errorRate).padEnd(5),
    decision,
  ].join('  ');
}

function formatStat(stat: NegotiationMinMedianMax): string {
  if (stat.count === 0) return `null×${stat.nullCount}`;
  const fmt = (n: number | null) => (n === null ? '–' : Math.round(n).toString());
  const nullMark = stat.nullCount > 0 ? ` (+${stat.nullCount} null)` : '';
  return `${fmt(stat.min)}/${fmt(stat.median)}/${fmt(stat.max)}${nullMark}`;
}
