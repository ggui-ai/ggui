/**
 * Baseline-diff reporter — JSON emission + compact console summary.
 *
 * Console emphasis order (per brief):
 *   1. status transitions (what fired/regressed/recovered)
 *   2. most important numeric deltas per bench
 *   3. missing/incompatible data notes
 *
 * No composite scores. No cross-bench normalization. Each bench's
 * numbers stay in their own units.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type {
  BenchBaselineDiff,
  BenchDiffEntry,
  FieldDelta,
  StatusChange,
} from './types.js';

/** Per-bench "headline" fields — the short scannable view. */
const BENCH_HEADLINE_FIELDS: Record<string, readonly string[]> = {
  slo: [
    'timeToFirstPreview',
    'timeToPreviewFinalize',
    'previewExpectedButMissingCount',
  ],
  a2ui: ['timeToFirstFrame', 'frameCount', 'totalParseFailures'],
  'multi-sdk': [
    'avgTimeMs',
    'avgScore',
    'successRate',
  ],
};

export function writeDiff(
  diff: BenchBaselineDiff,
  outputPath: string,
): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(diff, null, 2), 'utf8');
}

export function formatDiffTable(diff: BenchBaselineDiff): string {
  const lines: string[] = [];
  lines.push(
    `Baseline-Diff ${diff.schemaVersion} — ${diff.beforeBaselineId}  vs  ${diff.afterBaselineId}`,
  );
  lines.push(`  before: ${diff.beforeTimestamp}  git=${diff.beforeGitSha ?? '?'}`);
  lines.push(`  after:  ${diff.afterTimestamp}  git=${diff.afterGitSha ?? '?'}`);
  for (const note of diff.notes) lines.push(`  note: ${note}`);

  // ── 1. Status transitions ──────────────────────────────────────
  lines.push('');
  lines.push('  ── status transitions ──');
  const transitionOrder: StatusChange[] = [
    'regressed',
    'recovered',
    'added',
    'removed',
    'same-failed',
    'same-success',
  ];
  const byTransition = new Map<StatusChange, string[]>();
  for (const e of diff.benchDiffs) {
    const list = byTransition.get(e.statusChange) ?? [];
    list.push(e.benchName);
    byTransition.set(e.statusChange, list);
  }
  let anyTransition = false;
  for (const t of transitionOrder) {
    const names = byTransition.get(t);
    if (!names || names.length === 0) continue;
    if (t !== 'same-success') anyTransition = true;
    lines.push(
      `  ${marker(t)} ${t.padEnd(13)} ${names.join(', ')}`,
    );
  }
  if (!anyTransition) {
    lines.push('  (no regression / recovery / added / removed; all same-success)');
  }

  // ── 2. Per-bench deltas ────────────────────────────────────────
  lines.push('');
  lines.push('  ── per-bench deltas ──');
  for (const entry of diff.benchDiffs) {
    lines.push('');
    lines.push(
      `  [${entry.benchName}] ${entry.beforeStatus ?? '—'} → ${entry.afterStatus ?? '—'}`,
    );
    if (entry.summaryDiff === null) {
      lines.push(`    (no summary diff — see notes)`);
    } else {
      formatBenchSummaryRows(entry, lines);
    }
    // Notes last; keep them short.
    for (const note of entry.notes) {
      lines.push(`    note: ${note}`);
    }
  }

  return lines.join('\n');
}

function marker(t: StatusChange): string {
  switch (t) {
    case 'regressed':
      return '✗';
    case 'recovered':
      return '✓';
    case 'added':
      return '+';
    case 'removed':
      return '-';
    case 'same-failed':
      return '!';
    case 'same-success':
      return '=';
  }
}

function formatBenchSummaryRows(
  entry: BenchDiffEntry,
  lines: string[],
): void {
  const summary = entry.summaryDiff;
  if (!summary || summary.kind !== 'grouped') return;
  const headlineFields = BENCH_HEADLINE_FIELDS[entry.benchName] ?? [];

  for (const row of summary.rows) {
    const prefix = presencePrefix(row.presence);
    const parts: string[] = [];
    for (const fieldName of headlineFields) {
      const fd = row.fields[fieldName];
      if (!fd) continue;
      parts.push(`${fieldName}=${formatFieldDelta(fd, fieldName)}`);
    }
    const body = parts.length > 0 ? parts.join(' ') : '(no headline fields)';
    lines.push(
      `    ${prefix} ${summary.keyField}=${row.key.padEnd(16)} ${body}`,
    );
  }
}

function presencePrefix(p: 'both' | 'added' | 'removed'): string {
  switch (p) {
    case 'both':
      return '=';
    case 'added':
      return '+';
    case 'removed':
      return '-';
  }
}

/**
 * Format one field delta for console. Keeps the value short —
 * single line per field, delta in parens. The field name tells us
 * whether this is a rate (`*Rate` / `*Ratio`) → render as %, or a
 * raw number/latency → render as-is. Without the name hint we'd have
 * to guess from magnitude, which collapses sub-ms latencies into
 * percentage noise.
 */
function formatFieldDelta(fd: FieldDelta, fieldName: string): string {
  const isRate = isRateField(fieldName);
  switch (fd.kind) {
    case 'missing':
      return 'n/a';
    case 'scalar': {
      const b = fd.before === null ? '–' : formatNumber(fd.before, isRate);
      const a = fd.after === null ? '–' : formatNumber(fd.after, isRate);
      const d =
        fd.delta === null ? '' : ` (${formatDeltaSigned(fd.delta, isRate)})`;
      return `${b}→${a}${d}`;
    }
    case 'stat': {
      const b = fd.before?.median ?? null;
      const a = fd.after?.median ?? null;
      const bStr = b === null ? '–' : formatNumber(b, isRate);
      const aStr = a === null ? '–' : formatNumber(a, isRate);
      const d =
        fd.deltaMedian === null
          ? ''
          : ` (${formatDeltaSigned(fd.deltaMedian, isRate)})`;
      return `${bStr}→${aStr}${d}`;
    }
  }
}

function isRateField(name: string): boolean {
  return name.endsWith('Rate') || name.endsWith('Ratio');
}

function formatNumber(n: number, isRate: boolean): string {
  if (isRate) return (n * 100).toFixed(0) + '%';
  if (Number.isInteger(n)) return String(n);
  if (Math.abs(n) >= 100) return Math.round(n).toString();
  return n.toFixed(1);
}

function formatDeltaSigned(d: number, isRate: boolean): string {
  if (d === 0) return '0';
  const sign = d > 0 ? '+' : '';
  return sign + formatNumber(d, isRate);
}
