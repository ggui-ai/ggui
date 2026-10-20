import { describe, it, expect } from 'vitest';
import { splitOpenAiUsage } from './tokens';

describe('splitOpenAiUsage (ggui#1186)', () => {
  it('subtracts the cached subset from OpenAI cache-inclusive input', () => {
    // OpenAI reports input_tokens = 1000 INCLUDING 300 cached.
    const r = splitOpenAiUsage(1000, 50, 300, 0);
    expect(r.tokens.input).toBe(700); // non-cached only
    expect(r.cacheReadTokens).toBe(300);
    expect(r.tokens.output).toBe(50);
    // total footprint = non-cached + cacheRead + output
    expect(r.tokens.total).toBe(1050);
  });

  it('reports zero cache reads when nothing was cached', () => {
    const r = splitOpenAiUsage(1000, 50, 0, 0);
    expect(r.tokens.input).toBe(1000);
    expect(r.cacheReadTokens).toBe(0);
    expect(r.tokens.total).toBe(1050);
  });

  it('handles a fully-cached prompt (all input tokens cached)', () => {
    const r = splitOpenAiUsage(1000, 50, 1000, 0);
    expect(r.tokens.input).toBe(0);
    expect(r.cacheReadTokens).toBe(1000);
    expect(r.tokens.total).toBe(1050);
  });

  it('clamps a malformed report where cached exceeds input (no double-count, no negative)', () => {
    const r = splitOpenAiUsage(1000, 50, 1500, 0);
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
      const r = splitOpenAiUsage(inc, out, cached, 0);
      expect(r.tokens.input + r.cacheReadTokens + r.tokens.output).toBe(r.tokens.total);
    }
  });

  // ggui#1957 — cache writes are billed (GPT-5.6+, 1.25× input) and reported inside the input total.
  it('subtracts the cache-write subset from input and reports it as cacheCreationTokens', () => {
    // input_tokens = 1000 INCLUDING 300 read from the cache and 200 written to it.
    const r = splitOpenAiUsage(1000, 50, 300, 200);
    expect(r.tokens.input).toBe(500);
    expect(r.cacheReadTokens).toBe(300);
    expect(r.cacheCreationTokens).toBe(200);
    expect(r.tokens.total).toBe(1050);
  });

  it('a report with no writes says 0 writes, and input keeps everything but the reads', () => {
    const r = splitOpenAiUsage(1000, 50, 300, 0);
    expect(r.cacheCreationTokens).toBe(0);
    expect(r.tokens.input).toBe(700);
  });

  it('clamps writes to what remains after the reads (no negative input)', () => {
    const r = splitOpenAiUsage(1000, 50, 800, 500);
    expect(r.cacheCreationTokens).toBe(200);
    expect(r.tokens.input).toBe(0);
    expect(splitOpenAiUsage(1000, 50, 0, -5).cacheCreationTokens).toBe(0);
  });

  it('never double-counts: input + cacheRead + cacheCreation + output always equals total', () => {
    for (const [inc, out, cached, written] of [
      [0, 0, 0, 0],
      [500, 20, 0, 500],
      [500, 20, 123, 77],
      [500, 20, 400, 400],
      [500, 20, 9999, 9999],
    ] as const) {
      const r = splitOpenAiUsage(inc, out, cached, written);
      expect(r.tokens.input + r.cacheReadTokens + r.cacheCreationTokens + r.tokens.output).toBe(r.tokens.total);
    }
  });
});
