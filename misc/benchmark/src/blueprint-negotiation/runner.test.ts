/**
 * Runner tests — drive all 3 seed cases through the real
 * `negotiate()` path with InMemoryVectorStore + MockEmbeddingProvider
 * + stub LLMCaller. Verify the four-way outcome classification.
 */

import { describe, expect, it } from 'vitest';
import { runNegotiationCase } from './runner.js';
import { BLUEPRINT_NEGOTIATION_V0_CASES } from './corpus.js';

function makeClock(start = 1000) {
  let t = start;
  return () => t++;
}

describe('runNegotiationCase — clear hit', () => {
  it('observes a hit with matching blueprint id', async () => {
    const kase = BLUEPRINT_NEGOTIATION_V0_CASES.find(
      (c) => c.id === 'clear-hit-feedback-form',
    )!;
    const r = await runNegotiationCase(kase, 0, { now: makeClock() });

    expect(r.tags.observedOutcome).toBe('hit');
    expect(r.tags.observedBlueprintId).toBe(kase.expectedBlueprintId);
    expect(r.tags.expectedOutcome).toBe('hit');
    expect(r.derived.outcomeCorrect).toBe(true);

    // Confidence + arbitration are reserved null/false in v0.
    expect(r.tags.confidence).toBeNull();
    expect(r.tags.arbitrationObserved).toBe(false);
    expect(r.tags.errorClass).toBeNull();
    expect(r.errors).toEqual([]);
  });
});

describe('runNegotiationCase — clean miss (populated but irrelevant)', () => {
  it('observes miss when store has no relevant entries', async () => {
    const kase = BLUEPRINT_NEGOTIATION_V0_CASES.find(
      (c) => c.id === 'clean-miss-nothing-relevant',
    )!;
    const r = await runNegotiationCase(kase, 0, { now: makeClock() });

    expect(r.tags.observedOutcome).toBe('miss');
    expect(r.tags.observedBlueprintId).toBeNull();
    expect(r.tags.expectedOutcome).toBe('miss');
    expect(r.derived.outcomeCorrect).toBe(true);
  });
});

describe('runNegotiationCase — empty registry miss (success case)', () => {
  it('observes miss on empty store — this is a SUCCESS, not a failure', async () => {
    const kase = BLUEPRINT_NEGOTIATION_V0_CASES.find(
      (c) => c.id === 'empty-registry-miss',
    )!;
    const r = await runNegotiationCase(kase, 0, { now: makeClock() });

    expect(r.tags.registryMode).toBe('empty');
    expect(r.tags.observedOutcome).toBe('miss');
    expect(r.tags.observedBlueprintId).toBeNull();
    expect(r.derived.outcomeCorrect).toBe(true);
  });
});

describe('runNegotiationCase — schema consistency across all cases', () => {
  it('every case produces a fully-shaped result', async () => {
    const expectedKeys = [
      'caseId',
      'runIndex',
      'checkpoints',
      'stageLatencies',
      'tags',
      'derived',
      'errors',
    ].sort();
    const expectedTagKeys = [
      'caseId',
      'registryMode',
      'expectedOutcome',
      'observedOutcome',
      'expectedBlueprintId',
      'observedBlueprintId',
      'arbitrationObserved',
      'confidence',
      'errorClass',
    ].sort();

    for (const kase of BLUEPRINT_NEGOTIATION_V0_CASES) {
      const r = await runNegotiationCase(kase, 0, { now: makeClock() });
      expect(Object.keys(r).sort()).toEqual(expectedKeys);
      expect(Object.keys(r.tags).sort()).toEqual(expectedTagKeys);
      // decisionTimeMs is always present and non-negative.
      expect(r.derived.decisionTimeMs).toBeGreaterThanOrEqual(0);
      // confidence always null in v0.
      expect(r.tags.confidence).toBeNull();
      // arbitration always false in v0.
      expect(r.tags.arbitrationObserved).toBe(false);
    }
  });
});

describe('runNegotiationCase — stage latencies populate', () => {
  it('embeddingLatencyMs + searchLatencyMs populate on all cases', async () => {
    for (const kase of BLUEPRINT_NEGOTIATION_V0_CASES) {
      const r = await runNegotiationCase(kase, 0, { now: makeClock() });
      expect(r.stageLatencies.embeddingLatencyMs).toBeGreaterThanOrEqual(0);
      expect(r.stageLatencies.searchLatencyMs).toBeGreaterThanOrEqual(0);
      // decisionLatencyMs is 0 on fast-path hits; stub-LLM time on misses.
      expect(r.stageLatencies.decisionLatencyMs).toBeGreaterThanOrEqual(0);
    }
  });
});
