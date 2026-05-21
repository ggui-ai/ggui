/**
 * Type-level + small-pure-fn tests for the SLO schema. These pin the
 * null-propagation rule of `deriveMetrics` — load-bearing for the
 * whole "null as signal" convention.
 */

import { describe, expect, it } from 'vitest';
import { deriveMetrics, type SloCheckpoints } from './types.js';

describe('deriveMetrics', () => {
  const base: SloCheckpoints = {
    startedAt: 100,
    firstPreviewAt: 120,
    previewFinalizedAt: 150,
    finalCompiledAt: 160,
    finalDomVisibleAt: null,
  };

  it('computes deltas from startedAt when all stamps present', () => {
    const d = deriveMetrics(base);
    expect(d.timeToFirstPreview).toBe(20);
    expect(d.timeToPreviewFinalize).toBe(50);
    expect(d.timeToFinalCompiled).toBe(60);
    expect(d.timeToFinalVisible).toBeNull();
  });

  it('propagates null — firstPreviewAt null → timeToFirstPreview null', () => {
    const d = deriveMetrics({ ...base, firstPreviewAt: null });
    expect(d.timeToFirstPreview).toBeNull();
    // Others unaffected.
    expect(d.timeToPreviewFinalize).toBe(50);
    expect(d.timeToFinalCompiled).toBe(60);
  });

  it('propagates null — all preview stamps null (oss_miss shape)', () => {
    const d = deriveMetrics({
      ...base,
      firstPreviewAt: null,
      previewFinalizedAt: null,
    });
    expect(d.timeToFirstPreview).toBeNull();
    expect(d.timeToPreviewFinalize).toBeNull();
    // finalCompiledAt still ticks in oss_miss — the handler returned.
    expect(d.timeToFinalCompiled).toBe(60);
  });

  it('propagates null — finalCompiledAt null (handler threw)', () => {
    const d = deriveMetrics({ ...base, finalCompiledAt: null });
    expect(d.timeToFinalCompiled).toBeNull();
  });

  it('timeToFinalVisible is ALWAYS null in v0 — reserved checkpoint', () => {
    const d = deriveMetrics(base);
    expect(d.timeToFinalVisible).toBeNull();
  });
});
