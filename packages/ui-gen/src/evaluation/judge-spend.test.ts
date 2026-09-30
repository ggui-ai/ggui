import { describe, expect, it } from 'vitest';
import { judgedFrameTokens } from './judge-spend.js';

/**
 * ggui#1640 — a judged frame's spend is ONE sum over every leg. The compile-time half (every `*Tokens` member of the
 * result types is listed) lives in `judge-spend.ts`; this pins the arithmetic and the leg that was once missed.
 */
describe('judgedFrameTokens', () => {
  it('adds the report-only criteria call to the scoring calls', () => {
    expect(judgedFrameTokens({ inputTokens: 3414, outputTokens: 1766, criteriaTokens: { inputTokens: 2873, outputTokens: 1009 } })).toEqual({
      inputTokens: 6287,
      outputTokens: 2775,
    });
  });

  it('is the scoring calls alone when no criteria call ran', () => {
    expect(judgedFrameTokens({ inputTokens: 100, outputTokens: 20 })).toEqual({ inputTokens: 100, outputTokens: 20 });
  });

  it('reads an evaluation that reported no scoring tokens as zero on that leg, never NaN', () => {
    expect(judgedFrameTokens({ criteriaTokens: { inputTokens: 7, outputTokens: 5 } })).toEqual({ inputTokens: 7, outputTokens: 5 });
    expect(judgedFrameTokens({})).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});
