/**
 * Runner tests — drive all three branches through the real render
 * handler + real provisional-preview orchestrator and verify the
 * checkpoint schema distinguishes them correctly.
 *
 * These tests ARE integration-ish (they boot an InMemoryGguiSessionStore
 * + createGguiRenderHandler end-to-end) but don't touch network or
 * LLM. Clock + sleep are injected to keep timing deterministic.
 */

import { describe, expect, it } from 'vitest';
import { runSloCase } from './runner.js';
import { SLO_V0_CASES } from './corpus.js';

/** Deterministic clock: advances 1ms per call. Tests can observe exact deltas. */
function makeClock() {
  let t = 1000;
  return {
    now: () => t++,
    peek: () => t,
  };
}

/**
 * Sleep stub that resolves immediately — timings don't matter when the
 * deterministic clock already counts ticks. The runner's spin-wait
 * for terminal outcome uses `setTimeout` directly (not `deps.sleep`),
 * so the real event loop still drains between emitter frames.
 */
const instantSleep = (_ms: number) => Promise.resolve();

describe('runSloCase — blueprint_hit', () => {
  it('records firstPreviewAt + previewFinalizedAt + single frame', async () => {
    const kase = SLO_V0_CASES.find((c) => c.path === 'blueprint_hit')!;
    const clock = makeClock();
    const result = await runSloCase(kase, 0, {
      now: clock.now,
      sleep: instantSleep,
    });

    expect(result.caseId).toBe(kase.id);
    expect(result.runIndex).toBe(0);
    expect(result.tags.path).toBe('blueprint_hit');
    expect(result.tags.usedBlueprint).toBe(true);
    expect(result.tags.usedGeneration).toBe(false);
    expect(result.tags.previewExpected).toBe(true);
    expect(result.tags.previewObserved).toBe(true);
    expect(result.tags.previewFrames).toBe(1);
    expect(result.tags.finalCompiledReliable).toBe(false); // v0 honesty

    expect(result.checkpoints.startedAt).toBeTypeOf('number');
    expect(result.checkpoints.firstPreviewAt).not.toBeNull();
    expect(result.checkpoints.previewFinalizedAt).not.toBeNull();
    expect(result.checkpoints.finalCompiledAt).not.toBeNull();
    expect(result.checkpoints.finalDomVisibleAt).toBeNull(); // reserved

    expect(result.derived.timeToFirstPreview).not.toBeNull();
    expect(result.derived.timeToFinalVisible).toBeNull();
    expect(result.errors).toEqual([]);
  });
});

describe('runSloCase — generation_miss', () => {
  it('records multiple frames + non-null preview stamps', async () => {
    const kase = SLO_V0_CASES.find((c) => c.path === 'generation_miss')!;
    const clock = makeClock();
    const result = await runSloCase(kase, 0, {
      now: clock.now,
      sleep: instantSleep,
    });

    expect(result.tags.path).toBe('generation_miss');
    expect(result.tags.usedBlueprint).toBe(false);
    expect(result.tags.usedGeneration).toBe(true);
    expect(result.tags.previewFrames).toBe(kase.emitterPlan!.frames);
    expect(result.tags.previewObserved).toBe(true);
    expect(result.checkpoints.firstPreviewAt).not.toBeNull();
    expect(result.checkpoints.previewFinalizedAt).not.toBeNull();
  });
});

describe('runSloCase — oss_miss (null as signal)', () => {
  it('records null preview stamps + zero frames, but non-null finalCompiledAt', async () => {
    const kase = SLO_V0_CASES.find((c) => c.path === 'oss_miss')!;
    const clock = makeClock();
    const result = await runSloCase(kase, 0, {
      now: clock.now,
      sleep: instantSleep,
    });

    expect(result.tags.path).toBe('oss_miss');
    expect(result.tags.usedBlueprint).toBe(false);
    expect(result.tags.usedGeneration).toBe(false);
    expect(result.tags.previewExpected).toBe(false);
    expect(result.tags.previewObserved).toBe(false);
    expect(result.tags.previewFrames).toBe(0);

    // THE load-bearing invariants for null-as-signal:
    expect(result.checkpoints.firstPreviewAt).toBeNull();
    expect(result.checkpoints.previewFinalizedAt).toBeNull();
    expect(result.derived.timeToFirstPreview).toBeNull();
    expect(result.derived.timeToPreviewFinalize).toBeNull();

    // GguiSession still succeeded — handler returned, final timestamp is real.
    expect(result.checkpoints.finalCompiledAt).not.toBeNull();
    expect(result.derived.timeToFinalCompiled).not.toBeNull();
    expect(result.errors).toEqual([]);
  });
});

describe('runSloCase — schema consistency across branches', () => {
  it('every branch produces a fully-shaped result with the same key set', async () => {
    const expectedKeys = [
      'caseId',
      'runIndex',
      'checkpoints',
      'tags',
      'derived',
      'errors',
    ].sort();
    for (const kase of SLO_V0_CASES) {
      const clock = makeClock();
      const result = await runSloCase(kase, 0, {
        now: clock.now,
        sleep: instantSleep,
      });
      expect(Object.keys(result).sort()).toEqual(expectedKeys);
      // Every checkpoint slot must be present (may be null).
      expect(Object.keys(result.checkpoints).sort()).toEqual(
        [
          'startedAt',
          'firstPreviewAt',
          'previewFinalizedAt',
          'finalCompiledAt',
          'finalDomVisibleAt',
        ].sort(),
      );
    }
  });
});
