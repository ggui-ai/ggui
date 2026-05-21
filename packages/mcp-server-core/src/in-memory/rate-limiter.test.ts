/**
 * Reference-adapter tests for `NoopRateLimiter` and
 * `FixedWindowRateLimiter`. Pins the RateLimiter contract: decisions
 * populate every field, denied calls do NOT consume cost, retry hint
 * is set only on denial, window boundaries reset the counter, and
 * input validation.
 */
import { describe, expect, it } from 'vitest';
import { InMemoryQuotaStore } from './quota-store.js';
import {
  FixedWindowRateLimiter,
  NoopRateLimiter,
} from './rate-limiter.js';

describe('NoopRateLimiter', () => {
  it('always allows, with big remaining + far-future resetAt', async () => {
    const lim = new NoopRateLimiter();
    const d = await lim.check({ key: 'a', at: 1000 });
    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(Number.MAX_SAFE_INTEGER);
    // resetAt is far future — a year later in our impl.
    expect(d.resetAt).toBeGreaterThan(1000 + 30 * 24 * 60 * 60 * 1000);
    expect(d.retryAfterMs).toBeUndefined();
  });
});

describe('FixedWindowRateLimiter — admission decision', () => {
  function makeLimiter(limit = 3) {
    let clock = 1_000;
    const store = new InMemoryQuotaStore({ now: () => clock });
    const lim = new FixedWindowRateLimiter({
      store,
      limit,
      windowMs: 1000,
      now: () => clock,
    });
    return {
      lim,
      store,
      setClock(v: number) {
        clock = v;
      },
    };
  }

  it('allows calls up to limit; denies beyond; reports remaining + resetAt', async () => {
    const { lim } = makeLimiter(3);
    const d1 = await lim.check({ key: 'k' });
    expect(d1.allowed).toBe(true);
    expect(d1.remaining).toBe(2);

    const d2 = await lim.check({ key: 'k' });
    expect(d2.allowed).toBe(true);
    expect(d2.remaining).toBe(1);

    const d3 = await lim.check({ key: 'k' });
    expect(d3.allowed).toBe(true);
    expect(d3.remaining).toBe(0);

    const d4 = await lim.check({ key: 'k' });
    expect(d4.allowed).toBe(false);
    expect(d4.remaining).toBe(0);
    expect(d4.retryAfterMs).toBeGreaterThan(0);
  });

  it('denials do NOT consume cost (state unchanged on denial)', async () => {
    const { lim, store } = makeLimiter(1);
    await lim.check({ key: 'k' });
    const beforeRead = await store.read({
      key: 'k',
      window: { durationMs: 1000 },
    });
    expect(beforeRead.used).toBe(1);

    // Fire several denials; used should remain at 1.
    await lim.check({ key: 'k' });
    await lim.check({ key: 'k' });
    await lim.check({ key: 'k' });
    const afterRead = await store.read({
      key: 'k',
      window: { durationMs: 1000 },
    });
    expect(afterRead.used).toBe(1);
  });

  it('next window resets the counter', async () => {
    const { lim, setClock } = makeLimiter(2);
    await lim.check({ key: 'k' });
    await lim.check({ key: 'k' });
    const denied = await lim.check({ key: 'k' });
    expect(denied.allowed).toBe(false);

    // Advance past current window.
    setClock(3000);
    const allowed = await lim.check({ key: 'k' });
    expect(allowed.allowed).toBe(true);
    expect(allowed.remaining).toBe(1);
  });

  it('per-key isolation — one key\'s usage does not deny another', async () => {
    const { lim } = makeLimiter(1);
    const ka = await lim.check({ key: 'a' });
    const kb = await lim.check({ key: 'b' });
    expect(ka.allowed).toBe(true);
    expect(kb.allowed).toBe(true);
    const ka2 = await lim.check({ key: 'a' });
    expect(ka2.allowed).toBe(false);
    const kb2 = await lim.check({ key: 'b' });
    expect(kb2.allowed).toBe(false);
  });

  it('cost > 1 consumes multiple units; over-cost denies without consuming', async () => {
    const { lim, store } = makeLimiter(5);
    const d1 = await lim.check({ key: 'k', cost: 3 });
    expect(d1.allowed).toBe(true);
    expect(d1.remaining).toBe(2);
    // cost=3 would overflow 2+3=5 — but the new cost is 3, pushing
    // total to 5 which equals limit. Allowed.
    const d2 = await lim.check({ key: 'k', cost: 3 });
    expect(d2.allowed).toBe(false);
    const read = await store.read({
      key: 'k',
      window: { durationMs: 1000 },
    });
    // Denial did NOT increment — used is still 3.
    expect(read.used).toBe(3);
  });

  it('retryAfterMs equals distance to window boundary on denial', async () => {
    const clock = 1200; // window 1000..2000
    const store = new InMemoryQuotaStore({ now: () => clock });
    const lim = new FixedWindowRateLimiter({
      store,
      limit: 1,
      windowMs: 1000,
      now: () => clock,
    });
    await lim.check({ key: 'k' });
    const d = await lim.check({ key: 'k' });
    expect(d.allowed).toBe(false);
    expect(d.retryAfterMs).toBe(800); // 2000 - 1200
    expect(d.resetAt).toBe(2000);
  });
});

describe('FixedWindowRateLimiter — input validation', () => {
  it('rejects invalid limit / windowMs at construction', () => {
    const store = new InMemoryQuotaStore();
    expect(
      () => new FixedWindowRateLimiter({ store, limit: 0, windowMs: 1000 }),
    ).toThrow(/limit/i);
    expect(
      () => new FixedWindowRateLimiter({ store, limit: -1, windowMs: 1000 }),
    ).toThrow(/limit/i);
    expect(
      () => new FixedWindowRateLimiter({ store, limit: 1, windowMs: 0 }),
    ).toThrow(/windowMs/i);
    expect(
      () => new FixedWindowRateLimiter({ store, limit: 1, windowMs: NaN }),
    ).toThrow(/windowMs/i);
  });

  it('rejects non-positive cost at check time', async () => {
    const store = new InMemoryQuotaStore();
    const lim = new FixedWindowRateLimiter({
      store,
      limit: 10,
      windowMs: 1000,
    });
    await expect(lim.check({ key: 'k', cost: 0 })).rejects.toThrow(/cost/i);
    await expect(lim.check({ key: 'k', cost: -1 })).rejects.toThrow(/cost/i);
  });
});
