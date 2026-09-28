// ggui#1524 — the generation's cost cap counts the prompt cache. RED fixture: `record` priced input + output only
// and every caller passed the UNCACHED input, so a turn with a long cached prefix cost the cap almost nothing while
// the provider billed its reads and writes. Known answers below are computed by hand from the registry's stated
// rates ($/1M), never from `pricePer1k`.
import { describe, it, expect } from 'vitest';
import { CACHE_WRITE_PREMIUM_BOUND, CostTracker, pricePer1k } from './cost-tracker.js';

describe('CostTracker prices the prompt cache (ggui#1524)', () => {
  it('a model with stated cache rates: reads and writes priced at them (Opus 5.5: in 4, out 20, write 5, read 0.2)', () => {
    const t = new CostTracker(null);
    const cost = t.record('claude-opus-5-5', 1000, 1000, { read: 10_000, write: 2000 });
    // 1000·4 + 1000·20 + 10000·0.2 + 2000·5 = 36000 / 1e6
    expect(cost).toBeCloseTo(0.036, 12);
    const before = new CostTracker(null).record('claude-opus-5-5', 1000, 1000); // what the cap saw until now
    expect(before).toBeCloseTo(0.024, 12);
  });

  it('the write-premium bound is the registry’s largest stated write/input ratio (1.25 today), never below 1', () => {
    expect(CACHE_WRITE_PREMIUM_BOUND).toBe(1.25);
  });

  it('no stated cache rates: a read at the input rate (over, the safe side), a write at input × the bound — never under', () => {
    const t = new CostTracker(null);
    // gemini-3.5-flash: in 1.5. read 100k·1.5 = 0.15; write 100k·1.5·1.25 = 0.1875
    expect(t.record('gemini-3.5-flash', 0, 0, { read: 100_000, write: 100_000 })).toBeCloseTo(0.3375, 12);
  });

  it('a stated read rate with no write rate: the read at its rate, the write at input × the bound (gemini-3.7-flash: in 0.75, read 0.075)', () => {
    expect(new CostTracker(null).record('gemini-3.7-flash', 0, 0, { read: 100_000 })).toBeCloseTo(0.0075, 12);
    expect(new CostTracker(null).record('gemini-3.7-flash', 0, 0, { write: 100_000 })).toBeCloseTo(0.09375, 12);
  });

  it('a model outside the registry prices its cache at the fallback input rate, the write with the bound', () => {
    const p = pricePer1k('not-a-registered-model');
    expect(p.cacheRead).toBe(p.input);
    expect(p.cacheWrite).toBeCloseTo(p.input * CACHE_WRITE_PREMIUM_BOUND, 12);
  });

  it('a budget only the cache spend crosses stops the loop', () => {
    const t = new CostTracker(0.03);
    t.record('claude-opus-5-5', 1000, 1000); // 0.024 — under
    expect(t.canContinue()).toBe(true);
    t.record('claude-opus-5-5', 0, 0, { read: 10_000, write: 2000 }); // +0.012 — the cache crosses it
    expect(t.canContinue()).toBe(false);
  });

  it('no cache argument (a caller whose provider reports none) prices exactly as before', () => {
    expect(new CostTracker(null).record('claude-opus-5-5', 1000, 1000, {})).toBeCloseTo(0.024, 12);
  });
});
