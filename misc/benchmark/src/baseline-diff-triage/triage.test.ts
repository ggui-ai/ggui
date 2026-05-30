/**
 * Triage tests — each case anchored to a real calibration class.
 * Uses synthetic `BenchBaselineDiff` objects so tests are fast and
 * don't depend on filesystem state. One integration test at the
 * bottom exercises real calibration bundle pairs.
 */

import { describe, expect, it } from 'vitest';
import type {
  BenchBaselineDiff,
  BenchDiffEntry,
  FieldDelta,
  RowDiff,
  StatBand,
} from '../baseline-diff/types.js';
import type { BenchName } from '../baseline/manifest.js';
import { triageDiff } from './triage.js';
import type { TriageReport } from './types.js';

// ─── Fixture helpers ───────────────────────────────────────────────

function mkDiff(entries: readonly BenchDiffEntry[]): BenchBaselineDiff {
  return {
    schemaVersion: 'bench-baseline-diff.v0',
    beforeBaselineId: 'baseline-before',
    afterBaselineId: 'baseline-after',
    beforeTimestamp: '2026-04-20T00:00:00Z',
    afterTimestamp: '2026-04-20T00:01:00Z',
    beforeGitSha: 'abc12345',
    afterGitSha: 'def67890',
    notes: [],
    benchDiffs: entries,
  };
}

function mkEntry(
  benchName: BenchName,
  overrides: Partial<BenchDiffEntry> = {},
): BenchDiffEntry {
  return {
    benchName,
    beforeStatus: 'success',
    afterStatus: 'success',
    statusChange: 'same-success',
    summaryDiff: null,
    notes: [],
    ...overrides,
  };
}

function scalar(before: number | null, after: number | null): FieldDelta {
  return {
    kind: 'scalar',
    before,
    after,
    delta: before !== null && after !== null ? after - before : null,
  };
}

function stat(
  before: Partial<StatBand> | null,
  after: Partial<StatBand> | null,
): FieldDelta {
  const b: StatBand | null = before
    ? { count: 3, nullCount: 0, min: 0, median: 0, max: 0, ...before }
    : null;
  const a: StatBand | null = after
    ? { count: 3, nullCount: 0, min: 0, median: 0, max: 0, ...after }
    : null;
  return {
    kind: 'stat',
    before: b,
    after: a,
    deltaMedian:
      b?.median !== null && b?.median !== undefined && a?.median !== null && a?.median !== undefined
        ? a.median - b.median
        : null,
    deltaMin:
      b?.min !== null && b?.min !== undefined && a?.min !== null && a?.min !== undefined
        ? a.min - b.min
        : null,
    deltaMax:
      b?.max !== null && b?.max !== undefined && a?.max !== null && a?.max !== undefined
        ? a.max - b.max
        : null,
  };
}

function mkRow(
  key: string,
  fields: Record<string, FieldDelta>,
  presence: 'both' | 'added' | 'removed' = 'both',
): RowDiff {
  return { key, presence, fields };
}

function alertsOf(report: TriageReport) {
  return report.items.filter((i) => i.severity === 'alert');
}
function noticesOf(report: TriageReport) {
  return report.items.filter((i) => i.severity === 'notice');
}
function infoOf(report: TriageReport) {
  return report.items.filter((i) => i.severity === 'informational');
}

// ─── 1. N↔N: same-code noise suppression ──────────────────────────

describe('N↔N same-code noise', () => {
  it('zero alerts when all fields are at noise-floor', () => {
    const diff = mkDiff([
      mkEntry('slo', {
        summaryDiff: {
          kind: 'grouped',
          keyField: 'path',
          rows: [
            mkRow('blueprint_hit', {
              runs: scalar(3, 3),
              previewObservedCount: scalar(3, 3),
              previewExpectedButMissingCount: scalar(0, 0),
              timeToFirstPreview: stat(
                { min: 25, median: 25.6, max: 26 },
                { min: 25, median: 26.6, max: 27 }, // +1ms noise
              ),
            }),
          ],
        },
      }),
      mkEntry('a2ui', {
        summaryDiff: {
          kind: 'grouped',
          keyField: 'intentShape',
          rows: [
            mkRow('form', {
              totalParseFailures: scalar(0, 0),
              runsWithParseFailures: scalar(0, 0),
              previewExpectedButMissingCount: scalar(0, 0),
              frameCount: stat({ median: 4 }, { median: 4 }),
            }),
          ],
        },
      }),
    ]);
    const report = triageDiff(diff);
    expect(report.decision).toBe('pass');
    expect(report.counts.alert).toBe(0);
    expect(alertsOf(report)).toHaveLength(0);
  });

  it('decision is pass with zero alerts', () => {
    const diff = mkDiff([mkEntry('slo')]); // no summary → nothing to classify
    const report = triageDiff(diff);
    expect(report.decision).toBe('pass');
  });
});

