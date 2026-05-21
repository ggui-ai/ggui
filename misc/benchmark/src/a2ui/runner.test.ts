/**
 * Runner tests — drive the real deterministic emitter through the
 * real `runProvisionalPreview` orchestrator (via
 * `kickoffProvisionalPreview`) and verify:
 *   - all 3 seed cases produce distinct shape tags
 *   - parse pass counts match the expected 3-frame emitter output
 *     (deterministic.ts emits: createSurface → skeleton → enriched)
 *   - firstFrameAt + previewFinalizedAt populate on the happy path
 *   - handoffGapMs stays null (reserved in v0)
 *   - case with `emitterEnabled: false` produces honest nulls
 *     (the reserved future-path branch)
 */

import { describe, expect, it } from 'vitest';
import { runA2uiCase } from './runner.js';
import { A2UI_V0_CASES } from './corpus.js';

function makeClock(start = 1000) {
  let t = start;
  return () => t++;
}

describe('runA2uiCase — form shape', () => {
  it('records firstFrameAt + 3 frames, parse pass = frame count, zero fails', async () => {
    const kase = A2UI_V0_CASES.find((c) => c.intentShape === 'form')!;
    const r = await runA2uiCase(kase, 0, { now: makeClock() });

    expect(r.tags.intentShape).toBe('form');
    expect(r.tags.previewExpected).toBe(true);
    expect(r.tags.previewObserved).toBe(true);
    expect(r.tags.finalizeObserved).toBe(true);

    // Deterministic emitter happy-path: 3 frames
    // (createSurface → root skeleton → enriched layout).
    expect(r.frames.frameCount).toBe(3);
    expect(r.frames.parsePassCount).toBe(3);
    expect(r.frames.parseFailCount).toBe(0);
    expect(r.frames.parsePassCount + r.frames.parseFailCount).toBe(r.frames.frameCount);

    expect(r.checkpoints.startedAt).toBeTypeOf('number');
    expect(r.checkpoints.firstFrameAt).not.toBeNull();
    expect(r.checkpoints.previewFinalizedAt).not.toBeNull();
    expect(r.checkpoints.handoffGapMs).toBeNull(); // reserved

    expect(r.derived.parsePassRate).toBe(1);
    expect(r.derived.framesBeforeFinalize).toBe(3);
    expect(r.errors).toEqual([]);
  });
});

describe('runA2uiCase — list shape', () => {
  it('distinct shape tag + same 3-frame happy path', async () => {
    const kase = A2UI_V0_CASES.find((c) => c.intentShape === 'list')!;
    const r = await runA2uiCase(kase, 0, { now: makeClock() });

    expect(r.tags.intentShape).toBe('list');
    expect(r.frames.frameCount).toBe(3);
    expect(r.frames.parsePassCount).toBe(3);
    expect(r.checkpoints.firstFrameAt).not.toBeNull();
  });
});

describe('runA2uiCase — minimal shape (intent misses both regexes)', () => {
  it('still produces 3 frames (emitter always emits), distinct tag', async () => {
    const kase = A2UI_V0_CASES.find((c) => c.intentShape === 'minimal')!;
    const r = await runA2uiCase(kase, 0, { now: makeClock() });

    expect(r.tags.intentShape).toBe('minimal');
    // Deterministic emitter still emits skeleton frames even
    // when the pick-shell heuristic returns nothing — confirmed
    // against `deterministic.ts`.
    expect(r.frames.frameCount).toBe(3);
    expect(r.frames.parsePassCount).toBe(3);
    // Parse passes because the emitter's structure doesn't depend
    // on the shell fragments.
    expect(r.frames.parseFailCount).toBe(0);
  });
});

describe('runA2uiCase — schema consistency across shapes', () => {
  it('every case produces a fully-shaped result', async () => {
    const expectedKeys = [
      'caseId',
      'runIndex',
      'checkpoints',
      'frames',
      'tags',
      'derived',
      'parseIssueSamples',
      'errors',
    ].sort();
    for (const kase of A2UI_V0_CASES) {
      const r = await runA2uiCase(kase, 0, { now: makeClock() });
      expect(Object.keys(r).sort()).toEqual(expectedKeys);
      expect(Object.keys(r.checkpoints).sort()).toEqual(
        ['startedAt', 'firstFrameAt', 'previewFinalizedAt', 'handoffGapMs'].sort(),
      );
      expect(Object.keys(r.frames).sort()).toEqual(
        ['frameCount', 'parsePassCount', 'parseFailCount'].sort(),
      );
    }
  });
});

describe('runA2uiCase — emitterEnabled false (reserved null-as-signal branch)', () => {
  it('produces null preview stamps, zero frames, honest finalize=false', async () => {
    // Fabricate a case with the reserved branch — v0 corpus never
    // ships one, but the runner path must honor it for future corpus
    // growth.
    const reserved = {
      id: 'reserved-no-emitter',
      intentShape: 'minimal' as const,
      intent: 'test',
      emitterEnabled: false,
      previewExpected: false,
    };
    const r = await runA2uiCase(reserved, 0, { now: makeClock() });

    expect(r.checkpoints.firstFrameAt).toBeNull();
    expect(r.checkpoints.previewFinalizedAt).toBeNull();
    expect(r.frames.frameCount).toBe(0);
    expect(r.frames.parsePassCount).toBe(0);
    expect(r.frames.parseFailCount).toBe(0);
    expect(r.tags.previewObserved).toBe(false);
    expect(r.tags.finalizeObserved).toBe(false);
    expect(r.derived.parsePassRate).toBeNull();
    expect(r.derived.framesBeforeFinalize).toBeNull();
  });
});
