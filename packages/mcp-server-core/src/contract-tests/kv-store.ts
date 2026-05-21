/**
 * Contract test factory for {@link KeyValueStore} implementations.
 *
 * Normative semantics covered:
 *   - `set` / `get` round-trip; `get` on missing returns null.
 *   - TTL expiry: a value set with ttlSec is null after ttl elapses.
 *   - `getAndDelete` is atomic: exactly one caller wins.
 *   - `delete` returns true only if the key existed (and wasn't expired).
 *   - `increment` is concurrency-safe; no lost updates.
 *   - `increment` on non-numeric value throws.
 *   - `increment` seeds TTL on first create; does not overwrite live-entry TTL.
 *
 * Some tests need a controllable clock. Pass a `clock` factory if your
 * impl accepts one; otherwise real-time TTL tests are skipped.
 */
import { describe, expect, it } from 'vitest';
import type { KeyValueStore } from '../kv-store.js';

export interface KvContractClock {
  /** Current time getter. */
  now(): number;
  /** Advance the clock by `ms`. */
  tick(ms: number): void;
}

export interface KvContractOptions {
  /**
   * Factory that produces `(clock, store)` pairs where `store` reads
   * wall-time from `clock`. Omit if the impl can't be time-injected —
   * time-dependent tests are then skipped, not failed.
   */
  makeWithClock?: () => Promise<{ clock: KvContractClock; store: KeyValueStore }>;
}

export function kvStoreContract(
  label: string,
  makeStore: () => Promise<KeyValueStore> | KeyValueStore,
  opts: KvContractOptions = {},
): void {
  describe(`KeyValueStore contract — ${label}`, () => {
    it('set then get returns the value', async () => {
      const kv = await makeStore();
      await kv.set('k', 'v');
      await expect(kv.get('k')).resolves.toBe('v');
    });

    it('get on a missing key returns null', async () => {
      const kv = await makeStore();
      await expect(kv.get('never-set')).resolves.toBeNull();
    });

    it('set overwrites', async () => {
      const kv = await makeStore();
      await kv.set('k', 'a');
      await kv.set('k', 'b');
      await expect(kv.get('k')).resolves.toBe('b');
    });

    it('delete on an existing key returns true; missing returns false', async () => {
      const kv = await makeStore();
      await kv.set('k', 'v');
      await expect(kv.delete('k')).resolves.toBe(true);
      await expect(kv.delete('k')).resolves.toBe(false);
      await expect(kv.delete('never-existed')).resolves.toBe(false);
    });

    it('getAndDelete returns the value and removes it atomically', async () => {
      const kv = await makeStore();
      await kv.set('token', 'x');
      await expect(kv.getAndDelete('token')).resolves.toBe('x');
      await expect(kv.get('token')).resolves.toBeNull();
      await expect(kv.getAndDelete('token')).resolves.toBeNull();
    });

    it('getAndDelete concurrent: exactly one caller gets the value', async () => {
      const kv = await makeStore();
      await kv.set('once', 'payload');
      const [a, b] = await Promise.all([
        kv.getAndDelete('once'),
        kv.getAndDelete('once'),
      ]);
      const hits = [a, b].filter((v) => v === 'payload');
      expect(hits).toHaveLength(1);
    });

    it('increment on a missing key seeds at 0', async () => {
      const kv = await makeStore();
      await expect(kv.increment('counter')).resolves.toBe(1);
      await expect(kv.increment('counter')).resolves.toBe(2);
      await expect(kv.increment('counter', 5)).resolves.toBe(7);
    });

    it('increment allows negative `by`', async () => {
      const kv = await makeStore();
      await kv.increment('counter', 10);
      await expect(kv.increment('counter', -3)).resolves.toBe(7);
    });

    it('increment on a non-numeric value throws', async () => {
      const kv = await makeStore();
      await kv.set('not-a-number', 'hello');
      await expect(kv.increment('not-a-number')).rejects.toThrow();
    });

    it('increment under concurrency does not lose updates', async () => {
      const kv = await makeStore();
      const N = 50;
      await Promise.all(
        Array.from({ length: N }, () => kv.increment('race')),
      );
      await expect(kv.get('race')).resolves.toBe(String(N));
    });

    if (opts.makeWithClock) {
      const makeWithClock = opts.makeWithClock;

      it('TTL: value is null after ttlSec elapses', async () => {
        const { clock, store } = await makeWithClock();
        await store.set('short', 'v', { ttlSec: 10 });
        await expect(store.get('short')).resolves.toBe('v');
        clock.tick(9_000);
        await expect(store.get('short')).resolves.toBe('v');
        clock.tick(1_001);
        await expect(store.get('short')).resolves.toBeNull();
      });

      it('TTL: getAndDelete past expiry returns null', async () => {
        const { clock, store } = await makeWithClock();
        await store.set('token', 'x', { ttlSec: 5 });
        clock.tick(6_000);
        await expect(store.getAndDelete('token')).resolves.toBeNull();
      });

      it('TTL: delete past expiry returns false', async () => {
        const { clock, store } = await makeWithClock();
        await store.set('k', 'v', { ttlSec: 5 });
        clock.tick(6_000);
        await expect(store.delete('k')).resolves.toBe(false);
      });

      it('increment with ttlSec applies on create, not on subsequent live increment', async () => {
        const { clock, store } = await makeWithClock();
        await store.increment('c', 1, { ttlSec: 10 });
        clock.tick(5_000);
        // Subsequent increment on a live entry should not reset TTL.
        await store.increment('c', 1, { ttlSec: 999 });
        clock.tick(5_001);
        // Original 10s TTL has fired → key gone.
        await expect(store.get('c')).resolves.toBeNull();
      });
    }
  });
}
