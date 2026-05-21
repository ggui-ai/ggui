/**
 * Null propagation tests for the A2UI v0 schema derivations.
 * Load-bearing because every aggregation depends on `deriveA2uiMetrics`
 * honoring null-as-signal across every combination of absent stamps.
 */

import { describe, expect, it } from 'vitest';
import {
  deriveA2uiMetrics,
  type A2uiCheckpoints,
  type A2uiFrameAccounting,
} from './types.js';

const baseCheckpoints: A2uiCheckpoints = {
  startedAt: 100,
  firstFrameAt: 110,
  previewFinalizedAt: 150,
  handoffGapMs: null,
};

const baseFrames: A2uiFrameAccounting = {
  frameCount: 4,
  parsePassCount: 4,
  parseFailCount: 0,
};

describe('deriveA2uiMetrics — happy path', () => {
  it('computes deltas from startedAt when all stamps present', () => {
    const d = deriveA2uiMetrics(baseCheckpoints, baseFrames);
    expect(d.timeToFirstFrame).toBe(10);
    expect(d.timeToPreviewFinalize).toBe(50);
    expect(d.parsePassRate).toBe(1);
    expect(d.framesBeforeFinalize).toBe(4);
  });
});

describe('deriveA2uiMetrics — null propagation', () => {
  it('firstFrameAt null → timeToFirstFrame null; other derives unaffected', () => {
    const d = deriveA2uiMetrics(
      { ...baseCheckpoints, firstFrameAt: null },
      baseFrames,
    );
    expect(d.timeToFirstFrame).toBeNull();
    expect(d.timeToPreviewFinalize).toBe(50);
    expect(d.framesBeforeFinalize).toBe(4);
  });

  it('previewFinalizedAt null → framesBeforeFinalize null too', () => {
    const d = deriveA2uiMetrics(
      { ...baseCheckpoints, previewFinalizedAt: null },
      baseFrames,
    );
    expect(d.timeToPreviewFinalize).toBeNull();
    // framesBeforeFinalize is null because finalize didn't happen,
    // NOT zero — "we didn't finalize" is different from "we finalized
    // with 0 frames."
    expect(d.framesBeforeFinalize).toBeNull();
  });

  it('both preview stamps null — oss_miss-like absence', () => {
    const d = deriveA2uiMetrics(
      { ...baseCheckpoints, firstFrameAt: null, previewFinalizedAt: null },
      { frameCount: 0, parsePassCount: 0, parseFailCount: 0 },
    );
    expect(d.timeToFirstFrame).toBeNull();
    expect(d.timeToPreviewFinalize).toBeNull();
    expect(d.framesBeforeFinalize).toBeNull();
    // parsePassRate null (0/0 is not 1.0 — don't synthesize success)
    expect(d.parsePassRate).toBeNull();
  });
});

describe('deriveA2uiMetrics — parse pass rate', () => {
  it('frameCount > 0 with zero parse fails → rate = 1', () => {
    const d = deriveA2uiMetrics(baseCheckpoints, {
      frameCount: 4,
      parsePassCount: 4,
      parseFailCount: 0,
    });
    expect(d.parsePassRate).toBe(1);
  });

  it('parse fails present → rate reflects real fraction', () => {
    const d = deriveA2uiMetrics(baseCheckpoints, {
      frameCount: 4,
      parsePassCount: 3,
      parseFailCount: 1,
    });
    expect(d.parsePassRate).toBe(0.75);
  });

  it('all parse fails → rate = 0 (NOT null — we saw frames)', () => {
    const d = deriveA2uiMetrics(baseCheckpoints, {
      frameCount: 4,
      parsePassCount: 0,
      parseFailCount: 4,
    });
    expect(d.parsePassRate).toBe(0);
  });

  it('frameCount === 0 → rate null (0/0 is not 1.0)', () => {
    const d = deriveA2uiMetrics(
      { ...baseCheckpoints, firstFrameAt: null, previewFinalizedAt: null },
      { frameCount: 0, parsePassCount: 0, parseFailCount: 0 },
    );
    expect(d.parsePassRate).toBeNull();
  });
});

describe('deriveA2uiMetrics — handoffGapMs always null in v0', () => {
  it('cannot be anything but null — schema pin', () => {
    // Type system enforces this at compile time (typed as `null`,
    // not `number | null`), runtime pin is extra defense.
    const d = deriveA2uiMetrics(baseCheckpoints, baseFrames);
    expect(baseCheckpoints.handoffGapMs).toBeNull();
    expect('timeToFinalVisible' in d).toBe(false); // not a field
  });
});
