/**
 * Reporter meta-tests — pin the stdout reporter's call order +
 * formatter output shape. Tests capture output via the `write`
 * option rather than spying on `process.stdout.write`.
 */
import { describe, expect, it } from 'vitest';

import {
  createDefaultReporter,
  formatFailures,
  formatScorecard,
  formatSkips,
  formatSummary,
} from './reporter.js';
import type { ConformanceResult } from './run-conformance.js';

const EMPTY_RESULT: ConformanceResult = {
  passed: [],
  failed: [],
  skipped: [],
  totalMs: 0,
};

describe('createDefaultReporter', () => {
  it('emits onStart → per-fixture → onComplete in order', () => {
    const lines: string[] = [];
    const reporter = createDefaultReporter({ write: (l) => lines.push(l) });

    reporter.onStart?.(2);
    reporter.onFixturePass?.('fixture-a', 12);
    reporter.onFixtureFail?.({
      name: 'fixture-b',
      criterion: 'Contract #3',
      expected: 'ack',
      received: 'error',
      message: 'subscribe failed',
    });
    reporter.onFixtureSkip?.('fixture-c', 'no host provided');
    reporter.onComplete?.({
      passed: ['fixture-a'],
      failed: [
        {
          name: 'fixture-b',
          criterion: 'Contract #3',
          expected: 'ack',
          received: 'error',
          message: 'subscribe failed',
        },
      ],
      skipped: [{ name: 'fixture-c', reason: 'no host provided' }],
      totalMs: 42,
    });

    const joined = lines.join('\n');
    expect(joined).toContain('driving 2 fixture(s)');
    expect(joined).toContain('PASS');
    expect(joined).toContain('fixture-a');
    expect(joined).toContain('FAIL');
    expect(joined).toContain('fixture-b');
    expect(joined).toContain('subscribe failed');
    expect(joined).toContain('SKIP');
    expect(joined).toContain('fixture-c');
    expect(joined).toContain('Passed:');
    expect(joined).toContain('Failed:');
    expect(joined).toContain('(42ms)');
  });

  it('streaming: false suppresses per-fixture output', () => {
    const lines: string[] = [];
    const reporter = createDefaultReporter({
      write: (l) => lines.push(l),
      streaming: false,
    });
    reporter.onStart?.(5);
    reporter.onFixturePass?.('fixture-a', 1);
    reporter.onFixtureSkip?.('fixture-b', 'reason');
    // Only onComplete emits when streaming is off.
    expect(lines).toEqual([]);
    reporter.onComplete?.(EMPTY_RESULT);
    expect(lines.length).toBeGreaterThan(0); // summary block printed
  });

  it('truncates overly long skip reasons to 80 chars', () => {
    const lines: string[] = [];
    const reporter = createDefaultReporter({ write: (l) => lines.push(l) });
    const longReason = 'x'.repeat(200);
    reporter.onFixtureSkip?.('fixture-a', longReason);
    const skipLine = lines.find((l) => l.includes('fixture-a'));
    expect(skipLine).toBeDefined();
    expect(skipLine!.includes('…')).toBe(true);
  });
});

describe('formatScorecard', () => {
  it('omits contract with zero fixtures in the result', () => {
    const output = formatScorecard(EMPTY_RESULT);
    // With no fixtures, no rows are printed.
    expect(output).toBe('');
  });

  it('groups pass/fail/skip counts by contract slug', () => {
    const result: ConformanceResult = {
      passed: ['bootstrap-success'],
      failed: [],
      skipped: [],
      totalMs: 10,
    };
    const output = formatScorecard(result);
    expect(output).toContain('bootstrap-protocol');
    expect(output).toContain('1/1 pass');
  });
});

describe('formatSummary', () => {
  it('prints the passed/failed/skipped/total counts + elapsed', () => {
    const output = formatSummary({
      passed: ['a', 'b'],
      failed: [
        {
          name: 'c',
          criterion: 'x',
          expected: null,
          received: null,
          message: 'x',
        },
      ],
      skipped: [{ name: 'd', reason: 'x' }],
      totalMs: 123,
    });
    expect(output).toContain('Passed:     2');
    expect(output).toContain('Failed:     1');
    expect(output).toContain('Skipped:    1');
    expect(output).toContain('Total:      4');
    expect(output).toContain('(123ms)');
  });
});

describe('formatFailures', () => {
  it('returns empty string when no failures', () => {
    expect(formatFailures([])).toBe('');
  });

  it('emits one block per failure with expected + received payloads', () => {
    const output = formatFailures([
      {
        name: 'fixture-a',
        criterion: 'Contract #3 defined failure modes',
        expected: { code: 'CONTRACT_VIOLATION' },
        received: { code: 'SCHEMA_VIOLATION' },
        message: 'code mismatch',
      },
    ]);
    expect(output).toContain('fixture-a');
    expect(output).toContain('Contract #3');
    expect(output).toContain('CONTRACT_VIOLATION');
    expect(output).toContain('SCHEMA_VIOLATION');
    expect(output).toContain('code mismatch');
  });
});

describe('formatSkips', () => {
  it('returns empty string when no skips', () => {
    expect(formatSkips([])).toBe('');
  });

  it('emits one block per skip with reason verbatim', () => {
    const output = formatSkips([{ name: 'fixture-a', reason: 'no host provided' }]);
    expect(output).toContain('fixture-a');
    expect(output).toContain('no host provided');
  });
});
