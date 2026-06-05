/**
 * KeyValueStore — narrow TTL-aware kv seam.
 *
 * The single seam for ephemeral state that outlives a request but
 * isn't durable render data:
 *
 *   - Handshake state (10-minute TTL, single-use via get-and-delete)
 *   - Rate-limit counters (short TTL, atomic increment)
 *   - Idempotency tokens (deduplication windows)
 *   - "Last seen `seq` per consumer" resume points (can be volatile)
 *
 * Distinct from {@link GguiSessionStore} — renders are durable and event-
 * streamed; kv entries are transient and keyed.
 *
 * Reference implementations:
 *   - InMemoryKeyValueStore   (tests + OSS dev default)
 *   - SqliteKeyValueStore     (OSS persistence default; TTL at read time)
 *   - RedisKeyValueStore      (hosted runtime — `cloud/`, closed; ElastiCache)
 *
 * Community-buildable:
 *   - Postgres UNLOGGED table + LISTEN/NOTIFY expiry
 *   - Valkey / Dragonfly wrappers
 */

export interface KeyValueSetOptions {
  /** Time-to-live in seconds. Omit to set without expiration. */
  ttlSec?: number;
}

export interface KeyValueIncrementOptions {
  /**
   * If the key does not exist, the implementation MUST create it (starting
   * at 0 before the increment) and apply `ttlSec` at creation time. If the
   * key already exists, implementations SHOULD NOT change the existing TTL
   * unless explicitly documented.
   */
  ttlSec?: number;
}

export interface KeyValueStore {
  /** Set `value` at `key`, optionally with TTL. Overwrites. */
  set(key: string, value: string, opts?: KeyValueSetOptions): Promise<void>;

  /**
   * Read `key`. Returns `null` if the key is missing or expired.
   * MUST treat expired keys as missing, not as a stale-read hit.
   */
  get(key: string): Promise<string | null>;

  /**
   * Atomic get-and-delete. Returns the stored value (or `null` if missing)
   * AND removes the key in one atomic operation.
   *
   * Used for single-use tokens — e.g. handshake ids consumed exactly once.
   * Implementations MUST guarantee two concurrent `getAndDelete` calls for
   * the same key return the value to exactly one caller.
   */
  getAndDelete(key: string): Promise<string | null>;

  /** Delete `key`. Returns `true` if it existed and was removed. */
  delete(key: string): Promise<boolean>;

  /**
   * Atomic increment. Returns the new value.
   *
   * If `by` is omitted, increments by 1. Negative values are allowed for
   * decrement. Implementations MUST make this safe under concurrency —
   * lost updates are not acceptable (used by rate limiters and quotas).
   */
  increment(
    key: string,
    by?: number,
    opts?: KeyValueIncrementOptions,
  ): Promise<number>;
}
