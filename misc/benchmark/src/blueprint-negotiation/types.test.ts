/**
 * Tests for the derivation + outcome-classification helpers. Pin
 * the rules that make the bench's four-way split load-bearing.
 */

import { describe, expect, it } from 'vitest';
import { classifyOutcome } from './runner.js';
import {
  deriveNegotiationMetrics,
  type NegotiationRunTags,
} from './types.js';

function mkTags(overrides: Partial<NegotiationRunTags> = {}): NegotiationRunTags {
  return {
    caseId: 'x',
    registryMode: 'hosted',
    expectedOutcome: 'hit',
    observedOutcome: 'hit',
    expectedBlueprintId: 'p_x',
    observedBlueprintId: 'p_x',
    arbitrationObserved: false,
    confidence: null,
    errorClass: null,
    ...overrides,
  };
}

describe('deriveNegotiationMetrics', () => {
  it('computes decisionTimeMs from checkpoints', () => {
    const d = deriveNegotiationMetrics(
      { decisionStartedAt: 100, decisionCompletedAt: 175 },
      mkTags(),
    );
    expect(d.decisionTimeMs).toBe(75);
  });

  it('outcomeCorrect — hit+matching id → true', () => {
    const d = deriveNegotiationMetrics(
      { decisionStartedAt: 0, decisionCompletedAt: 1 },
      mkTags({
        expectedOutcome: 'hit',
        observedOutcome: 'hit',
        expectedBlueprintId: 'p_x',
        observedBlueprintId: 'p_x',
      }),
    );
    expect(d.outcomeCorrect).toBe(true);
  });

  it('outcomeCorrect — hit+wrong id → false', () => {
    const d = deriveNegotiationMetrics(
      { decisionStartedAt: 0, decisionCompletedAt: 1 },
      mkTags({
        expectedOutcome: 'hit',
        observedOutcome: 'hit',
        expectedBlueprintId: 'p_x',
        observedBlueprintId: 'p_y',
      }),
    );
    // This is a degenerate case — the runner should produce
    // observedOutcome='wrong_hit' for mismatched ids — but the
    // derivation must not incorrectly report correct if it somehow
    // receives hit+hit with mismatched ids.
    expect(d.outcomeCorrect).toBe(false);
  });

  it('outcomeCorrect — clean miss on miss-expected → true', () => {
    const d = deriveNegotiationMetrics(
      { decisionStartedAt: 0, decisionCompletedAt: 1 },
      mkTags({
        expectedOutcome: 'miss',
        observedOutcome: 'miss',
        expectedBlueprintId: null,
        observedBlueprintId: null,
      }),
    );
    expect(d.outcomeCorrect).toBe(true);
  });

  it('outcomeCorrect — wrong_hit → false (never correct, even if expected hit)', () => {
    const d = deriveNegotiationMetrics(
      { decisionStartedAt: 0, decisionCompletedAt: 1 },
      mkTags({
        expectedOutcome: 'hit',
        observedOutcome: 'wrong_hit',
        expectedBlueprintId: 'p_x',
        observedBlueprintId: 'p_y',
      }),
    );
    expect(d.outcomeCorrect).toBe(false);
  });

  it('outcomeCorrect — error → false', () => {
    const d = deriveNegotiationMetrics(
      { decisionStartedAt: 0, decisionCompletedAt: 1 },
      mkTags({ observedOutcome: 'error', errorClass: 'other' }),
    );
    expect(d.outcomeCorrect).toBe(false);
  });
});

describe('classifyOutcome', () => {
  it('null observedBlueprintId → miss, regardless of expected', () => {
    expect(
      classifyOutcome({
        observedBlueprintId: null,
        expectedBlueprintId: null,
        expectedOutcome: 'miss',
      }),
    ).toBe('miss');
    expect(
      classifyOutcome({
        observedBlueprintId: null,
        expectedBlueprintId: 'p_x',
        expectedOutcome: 'hit',
      }),
    ).toBe('miss');
  });

  it('observed hit on miss-expected → wrong_hit', () => {
    expect(
      classifyOutcome({
        observedBlueprintId: 'p_unexpected',
        expectedBlueprintId: null,
        expectedOutcome: 'miss',
      }),
    ).toBe('wrong_hit');
  });

  it('observed hit on hit-expected, id matches → hit', () => {
    expect(
      classifyOutcome({
        observedBlueprintId: 'p_x',
        expectedBlueprintId: 'p_x',
        expectedOutcome: 'hit',
      }),
    ).toBe('hit');
  });

  it('observed hit on hit-expected, id DIFFERENT → wrong_hit (not miss)', () => {
    // Critical invariant — wrong_hit must NOT be collapsed to miss.
    expect(
      classifyOutcome({
        observedBlueprintId: 'p_wrong',
        expectedBlueprintId: 'p_x',
        expectedOutcome: 'hit',
      }),
    ).toBe('wrong_hit');
  });
});