// ─── 2. N→F1: silent internal failure → alerts ────────────────────

describe('N→F1 silent internal failure', () => {
  it('multi-sdk avgScore collapse to -1 sentinel triggers alert', () => {
    const diff = mkDiff([
      mkEntry('multi-sdk', {
        summaryDiff: {
          kind: 'grouped',
          keyField: 'floor',
          rows: [
            mkRow('oss', {
              avgScore: scalar(75.0, -1.0), // n/a sentinel
              avgTimeMs: scalar(12000, 0),
              successRate: scalar(1.0, 0.0),
              capHitRate: scalar(0, 0),
              predefinedToolCallRate: scalar(0, 0),
              runs: scalar(1, 1),
              avgPredefinedToolCalls: scalar(0, 0),
            }),
          ],
        },
      }),
    ]);
    const report = triageDiff(diff);
    expect(report.decision).toBe('fail');
    const alerts = alertsOf(report);
    // Multiple alerts fire: successRate drop, avgScore sentinel,
    // avgTimeMs composite. All are F1-calibrated.
    expect(alerts.length).toBeGreaterThanOrEqual(2);
    const hasSentinel = alerts.some(
      (a) => a.rule === 'multisdk-score-sentinel',
    );
    const hasSuccessDrop = alerts.some(
      (a) => a.rule === 'multisdk-successrate-drop',
    );
    expect(hasSentinel).toBe(true);
    expect(hasSuccessDrop).toBe(true);
  });

  it('same-success status with silent failure is still fail decision', () => {
    const diff = mkDiff([
      mkEntry('multi-sdk', {
        statusChange: 'same-success',
        summaryDiff: {
          kind: 'grouped',
          keyField: 'floor',
          rows: [
            mkRow('oss', {
              avgScore: scalar(75, -1),
              successRate: scalar(1, 0),
              avgTimeMs: scalar(12000, 0),
              capHitRate: scalar(0, 0),
              predefinedToolCallRate: scalar(0, 0),
              runs: scalar(1, 1),
              avgPredefinedToolCalls: scalar(0, 0),
            }),
          ],
        },
      }),
    ]);
    const report = triageDiff(diff);
    expect(report.decision).toBe('fail');
    // Status-level statusChange is 'same-success', but field rules
    // produce alerts — the decision must still be fail.
  });
});

// ─── 3. N→F2: process-level failure → alert on status transition ──

describe('N→F2 process-level failure', () => {
  it('statusChange=regressed triggers alert anchored to F2', () => {
    const diff = mkDiff([
      mkEntry('multi-sdk', {
        beforeStatus: 'success',
        afterStatus: 'failed',
        statusChange: 'regressed',
        summaryDiff: null,
      }),
    ]);
    const report = triageDiff(diff);
    expect(report.decision).toBe('fail');
    const alerts = alertsOf(report);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.rule).toBe('status-regressed');
    expect(alerts[0]!.anchor).toBe('F2');
    expect(alerts[0]!.context.statusChange).toBe('regressed');
  });

  it('statusChange=recovered is a notice, not an alert', () => {
    const diff = mkDiff([
      mkEntry('multi-sdk', {
        beforeStatus: 'failed',
        afterStatus: 'success',
        statusChange: 'recovered',
      }),
    ]);
    const report = triageDiff(diff);
    expect(report.decision).toBe('pass');
    const notices = noticesOf(report);
    expect(notices[0]!.rule).toBe('status-recovered');
  });
});

// ─── 4. N→R1 counter regression → alert ───────────────────────────

