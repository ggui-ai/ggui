/**
 * A2UI v0 reporter — writes a self-describing JSON report +
 * prints a compact console table. JSON is the source of truth.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { summarizeA2uiResults } from './summarize.js';
import type {
  A2uiMinMedianMax,
  A2uiReport,
  A2uiRunResult,
  A2uiShapeSummary,
} from './types.js';

const V0_NOTES: readonly string[] = [
  'handoffGapMs is reserved (always null in v0) — no hosted call site invokes finalizeProvisionalPreview yet.',
  'The deterministic emitter is the only producer wired today; Haiku-backed producer drops in behind the same interface.',
  'Parse is evaluated per-frame via parseServerMessage BEFORE transport ack — parseFailCount > 0 is the primary regression signal.',
  'Stats are min/median/max per intent-shape; p50/p95 are deliberately NOT reported at this corpus size.',
  'No DOM-visible / renderer / visual-delta checkpoint — that is v0.5 work.',
];

export function defaultReportsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, 'reports');
}

export interface WriteA2uiReportOptions {
  readonly reportsDir?: string;
  readonly generatedAt?: string;
}

export function buildA2uiReport(
  results: readonly A2uiRunResult[],
  options: WriteA2uiReportOptions = {},
): A2uiReport {
  return {
    schemaVersion: 'a2ui.v0',
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    floorLabel: 'v0-seed',
    notes: V0_NOTES,
    results,
    summary: summarizeA2uiResults(results),
  };
}

export function writeA2uiReport(
  results: readonly A2uiRunResult[],
  options: WriteA2uiReportOptions = {},
): { readonly path: string; readonly report: A2uiReport } {
  const report = buildA2uiReport(results, options);
  const dir = options.reportsDir ?? defaultReportsDir();
  mkdirSync(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/:/g, '-');
  const path = join(dir, `a2ui-${stamp}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2), 'utf8');
  return { path, report };
}

export function formatA2uiTable(report: A2uiReport): string {
  const lines: string[] = [];
  lines.push(`A2UI ${report.schemaVersion} (${report.floorLabel}) — ${report.generatedAt}`);
  lines.push(`  runs: ${report.results.length}`);
  for (const note of report.notes) lines.push(`  note: ${note}`);
  lines.push('');
  lines.push('  shape     runs  ttFirstFrame(ms)   ttFinalize(ms)     frames       parsePassRate      observed/regress  parseFails');
  lines.push('  ' + '-'.repeat(125));
  for (const s of report.summary) {
    lines.push(`  ${formatRow(s)}`);
  }
  return lines.join('\n');
}

function formatRow(s: A2uiShapeSummary): string {
  const runs = String(s.runs).padStart(4);
  const tFirst = formatStat(s.timeToFirstFrame);
  const tFin = formatStat(s.timeToPreviewFinalize);
  const frames = formatStat(s.frameCount);
  const pass = formatRateStat(s.parsePassRate);
  const observed = s.runs - s.previewExpectedButMissingCount;
  const observedCol = `${observed}/${s.previewExpectedButMissingCount}`;
  const parseCol = `${s.runsWithParseFailures}r/${s.totalParseFailures}f`;
  return [
    s.intentShape.padEnd(9),
    runs,
    tFirst.padEnd(18),
    tFin.padEnd(18),
    frames.padEnd(12),
    pass.padEnd(18),
    observedCol.padEnd(17),
    parseCol,
  ].join('  ');
}

function formatStat(stat: A2uiMinMedianMax): string {
  if (stat.count === 0) return `null×${stat.nullCount}`;
  const nullMark = stat.nullCount > 0 ? ` (+${stat.nullCount} null)` : '';
  const fmt = (n: number | null) => (n === null ? '–' : Math.round(n).toString());
  return `${fmt(stat.min)}/${fmt(stat.median)}/${fmt(stat.max)}${nullMark}`;
}

function formatRateStat(stat: A2uiMinMedianMax): string {
  if (stat.count === 0) return `null×${stat.nullCount}`;
  const fmt = (n: number | null) =>
    n === null ? '–' : `${(n * 100).toFixed(0)}%`;
  const nullMark = stat.nullCount > 0 ? ` (+${stat.nullCount} null)` : '';
  return `${fmt(stat.min)}/${fmt(stat.median)}/${fmt(stat.max)}${nullMark}`;
}
