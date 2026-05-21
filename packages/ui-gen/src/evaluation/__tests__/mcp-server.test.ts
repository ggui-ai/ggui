import { describe, it, expect } from 'vitest';
import { createEvaluationToolsServer, computeEvaluationScore } from '../mcp-server';
import type { EvaluateScoreInput } from '../mcp-server';
import type { EvaluationResult } from '../types';

describe('createEvaluationToolsServer', () => {
  it('creates a server object with expected shape', () => {
    const server = createEvaluationToolsServer();
    expect(server).toBeDefined();
    // SDK MCP servers have type: 'sdk' and a name
    const serverAny = server as Record<string, unknown>;
    expect(serverAny.type).toBe('sdk');
    expect(serverAny.name).toBe('eval-tools');
  });

  it('creates a server with custom threshold', () => {
    const server = createEvaluationToolsServer(80);
    expect(server).toBeDefined();
  });
});

describe('computeEvaluationScore', () => {
  /** Convenience: build input with defaults */
  function makeInput(overrides?: Partial<EvaluateScoreInput>): EvaluateScoreInput {
    return {
      completeness: 70,
      visualPolish: 70,
      interactivity: 70,
      accessibility: 70,
      codeQuality: 70,
      issues: [],
      ...overrides,
    };
  }

  // --- Return type shape ---

  it('returns a valid EvaluationResult shape', () => {
    const result: EvaluationResult = computeEvaluationScore(makeInput(), 70);

    expect(typeof result.passed).toBe('boolean');
    expect(typeof result.finalScore).toBe('number');
    expect(typeof result.dimensions.completeness).toBe('number');
    expect(typeof result.dimensions.visualPolish).toBe('number');
    expect(typeof result.dimensions.interactivity).toBe('number');
    expect(typeof result.dimensions.accessibility).toBe('number');
    expect(typeof result.dimensions.codeQuality).toBe('number');
    expect(Array.isArray(result.issues)).toBe(true);
  });

  // --- Average computation ---

  it('computes average correctly for all equal scores', () => {
    const result = computeEvaluationScore(
      makeInput({ completeness: 80, visualPolish: 80, interactivity: 80, accessibility: 80, codeQuality: 80 }),
      70
    );
    expect(result.finalScore).toBe(80);
  });

  it('computes average correctly for mixed scores', () => {
    const result = computeEvaluationScore(
      makeInput({ completeness: 90, visualPolish: 60, interactivity: 70, accessibility: 80, codeQuality: 50 }),
      70
    );
    // (90+60+70+80+50)/5 = 70
    expect(result.finalScore).toBe(70);
  });

  it('rounds score to one decimal place', () => {
    const result = computeEvaluationScore(
      makeInput({ completeness: 73, visualPolish: 82, interactivity: 65, accessibility: 91, codeQuality: 78 }),
      70
    );
    // (73+82+65+91+78)/5 = 389/5 = 77.8
    expect(result.finalScore).toBe(77.8);
  });

  // --- Pass/fail threshold ---

  it('passes when average equals threshold', () => {
    const result = computeEvaluationScore(makeInput(), 70);
    expect(result.finalScore).toBe(70);
    expect(result.passed).toBe(true);
  });

  it('fails when average is below threshold', () => {
    const result = computeEvaluationScore(
      makeInput({ completeness: 50, visualPolish: 60, interactivity: 40, accessibility: 70, codeQuality: 55 }),
      70
    );
    // (50+60+40+70+55)/5 = 55
    expect(result.finalScore).toBe(55);
    expect(result.passed).toBe(false);
  });

  it('respects custom pass threshold', () => {
    // Score 75 with threshold 80 → fail
    const result = computeEvaluationScore(
      makeInput({ completeness: 75, visualPolish: 75, interactivity: 75, accessibility: 75, codeQuality: 75 }),
      80
    );
    expect(result.finalScore).toBe(75);
    expect(result.passed).toBe(false);
  });

  // --- Edge cases ---

  it('handles zero scores', () => {
    const result = computeEvaluationScore(
      makeInput({ completeness: 0, visualPolish: 0, interactivity: 0, accessibility: 0, codeQuality: 0 }),
      70
    );
    expect(result.finalScore).toBe(0);
    expect(result.passed).toBe(false);
  });

  it('handles perfect scores', () => {
    const result = computeEvaluationScore(
      makeInput({ completeness: 100, visualPolish: 100, interactivity: 100, accessibility: 100, codeQuality: 100 }),
      70
    );
    expect(result.finalScore).toBe(100);
    expect(result.passed).toBe(true);
  });

  // --- Dimensions passthrough ---

  it('passes through dimension scores unchanged', () => {
    const result = computeEvaluationScore(
      makeInput({ completeness: 42, visualPolish: 88, interactivity: 63, accessibility: 91, codeQuality: 77 }),
      70
    );
    expect(result.dimensions.completeness).toBe(42);
    expect(result.dimensions.visualPolish).toBe(88);
    expect(result.dimensions.interactivity).toBe(63);
    expect(result.dimensions.accessibility).toBe(91);
    expect(result.dimensions.codeQuality).toBe(77);
  });

  // --- Issues ---

  it('handles empty issues array', () => {
    const result = computeEvaluationScore(makeInput({ issues: [] }), 70);
    expect(result.issues).toEqual([]);
  });

  it('preserves issues with all severity levels', () => {
    const issues = [
      { dimension: 'completeness', description: 'Missing feature', severity: 'critical' as const, fix: 'Add it' },
      { dimension: 'accessibility', description: 'No ARIA labels', severity: 'major' as const, fix: 'Add labels' },
      { dimension: 'codeQuality', description: 'Minor naming issue', severity: 'minor' as const, fix: 'Rename var' },
    ];

    const result = computeEvaluationScore(makeInput({ issues }), 70);

    expect(result.issues).toHaveLength(3);
    expect(result.issues[0]).toEqual(issues[0]);
    expect(result.issues[1]).toEqual(issues[1]);
    expect(result.issues[2]).toEqual(issues[2]);
  });

  // --- Critique ---

  it('includes critique when provided', () => {
    const result = computeEvaluationScore(
      makeInput({ critique: 'Good overall but could improve spacing.' }),
      70
    );
    expect(result.critique).toBe('Good overall but could improve spacing.');
  });

  it('omits critique when not provided', () => {
    const result = computeEvaluationScore(makeInput(), 70);
    expect(result.critique).toBeUndefined();
  });

  it('omits critique when empty string', () => {
    // Empty string is falsy, so critique should be omitted
    const result = computeEvaluationScore(makeInput({ critique: '' }), 70);
    expect(result.critique).toBeUndefined();
  });
});