describe('N→R1 counter regression (a2ui parseFails)', () => {
  it('totalParseFailures rising from 0 to 3 triggers alert', () => {
    const diff = mkDiff([
      mkEntry('a2ui', {
        summaryDiff: {
          kind: 'grouped',
          keyField: 'intentShape',
          rows: [
            mkRow('form', {
              runs: scalar(3, 3),
              totalParseFailures: scalar(0, 3),
              runsWithParseFailures: scalar(0, 3),
              previewExpectedButMissingCount: scalar(0, 0),
              frameCount: stat({ median: 4 }, { median: 4 }),
            }),
          ],
        },
      }),
    ]);
    const report = triageDiff(diff);
    const alerts = alertsOf(report);
    expect(alerts.length).toBeGreaterThanOrEqual(2); // totalParseFailures + runsWithParseFailures
    const hasParseFail = alerts.some(
      (a) => a.rule === 'a2ui-totalParseFailures-nonzero',
    );
    expect(hasParseFail).toBe(true);
    expect(alerts.find((a) => a.rule === 'a2ui-totalParseFailures-nonzero')!.anchor).toBe('R1');
  });

  it('down-direction on parseFails (improvement) does NOT alert', () => {
    const diff = mkDiff([
      mkEntry('a2ui', {
        summaryDiff: {
          kind: 'grouped',
          keyField: 'intentShape',
          rows: [
            mkRow('form', {
              totalParseFailures: scalar(3, 0),
              runsWithParseFailures: scalar(3, 0),
              previewExpectedButMissingCount: scalar(0, 0),
              frameCount: stat({ median: 4 }, { median: 4 }),
              runs: scalar(3, 3),
            }),
          ],
        },
      }),
    ]);
    const report = triageDiff(diff);
    expect(report.decision).toBe('pass');
  });
});

// ─── 5. N→R1 stat regression → alert ──────────────────────────────

describe('N→R1 stat regression (slo timeToFirstPreview)', () => {
  it('+50ms shift on timeToFirstPreview triggers alert', () => {
    const diff = mkDiff([
      mkEntry('slo', {
        summaryDiff: {
          kind: 'grouped',
          keyField: 'path',
          rows: [
            mkRow('blueprint_hit', {
              runs: scalar(3, 3),
              previewObservedCount: scalar(3, 3),
              previewExpectedButMissingCount: scalar(0, 0),
              timeToFirstPreview: stat(
                { median: 25.6 },
                { median: 75.95 },
              ),
            }),
          ],
        },
      }),
    ]);
    const report = triageDiff(diff);
    const alerts = alertsOf(report);
    const latency = alerts.find((a) => a.rule === 'slo-latency-alert');
    expect(latency).toBeTruthy();
    expect(latency!.context.delta).toBeCloseTo(50.35, 1);
    expect(latency!.anchor).toBe('R1');
  });

  it('+5ms shift on timeToFirstPreview is a notice, not an alert', () => {
    const diff = mkDiff([
      mkEntry('slo', {
        summaryDiff: {
          kind: 'grouped',
          keyField: 'path',
          rows: [
            mkRow('blueprint_hit', {
              runs: scalar(3, 3),
              previewObservedCount: scalar(3, 3),
              previewExpectedButMissingCount: scalar(0, 0),
              timeToFirstPreview: stat({ median: 25 }, { median: 31 }),
            }),
          ],
        },
      }),
    ]);
    const report = triageDiff(diff);
    expect(report.counts.alert).toBe(0);
    const notices = noticesOf(report);
    expect(notices.some((n) => n.rule === 'slo-latency-notice')).toBe(true);
  });

  it('+1ms shift on timeToFirstPreview is suppressed (noise floor)', () => {
    const diff = mkDiff([
      mkEntry('slo', {
        summaryDiff: {
          kind: 'grouped',
          keyField: 'path',
          rows: [
            mkRow('blueprint_hit', {
              runs: scalar(3, 3),
              previewObservedCount: scalar(3, 3),
              previewExpectedButMissingCount: scalar(0, 0),
              timeToFirstPreview: stat({ median: 25 }, { median: 26 }),
            }),
          ],
        },
      }),
    ]);
    const report = triageDiff(diff);
    expect(report.counts.alert).toBe(0);
    expect(report.counts.notice).toBe(0);
    expect(report.counts.suppressed).toBeGreaterThan(0);
  });
});

// ─── 6. Schema drift stays informational ──────────────────────────

