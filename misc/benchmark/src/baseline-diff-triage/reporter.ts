/**
 * Triage reporter — JSON emission + compact console table.
 *
 * Console surfaces ONLY `alert` and `notice` items (the CI-worthy
 * signals). `suppressed` and `informational` show as counts. The
 * full list lives in the JSON for downstream tooling.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { TriageItem, TriageReport } from './types.js';

export function writeTriage(report: TriageReport, outputPath: string): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf8');
}

export function formatTriageTable(report: TriageReport): string {
  const lines: string[] = [];
  lines.push(
    `Triage ${report.schemaVersion} — ${report.source.beforeBaselineId} → ${report.source.afterBaselineId}`,
  );
  lines.push(
    `  git: ${report.source.beforeGitSha?.slice(0, 8) ?? '?'} → ${report.source.afterGitSha?.slice(0, 8) ?? '?'}`,
  );

  const { counts, decision } = report;
  const statusMark = decision === 'pass' ? '✓ PASS' : '✗ FAIL';
  lines.push(
    `  counts: alert=${counts.alert}  notice=${counts.notice}  suppressed=${counts.suppressed}  informational=${counts.informational}`,
  );
  lines.push(`  decision: ${statusMark}${decision === 'fail' ? ` (${counts.alert} alert${counts.alert === 1 ? '' : 's'})` : ''}`);

  for (const note of report.notes) lines.push(`  note: ${note}`);

  const alerts = report.items.filter((i) => i.severity === 'alert');
  const notices = report.items.filter((i) => i.severity === 'notice');

  if (alerts.length > 0) {
    lines.push('');
    lines.push(`  ── alerts (${alerts.length}) ──`);
    for (const it of alerts) lines.push(`  ${formatLine('✗', it)}`);
  }
  if (notices.length > 0) {
    lines.push('');
    lines.push(`  ── notices (${notices.length}) ──`);
    for (const it of notices) lines.push(`  ${formatLine('!', it)}`);
  }
  if (alerts.length === 0 && notices.length === 0) {
    lines.push('');
    lines.push('  (no alerts or notices)');
  }
  return lines.join('\n');
}

function formatLine(marker: string, it: TriageItem): string {
  const anchor =
    it.anchor === 'provisional' ? ` [provisional]` : ` [cal:${it.anchor}]`;
  return `${marker} [${it.benchName}] ${it.location}${anchor} — ${it.message}`;
}
