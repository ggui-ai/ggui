/**
 * QuotaStore — fixed-window usage counter store.
 *
 * Paired with {@link RateLimiter} but deliberately distinct — this is
 * the accounting layer, not the admission layer.
 *
 * **Intent (what the store is for):** track accumulated usage per
 * `(key, window)` pair. Two primary consumers:
 *
 *   1. Backing storage for {@link RateLimiter} implementations that
 *      need durable counters across process restarts (or multi-host
 *      deployments). A `FixedWindowRateLimiter` composes this store +
 *      a policy to make admission decisions.
 *   2. Standalone usage reads for billing / observability — "how
 *      many `ggui_push` calls did app X make this hour?" — without
 *      a rate-limiter in the picture at all.
 *
 * **Deliberately distinct from {@link RateLimiter}.** The rate limiter
 * answers "can this request proceed?" — a policy-aware yes/no + retry
 * hint. The store just counts: "what's the current usage for this
 * key in this window, and please increment it." The two are composed
 * in one direction (limiters use stores); never collapse them into a
 * single generic "limits" abstraction.
 *
 * **Window semantics:**
 *
 *   - A window is `durationMs`-long. The store derives the containing
 *     window for a given `at` timestamp via floor-to-boundary:
 *     `windowStart = Math.floor(at / durationMs) * durationMs`.
 *   - Each `(key, windowStart, durationMs)` triple is an independent
 *     counter. Changing `durationMs` for the same `key` creates a new
 *     counter series — callers MUST keep `durationMs` stable across
 *     a usage series.
 *   - Windows never rollover implicitly; old windows just stop being
 *     read. Implementations MAY GC stale windows at their discretion.
 *
 * **Contract for implementations:**
 *
 *   - `read` returns the current counter for the window containing
 *     `at`. Returns `{used: 0, ...}` when the counter has never been
 *     incremented.
 *   - `increment` is ATOMIC — concurrent increments MUST NOT lose
 *     counts. In-process implementations are trivially atomic
 *     (single-threaded JS); cross-process implementations need real
 *     atomic primitives (Redis `INCR`, DDB `UpdateItem`
 *     `ADD`, Postgres `UPSERT ... ON CONFLICT DO UPDATE`).
 *   - `increment` returns the POST-increment counter value. Callers
 *     can use the return value directly without a second `read`.
 *   - `amount` defaults to `1`. Negative `amount` is NOT supported
 *     (quota is strictly monotonic per window). Implementations MAY
 *     reject negative values at their discretion; the default
 *     in-memory reference does so explicitly.
 *
 * **OSS reference adapters (this slice):**
 *   - `InMemoryQuotaStore` — Map-backed, process-local, GCs stale
 *     windows on access. Fine for dev + tests + any single-host
 *     deployment. Not durable across restarts.
 *
 * Future reference impls (NOT this slice) — SQLite, Redis, DynamoDB
 * adapters bind this interface from their own packages.
 */

/**
 * Window shape. `durationMs` is the only field because the store
 * derives `windowStart` itself from the `at` timestamp — callers
 * don't align windows by hand.
 */
export interface QuotaWindow {
  readonly durationMs: number;
}

/** Common fields for read + increment operations. */
export interface QuotaReadInput {
  /** Opaque bucket key. Caller composes (e.g. `ggui_push:builder:app_x`). */
  readonly key: string;
  readonly window: QuotaWindow;
  /** Epoch ms. Defaults to `Date.now()`. */
  readonly at?: number;
}

export interface QuotaIncrementInput extends QuotaReadInput {
  /** Amount to add. Defaults to `1`. MUST be a positive finite number. */
  readonly amount?: number;
}

/** Point-in-time counter reading. `windowStart` / `windowEnd` bound
 *  the window the counter belongs to (both epoch ms, `windowEnd`
 *  exclusive). */
export interface QuotaReading {
  readonly used: number;
  readonly windowStart: number;
  readonly windowEnd: number;
}

export interface QuotaStore {
  /**
   * Read the current counter for the window containing `at`. Returns
   * `{used: 0}` when the counter has never been incremented.
   */
  read(input: QuotaReadInput): Promise<QuotaReading>;

  /**
   * Atomically add `amount` (default 1) to the counter for the window
   * containing `at`, and return the POST-increment reading.
   *
   * In-process implementations satisfy atomicity trivially; durable
   * implementations MUST use backend primitives that serialize
   * concurrent increments.
   */
  increment(input: QuotaIncrementInput): Promise<QuotaReading>;
}