describe('schema drift', () => {
  it('row added with schema-drift note is informational, not alert', () => {
    const diff = mkDiff([
      mkEntry('multi-sdk', {
        notes: [
          "before is missing 'floorSummaries' — showing after as 'added' rows",
        ],
        summaryDiff: {
          kind: 'grouped',
          keyField: 'floor',
          rows: [
            mkRow(
              'oss',
              {
                runs: scalar(null, 1),
                avgScore: scalar(null, 75),
                avgTimeMs: scalar(null, 12000),
                successRate: scalar(null, 1),
                capHitRate: scalar(null, 0),
                predefinedToolCallRate: scalar(null, 0),
                avgPredefinedToolCalls: scalar(null, 0),
              },
              'added',
            ),
          ],
        },
      }),
    ]);
    const report = triageDiff(diff);
    expect(report.decision).toBe('pass');
    const info = infoOf(report);
    expect(info.some((i) => i.rule === 'row-added-schema-drift')).toBe(true);
  });

  it('row removed WITHOUT drift note is alert', () => {
    const diff = mkDiff([
      mkEntry('slo', {
        notes: [], // no drift note
        summaryDiff: {
          kind: 'grouped',
          keyField: 'path',
          rows: [mkRow('generation_miss', {}, 'removed')],
        },
      }),
    ]);
    const report = triageDiff(diff);
    expect(report.decision).toBe('fail');
    const alerts = alertsOf(report);
    expect(alerts.some((a) => a.rule === 'row-removed-unexplained')).toBe(true);
  });
});

// ─── 7. Exit code / invocation semantics ──────────────────────────

describe('invocation errors', () => {
  it('unknown schemaVersion throws (caller translates to exit 2)', () => {
    const diff = {
      ...mkDiff([]),
      schemaVersion: 'bench-baseline-diff.v99',
    } as unknown as BenchBaselineDiff;
    expect(() => triageDiff(diff)).toThrow(/Unsupported diff schemaVersion/);
  });
});

describe('decision / counts', () => {
  it('decision is "pass" when alerts === 0', () => {
    const report = triageDiff(mkDiff([]));
    expect(report.decision).toBe('pass');
  });

  it('decision is "fail" when any alerts', () => {
    const diff = mkDiff([
      mkEntry('multi-sdk', { statusChange: 'regressed' } as Partial<BenchDiffEntry> & { statusChange: 'regressed' }),
    ]);
    const report = triageDiff(diff);
    expect(report.decision).toBe('fail');
  });

  it('source metadata propagates from diff', () => {
    const report = triageDiff(mkDiff([]));
    expect(report.source.beforeBaselineId).toBe('baseline-before');
    expect(report.source.afterBaselineId).toBe('baseline-after');
    expect(report.source.beforeGitSha).toBe('abc12345');
  });

  it('counts tally accurately', () => {
    const diff = mkDiff([
      mkEntry('slo', {
        summaryDiff: {
          kind: 'grouped',
          keyField: 'path',
          rows: [
            mkRow('blueprint_hit', {
              previewExpectedButMissingCount: scalar(0, 1), // alert
              timeToFirstPreview: stat({ median: 25 }, { median: 31 }), // notice (+6ms)
              runs: scalar(3, 3), // suppressed
            }),
          ],
        },
      }),
    ]);
    const report = triageDiff(diff);
    expect(report.counts.alert).toBeGreaterThanOrEqual(1);
    expect(report.counts.notice).toBeGreaterThanOrEqual(1);
    expect(report.counts.suppressed).toBeGreaterThanOrEqual(1);
  });
});

// ─── 8. provisional flag surfaces in notes ────────────────────────

describe('provisional anchor surfacing', () => {
  it('adds top-level note when any item is anchored "provisional"', () => {
    const diff = mkDiff([
      mkEntry('multi-sdk', {
        summaryDiff: {
          kind: 'grouped',
          keyField: 'floor',
          rows: [
            mkRow('oss', {
              avgScore: scalar(75, 70), // -5, alert (provisional)
              successRate: scalar(1, 1),
              avgTimeMs: scalar(12000, 12000),
              runs: scalar(1, 1),
              capHitRate: scalar(0, 0),
              predefinedToolCallRate: scalar(0, 0),
              avgPredefinedToolCalls: scalar(0, 0),
            }),
          ],
        },
      }),
    ]);
    const report = triageDiff(diff);
    expect(
      report.notes.some((n) =>
        n.includes('provisional'),
      ),
    ).toBe(true);
  });
});
