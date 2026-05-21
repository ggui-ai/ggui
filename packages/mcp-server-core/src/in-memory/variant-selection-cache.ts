/**
 * InMemoryVariantSelectionCache — reference impl of
 * {@link VariantSelectionCache} for the LLM-pick variant orchestration.
 *
 * Test + dev surface. Production deployments bind a Redis / Valkey
 * backed cache instead — same interface, TTL-anchored at the
 * persistence layer. The lazy-expiry pattern here mirrors
 * `InMemoryKeyValueStore`: no timers, no dangling handles after
 * test teardown.
 */
import {
  DEFAULT_VARIANT_SELECTION_CACHE_TTL_SEC,
  type VariantSelectionCache,
  type VariantSelectionCacheEntry,
} from '../variant-selection.js';

interface CacheRow {
  readonly entry: VariantSelectionCacheEntry;
  /** Epoch millis when this row expires; `null` = no TTL. */
  readonly expiresAt: number | null;
}

export interface InMemoryVariantSelectionCacheOptions {
  /**
   * Default per-entry TTL in seconds. Overridden by the `ttlSec`
   * option on individual {@link VariantSelectionCache.put} calls.
   * Defaults to {@link DEFAULT_VARIANT_SELECTION_CACHE_TTL_SEC}.
   */
  readonly defaultTtlSec?: number;
  /**
   * Clock injectable for deterministic TTL tests. Defaults to
   * `Date.now`.
   */
  readonly now?: () => number;
}

/**
 * In-memory LRU-less cache. Per-row TTL only — operators on the OSS
 * path don't run into eviction pressure since per-handshake the
 * cache barely grows (one entry per `(contract, variance)` pair the
 * agent ever asks about).
 */
export class InMemoryVariantSelectionCache implements VariantSelectionCache {
  private readonly rows = new Map<string, CacheRow>();
  private readonly defaultTtlSec: number;
  private readonly now: () => number;

  constructor(opts: InMemoryVariantSelectionCacheOptions = {}) {
    this.defaultTtlSec =
      opts.defaultTtlSec ?? DEFAULT_VARIANT_SELECTION_CACHE_TTL_SEC;
    this.now = opts.now ?? Date.now;
  }

  async get(key: string): Promise<VariantSelectionCacheEntry | null> {
    const row = this.rows.get(key);
    if (!row) return null;
    if (row.expiresAt !== null && row.expiresAt <= this.now()) {
      // Lazy expiry — discard on read.
      this.rows.delete(key);
      return null;
    }
    return row.entry;
  }

  async put(
    key: string,
    entry: VariantSelectionCacheEntry,
    opts?: { readonly ttlSec?: number },
  ): Promise<void> {
    const ttlSec = opts?.ttlSec ?? this.defaultTtlSec;
    const expiresAt = ttlSec > 0 ? this.now() + ttlSec * 1000 : null;
    this.rows.set(key, { entry, expiresAt });
  }

  /**
   * Test-only — clear the cache. NOT part of the
   * {@link VariantSelectionCache} contract; do not call from
   * production code paths.
   */
  clear(): void {
    this.rows.clear();
  }

  /**
   * Test-only — count of LIVE rows (expiry-aware). Useful for
   * asserting TTL semantics in tests.
   */
  size(): number {
    const t = this.now();
    let live = 0;
    for (const row of this.rows.values()) {
      if (row.expiresAt === null || row.expiresAt > t) live++;
    }
    return live;
  }
}
