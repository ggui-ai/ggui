import { describe, it, expect } from 'vitest';
import {
  formatScore,
  formatCostUsd,
  formatDurationMs,
  formatPercent,
  formatDate,
  judgeCoverageLine,
  criteriaCoverageLine,
} from './format';

describe('criteriaCoverageLine', () => {
  const full = [
    { criterion: 'functionality', tier: 1 as const, ran: 90, skipped: 0, unknown: 0 },
    { criterion: 'visual', tier: 2 as const, ran: 90, skipped: 0, unknown: 0 },
  ];

  it('summarizes full coverage as all criteria ran on every evaluated cell', () => {
    const line = criteriaCoverageLine({ criteriaCoverage: full });
    expect(line).toEqual({
      text: 'eval criteria: 2/2 ran on all 90 evaluated cells',
      degraded: false,
      short: [],
    });
  });

  it('names the criteria under the floor on a degraded run', () => {
    const line = criteriaCoverageLine({
      criteriaCoverage: [
        full[0]!,
        { criterion: 'visual', tier: 2, ran: 54, skipped: 30, unknown: 6 },
      ],
      criteriaCoverageDegraded: true,
    });
    expect(line?.degraded).toBe(true);
    expect(line?.short).toEqual(['visual 54/90 (60%)']);
    expect(line?.text).toBe('eval criteria: 1/2 ran on all 90 evaluated cells');
  });

  it('lists only criteria under the floor — a 94% criterion is not "low coverage"', () => {
    const line = criteriaCoverageLine({
      criteriaCoverage: [
        full[0]!,
        { criterion: 'loading', tier: 2, ran: 85, skipped: 5, unknown: 0 },
        { criterion: 'visual', tier: 2, ran: 54, skipped: 36, unknown: 0 },
      ],
      criteriaCoverageDegraded: true,
    });
    expect(line?.short).toEqual(['visual 54/90 (60%)']);
  });

  it('floors the percent so a sub-floor ratio never renders as the floor itself', () => {
    // 79/99 = 0.798 — flagged by the reporter's strict < 0.8, must not print "80%".
    const line = criteriaCoverageLine({
      criteriaCoverage: [{ criterion: 'visual', tier: 2, ran: 79, skipped: 20, unknown: 0 }],
      criteriaCoverageDegraded: true,
    });
    expect(line?.short).toEqual(['visual 79/99 (79%)']);
  });

  it('returns null for pre-instrument reports', () => {
    expect(criteriaCoverageLine({})).toBeNull();
  });
});

describe('judgeCoverageLine', () => {
  it('renders evaluated/generated with the coverage percent', () => {
    const line = judgeCoverageLine({ evaluatedCount: 24, judgeCoverage: 24 / 79, successCount: 79 });
    expect(line).toEqual({ text: 'scores from 24/79 generated cells (30%)', degraded: false });
  });

  it('marks degraded runs', () => {
    const line = judgeCoverageLine({
      evaluatedCount: 24,
      judgeCoverage: 24 / 79,
      judgeCoverageDegraded: true,
      successCount: 79,
    });
    expect(line?.degraded).toBe(true);
  });

  it('returns null for pre-field reports (no evaluatedCount)', () => {
    expect(judgeCoverageLine({ successCount: 79 })).toBeNull();
  });
});

describe('formatScore', () => {
  it('rounds to 1 decimal place', () => {
    expect(formatScore(82.456)).toBe('82.5');
    expect(formatScore(0)).toBe('0.0');
    expect(formatScore(100)).toBe('100.0');
  });

  it('returns "n/a" for negative or NaN', () => {
    expect(formatScore(-1)).toBe('n/a');
    expect(formatScore(NaN)).toBe('n/a');
  });
});

describe('formatScore null-safety', () => {
  it('renders n/a for null (historical reports carry null avgScore)', () => {
    expect(formatScore(null)).toBe('n/a');
  });
  it('renders n/a for undefined', () => {
    expect(formatScore(undefined)).toBe('n/a');
  });
  it('still renders a real score', () => {
    expect(formatScore(80)).toBe('80.0');
  });
});

describe('formatCostUsd', () => {
  it('shows $0 for exactly zero', () => {
    expect(formatCostUsd(0)).toBe('$0');
  });

  it('uses 4 decimals under $0.01', () => {
    expect(formatCostUsd(0.0042)).toBe('$0.0042');
    expect(formatCostUsd(0.001)).toBe('$0.0010');
  });

  it('uses 3 decimals under $1', () => {
    expect(formatCostUsd(0.165)).toBe('$0.165');
    expect(formatCostUsd(0.5)).toBe('$0.500');
  });

  it('uses 2 decimals at $1+', () => {
    expect(formatCostUsd(1.5)).toBe('$1.50');
    expect(formatCostUsd(12.345)).toBe('$12.35');
  });
});

describe('formatDurationMs', () => {
  it('shows ms under 1s', () => {
    expect(formatDurationMs(500)).toBe('500ms');
    expect(formatDurationMs(0)).toBe('0ms');
  });

  it('shows seconds under 1min', () => {
    expect(formatDurationMs(1500)).toBe('1.5s');
    expect(formatDurationMs(59999)).toBe('60.0s');
  });

  it('shows m+s at 1min+', () => {
    expect(formatDurationMs(60000)).toBe('1m00s');
    expect(formatDurationMs(72684)).toBe('1m13s');
    expect(formatDurationMs(125000)).toBe('2m05s');
  });
});

describe('formatPercent', () => {
  it('rounds to whole percent', () => {
    expect(formatPercent(0.92)).toBe('92%');
    expect(formatPercent(0.916)).toBe('92%');
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(1)).toBe('100%');
  });
});

describe('formatDate', () => {
  it('passes through YYYY-MM-DD unchanged', () => {
    expect(formatDate('2026-05-06')).toBe('2026-05-06');
  });
});
