/**
 * Reference-adapter tests for `InMemoryQuotaStore`. Pins the
 * fixed-window counter contract from `quota-store.ts`:
 * floor-to-boundary window derivation, atomic increment, zero read
 * for unseen keys, `durationMs` as part of the compound key,
 * input validation, and lazy GC of stale windows.
 */
import { describe, expect, it } from 'vitest';
import {
  InMemoryQuotaStore,
  windowStartAt,
} from './quota-store.js';

describe('windowStartAt — floor-to-boundary', () => {
  it('aligns to the window boundary', () => {
    expect(windowStartAt(1_000_000, 60_000)).toBe(960_000);
    expect(windowStartAt(999, 1000)).toBe(0);
    expect(windowStartAt(1000, 1000)).toBe(1000);
  });
});

describe('InMemoryQuotaStore — read', () => {
  it('unseen key returns zero usage + correct window bounds', async () => {
    const store = new InMemoryQuotaStore({ now: () => 100_000 });
    const r = await store.read({
      key: 'a',
      window: { durationMs: 1000 },
    });
    expect(r.used).toBe(0);
    expect(r.windowStart).toBe(100_000);
    expect(r.windowEnd).toBe(101_000);
  });

  it('honors caller-supplied `at` over the clock', async () => {
    const store = new InMemoryQuotaStore({ now: () => 100_000 });
    const r = await store.read({
      key: 'a',
      window: { durationMs: 1000 },
      at: 50_500,
    });
    expect(r.windowStart).toBe(50_000);
  });
});

describe('InMemoryQuotaStore — increment', () => {
  it('increments atomically + returns post-increment reading', async () => {
    const store = new InMemoryQuotaStore({ now: () => 1000 });
    const r1 = await store.increment({
      key: 'a',
      window: { durationMs: 1000 },
    });
    expect(r1.used).toBe(1);
    const r2 = await store.increment({
      key: 'a',
      window: { durationMs: 1000 },
      amount: 3,
    });
    expect(r2.used).toBe(4);
  });

  it('increments do not leak across keys', async () => {
    const store = new InMemoryQuotaStore({ now: () => 1000 });
    await store.increment({ key: 'a', window: { durationMs: 1000 } });
    await store.increment({ key: 'a', window: { durationMs: 1000 } });
    const b = await store.read({ key: 'b', window: { durationMs: 1000 } });
    expect(b.used).toBe(0);
  });

  it('increments do not leak across windows (new window = new counter)', async () => {
    let clock = 500;
    const store = new InMemoryQuotaStore({ now: () => clock });
    await store.increment({ key: 'a', window: { durationMs: 1000 } });
    clock = 1500; // next window
    const r = await store.increment({
      key: 'a',
      window: { durationMs: 1000 },
    });
    expect(r.used).toBe(1);
    expect(r.windowStart).toBe(1000);
  });

  it('changing durationMs on the same key yields a new counter series', async () => {
    const store = new InMemoryQuotaStore({ now: () => 1000 });
    await store.increment({ key: 'a', window: { durationMs: 1000 } });
    const r = await store.read({
      key: 'a',
      window: { durationMs: 5000 },
    });
    expect(r.used).toBe(0);
  });
});

describe('InMemoryQuotaStore — input validation', () => {
  const store = new InMemoryQuotaStore();

  it('rejects non-positive / non-finite durationMs', async () => {
    await expect(
      store.read({ key: 'a', window: { durationMs: 0 } }),
    ).rejects.toThrow(/durationMs/i);
    await expect(
      store.read({ key: 'a', window: { durationMs: -1 } }),
    ).rejects.toThrow(/durationMs/i);
    await expect(
      store.read({ key: 'a', window: { durationMs: NaN } }),
    ).rejects.toThrow(/durationMs/i);
  });

  it('rejects non-positive / non-finite amount', async () => {
    await expect(
      store.increment({
        key: 'a',
        window: { durationMs: 1000 },
        amount: 0,
      }),
    ).rejects.toThrow(/amount/i);
    await expect(
      store.increment({
        key: 'a',
        window: { durationMs: 1000 },
        amount: -1,
      }),
    ).rejects.toThrow(/amount/i);
  });
});

describe('InMemoryQuotaStore — GC', () => {
  it('sweeps stale windows on next access (gcAfterMs cutoff)', async () => {
    let clock = 0;
    const store = new InMemoryQuotaStore({
      now: () => clock,
      gcAfterMs: 10_000,
    });
    await store.increment({
      key: 'a',
      window: { durationMs: 1000 },
    });
    expect(store.size).toBe(1);
    // Advance far past the GC cutoff. Any read/increment sweeps stale
    // entries.
    clock = 60_000;
    await store.read({ key: 'b', window: { durationMs: 1000 } });
    expect(store.size).toBe(0);
  });
});
