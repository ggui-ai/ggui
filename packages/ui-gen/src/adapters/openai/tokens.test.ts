import { describe, it, expect } from 'vitest';
import { splitOpenAiUsage } from './tokens';

describe('splitOpenAiUsage (ggui#1186)', () => {
  it('subtracts the cached subset from OpenAI cache-inclusive input', () => {
    // OpenAI reports input_tokens = 1000 INCLUDING 300 cached.
    const r = splitOpenAiUsage(1000, 50, 300);
    expect(r.tokens.input).toBe(700); // non-cached only
    expect(r.cacheReadTokens).toBe(300);
    expect(r.tokens.output).toBe(50);
    // total footprint = non-cached + cacheRead + output
    expect(r.tokens.total).toBe(1050);
  });

  it('reports zero cache reads when nothing was cached', () => {
    const r = splitOpenAiUsage(1000, 50, 0);
    expect(r.tokens.input).toBe(1000);
    expect(r.cacheReadTokens).toBe(0);
    expect(r.tokens.total).toBe(1050);
  });

  it('handles a fully-cached prompt (all input tokens cached)', () => {
    const r = splitOpenAiUsage(1000, 50, 1000);
    expect(r.tokens.input).toBe(0);
    expect(r.cacheReadTokens).toBe(1000);
    expect(r.tokens.total).toBe(1050);
  });

  it('clamps a malformed report where cached exceeds input (no double-count, no negative)', () => {
    const r = splitOpenAiUsage(1000, 50, 1500);
    expect(r.cacheReadTokens).toBe(1000);
    expect(r.tokens.input).toBe(0);
    expect(r.tokens.total).toBe(1050);
  });

  it('never double-counts: input + cacheRead + output always equals total', () => {
    for (const [inc, out, cached] of [
      [0, 0, 0],
      [500, 20, 0],
      [500, 20, 500],
      [500, 20, 123],
      [500, 20, 9999],
    ] as const) {
      const r = splitOpenAiUsage(inc, out, cached);
      expect(r.tokens.input + r.cacheReadTokens + r.tokens.output).toBe(r.tokens.total);
    }
  });
});
