/**
 * CLI unit tests — the exit-code mapping. Pure unit-level: no
 * subprocess, no server.
 *
 * The zero-executed guard is load-bearing for CI adopters: a run
 * where every fixture skipped (e.g. hostless CLI against the current
 * all-setup catalog) historically exited 0 and read as a green
 * conformance gate while grading nothing. Exit 2 makes that state
 * loud and distinct from a fixture failure (exit 1).
 */
import { describe, expect, it } from 'vitest';

import { exitCodeForResult } from './cli.js';
import type { ConformanceFailure, ConformanceResult } from './run-conformance.js';

function result(overrides: Partial<ConformanceResult>): ConformanceResult {
  return { passed: [], failed: [], skipped: [], totalMs: 1, ...overrides };
}

const FAILURE: ConformanceFailure = {
  name: 'action-ack-sequence',
  criterion: 'criterion',
  expected: {},
  received: {},
  message: 'mismatch',
};

describe('exitCodeForResult', () => {
  it('returns 0 when at least one fixture passed and none failed', () => {
    expect(
      exitCodeForResult(
        result({
          passed: ['bootstrap-success'],
          skipped: [{ name: 'props-update-roundtrip', reason: 'Path-B' }],
        }),
      ),
    ).toBe(0);
  });

  it('returns 1 when any fixture failed', () => {
    expect(
      exitCodeForResult(result({ passed: ['bootstrap-success'], failed: [FAILURE] })),
    ).toBe(1);
  });

  it('returns 2 when zero fixtures executed (all skipped) — never reads as success', () => {
    expect(
      exitCodeForResult(
        result({
          skipped: [
            { name: 'bootstrap-success', reason: 'no host provided' },
            { name: 'version-mismatch', reason: 'no host provided' },
          ],
        }),
      ),
    ).toBe(2);
  });

  it('returns 2 on a fully empty result (zero fixtures selected)', () => {
    expect(exitCodeForResult(result({}))).toBe(2);
  });

  it('failure outranks the zero-executed guard (exit 1 wins over exit 2)', () => {
    expect(exitCodeForResult(result({ failed: [FAILURE] }))).toBe(1);
  });
});
