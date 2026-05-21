/**
 * SLO v0 reporter — writes a self-describing JSON report and prints
 * a compact human-readable summary.
 *
 * The JSON is the primary artifact (machine-comparable across runs);
 * the console summary is a convenience for interactive runs.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { summarizeResults } from './summarize.js';
import type {
  SloMinMedianMax,
  SloPathSummary,
  SloReport,
  SloRunResult,
} from './types.js';

/** Honesty notes copied onto every v0 report — see README. */
const V0_NOTES: readonly string[] = [
  'finalCompiledAt reflects handler-return time (OSS Slice A defers stack-item compilation). See tags.finalCompiledReliable.',
  'blueprint_hit / generation_miss are emitter-simulated in v0 — the push handler does not yet branch on blueprint-finder results.',
  'finalDomVisibleAt is reserved (always null in v0). A renderer-driven v0.5 populates it.',
  'Stats are min/median/max per branch path; p50/p95 are deliberately NOT reported at this corpus size.',
];

/** Returns the default reports directory alongside this file. */
export function defaultReportsDir(): string {
  // `import.meta.url` resolves this file at runtime; we keep the
  // reports dir colocated with the SLO module so it's easy to grep.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, 'reports');
}

export interface WriteReportOptions {
  /** Override the reports dir. Defaults to `./reports/`. */
  readonly reportsDir?: string;
  /**
   * Override the generated-at timestamp. Useful for tests that need
   * a deterministic file name. Defaults to `new Date().toISOString()`.
   */
  readonly generatedAt?: string;
}

export function buildReport(
  results: readonly SloRunResult[],
  options: WriteReportOptions = {},
): SloReport {
  return {
    schemaVersion: 'slo.v0',
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    floorLabel: 'v0-seed',
    notes: V0_NOTES,
    results,
    summary: summarizeResults(results),
  };
}

/**
 * Serialize + persist the report. Returns the absolute file path so
 * the entry script can print "wrote to …".
 */
export function writeReport(
  results: readonly SloRunResult[],
  options: WriteReportOptions = {},
): { readonly path: string; readonly report: SloReport } {
  const report = buildReport(results, options);
  const dir = options.reportsDir ?? defaultReportsDir();
  mkdirSync(dir, { recursive: true });
  // File-safe ISO: replace `:` → `-` so the report is Windows-openable.
  const stamp = report.generatedAt.replace(/:/g, '-');
  const path = join(dir, `slo-${stamp}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2), 'utf8');
  return { path, report };
}

/**
 * Compact human-readable summary. Intentionally terse — the JSON is
 * the source of truth. One row per branch path with a `null-count`
 * marker so readers never miss the null-as-signal semantic.
 */
export function formatReportTable(report: SloReport): string {
  const lines: string[] = [];
  lines.push(`SLO ${report.schemaVersion} (${report.floorLabel}) — ${report.generatedAt}`);
  lines.push(`  runs: ${report.results.length}`);
  for (const note of report.notes) {
    lines.push(`  note: ${note}`);
  }
  lines.push('');
  lines.push('  path              runs  ttFirstPrev(ms)   ttFinalize(ms)    ttCompiled(ms)    frames    observed/regress');
  lines.push('  ' + '-'.repeat(115));
  for (const s of report.summary) {
    lines.push(`  ${formatRow(s)}`);
  }
  return lines.join('\n');
}

function formatRow(s: SloPathSummary): string {
  const runs = String(s.runs).padStart(4);
  const tFirst = formatStat(s.timeToFirstPreview);
  const tFin = formatStat(s.timeToPreviewFinalize);
  const tCompile = formatStat(s.timeToFinalCompiled);
  const frames = formatStat(s.previewFrames);
  // Column: observed count / regression count (expected-but-missing).
  // For oss_miss runs (no preview expected), both values are 0 —
  // that's the correct "null is legitimate, not a regression" signal.
  const observedRegress = `${s.previewObservedCount}/${s.previewExpectedButMissingCount}`;
  return [
    s.path.padEnd(17),
    runs,
    tFirst.padEnd(18),
    tFin.padEnd(18),
    tCompile.padEnd(18),
    frames.padEnd(8),
    observedRegress,
  ].join('  ');
}

function formatStat(stat: SloMinMedianMax): string {
  if (stat.count === 0) {
    return `null×${stat.nullCount}`;
  }
  const nullMark = stat.nullCount > 0 ? ` (+${stat.nullCount} null)` : '';
  const fmt = (n: number | null) => (n === null ? '–' : Math.round(n).toString());
  return `${fmt(stat.min)}/${fmt(stat.median)}/${fmt(stat.max)}${nullMark}`;
}
