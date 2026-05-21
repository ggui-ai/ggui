/**
 * Triage orchestrator — walks a `BenchBaselineDiff` and applies the
 * policy rules to produce a `TriageReport`.
 *
 * Pure function. IO lives in the CLI script.
 */

import type { BenchBaselineDiff } from '../baseline-diff/types.js';
import {
  classifyField,
  classifyRowPresence,
  classifyStatus,
  type RowFieldContext,
} from './policy.js';
import type {
  SeverityCounts,
  TriageDecision,
  TriageItem,
  TriageReport,
} from './types.js';

export function triageDiff(
  diff: BenchBaselineDiff,
  options: { generatedAt?: string } = {},
): TriageReport {
  if (diff.schemaVersion !== 'bench-baseline-diff.v0') {
    throw new Error(
      `Unsupported diff schemaVersion: ${diff.schemaVersion} (triage v0 supports 'bench-baseline-diff.v0' only)`,
    );
  }

  const items: TriageItem[] = [];
  const policyNotes: string[] = [];

  for (const entry of diff.benchDiffs) {
    // Status-level rule first (statusChange classification).
    const statusItem = classifyStatus(entry);
    if (statusItem) items.push(statusItem);

    // Summary diff rows — one item per field per row.
    if (entry.summaryDiff && entry.summaryDiff.kind === 'grouped') {
      const driftNoted = entry.notes.some((n) =>
        /missing|schemaversion/i.test(n),
      );
      for (const row of entry.summaryDiff.rows) {
        const presenceItem = classifyRowPresence(entry, row, driftNoted);
        if (presenceItem) items.push(presenceItem);

        // Only materialize field-level items on rows present on
        // both sides. For added/removed rows, the row-presence rule
        // already surfaces the signal; drilling into fields of a
        // fully-added row would double-alert.
        if (row.presence !== 'both') continue;

        const rowContext: RowFieldContext = {
          siblingFields: row.fields,
        };
        for (const [fieldName, delta] of Object.entries(row.fields)) {
          const item = classifyField(
            entry.benchName,
            row.key,
            fieldName,
            delta,
            rowContext,
          );
          if (item) items.push(item);
        }
      }
    }
  }

  // Surface a policy note when any item references a provisional
  // threshold, so triage JSON readers know parts of the policy are
  // under-calibrated.
  if (items.some((i) => i.anchor === 'provisional')) {
    policyNotes.push(
      'policy v0 includes provisional thresholds (see anchor="provisional" items); calibrate before treating as stable',
    );
  }

  const counts = tallyCounts(items);
  const decision: TriageDecision = counts.alert > 0 ? 'fail' : 'pass';

  return {
    schemaVersion: 'bench-baseline-diff-triage.v0',
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    source: {
      diffSchemaVersion: diff.schemaVersion,
      beforeBaselineId: diff.beforeBaselineId,
      afterBaselineId: diff.afterBaselineId,
      beforeTimestamp: diff.beforeTimestamp,
      afterTimestamp: diff.afterTimestamp,
      beforeGitSha: diff.beforeGitSha,
      afterGitSha: diff.afterGitSha,
    },
    counts,
    decision,
    items,
    notes: [...diff.notes, ...policyNotes],
  };
}

function tallyCounts(items: readonly TriageItem[]): SeverityCounts {
  let alert = 0;
  let notice = 0;
  let suppressed = 0;
  let informational = 0;
  for (const it of items) {
    switch (it.severity) {
      case 'alert':
        alert += 1;
        break;
      case 'notice':
        notice += 1;
        break;
      case 'suppressed':
        suppressed += 1;
        break;
      case 'informational':
        informational += 1;
        break;
    }
  }
  return { alert, notice, suppressed, informational };
}
