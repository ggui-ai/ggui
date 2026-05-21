import { describe, it, expect } from 'vitest';
import {
  formatScore,
  formatCostUsd,
  formatDurationMs,
  formatPercent,
  formatDate,
} from './format';

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
