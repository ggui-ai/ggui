/**
 * InMemoryKeyValueStore — reference implementation of {@link KeyValueStore}.
 *
 * Intended for tests and dev. TTL enforced at read time (no timers, so no
 * dangling handles after tests tear down). Not a production backend.
 *
 * Production bindings (Redis/ElastiCache, Postgres UNLOGGED, Valkey,
 * Dragonfly) ship as separate packages and MUST pass `kvStoreContract`.
 */
import type {
  KeyValueIncrementOptions,
  KeyValueSetOptions,
  KeyValueStore,
} from '../kv-store.js';

interface Entry {
  value: string;
  /** Epoch millis when this entry expires; `null` = no TTL. */
  expiresAt: number | null;
}

export class InMemoryKeyValueStore implements KeyValueStore {
  private readonly store = new Map<string, Entry>();

  /** Clock injectable for deterministic TTL tests. Defaults to `Date.now`. */
  constructor(private readonly now: () => number = Date.now) {}

  async set(
    key: string,
    value: string,
    opts?: KeyValueSetOptions,
  ): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: opts?.ttlSec ? this.now() + opts.ttlSec * 1000 : null,
    });
  }

  async get(key: string): Promise<string | null> {
    return this.readLive(key);
  }

  async getAndDelete(key: string): Promise<string | null> {
    const value = this.readLive(key);
    if (value !== null) this.store.delete(key);
    return value;
  }

  async delete(key: string): Promise<boolean> {
    // Expired entries count as already-gone per the `get` contract.
    const entry = this.store.get(key);
    if (!entry) return false;
    const alive = entry.expiresAt === null || entry.expiresAt > this.now();
    this.store.delete(key);
    return alive;
  }

  async increment(
    key: string,
    by = 1,
    opts?: KeyValueIncrementOptions,
  ): Promise<number> {
    const live = this.readLive(key);
    const current = live === null ? 0 : Number(live);
    if (!Number.isFinite(current)) {
      throw new Error(
        `InMemoryKeyValueStore.increment: value at "${key}" is not numeric: ${JSON.stringify(live)}`,
      );
    }
    const next = current + by;
    // Per docstring: set TTL only when creating the key. If it existed
    // (even expired), keep the caller-provided TTL on the recreate path
    // but don't overwrite an existing live-entry TTL.
    const existing = this.store.get(key);
    const wasAlive =
      existing && (existing.expiresAt === null || existing.expiresAt > this.now());
    const expiresAt = wasAlive
      ? existing.expiresAt
      : opts?.ttlSec
        ? this.now() + opts.ttlSec * 1000
        : null;
    this.store.set(key, { value: String(next), expiresAt });
    return next;
  }

  /** Read-with-expiry. Evicts expired entries lazily. */
  private readLive(key: string): string | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }
}
