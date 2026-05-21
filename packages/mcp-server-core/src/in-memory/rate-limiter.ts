/**
 * Reference {@link RateLimiter} implementations.
 *
 *   - `NoopRateLimiter` — always allows. The shipped default for
 *     every `createGguiServer` deployment that doesn't bind a real
 *     limiter. Zero-cost on hot paths. `remaining` is reported as
 *     `Number.MAX_SAFE_INTEGER` so callers that render the value
 *     verbatim (e.g. `X-RateLimit-Remaining`) don't mis-suggest a
 *     near-exhausted bucket.
 *
 *   - `FixedWindowRateLimiter` — composes a {@link QuotaStore} + a
 *     `{limit, windowMs}` policy. Simplest honest primitive: inside
 *     a window, incoming cost is added to a per-key counter; if the
 *     total would exceed `limit`, the call is denied without
 *     incrementing. This is the classic textbook fixed-window
 *     algorithm — boundary effects are explicit (a burst of 2×limit
 *     calls can land right across a boundary), documented in
 *     `rate-limiter.ts`'s module comment. Token-bucket / sliding-
 *     window limiters land as follow-up adapters when real policy
 *     signal demands them.
 *
 * Both adapters honor the interface contract: `check` resolves
 * asynchronously, decisions populate every field (including on
 * denial), and denied calls do NOT consume `cost` from the bucket.
 */
import type {
  RateLimitCheckInput,
  RateLimitDecision,
  RateLimiter,
} from '../rate-limiter.js';
import type { QuotaStore } from '../quota-store.js';

/**
 * Always-allow limiter. OSS default.
 *
 * `remaining` is `Number.MAX_SAFE_INTEGER` so callers that project
 * to `X-RateLimit-Remaining` render a big number instead of
 * suggesting the bucket is nearly empty. `resetAt` is far-future for
 * the same reason: a never-refilling bucket shouldn't hint "check
 * back soon".
 */
export class NoopRateLimiter implements RateLimiter {
  async check(input: RateLimitCheckInput): Promise<RateLimitDecision> {
    const at = input.at ?? Date.now();
    return {
      allowed: true,
      remaining: Number.MAX_SAFE_INTEGER,
      // Far-future. `Number.MAX_SAFE_INTEGER` is a valid epoch but
      // render-unfriendly; choosing `at + one year` is a balance
      // between "never" and "representable".
      resetAt: at + 365 * 24 * 60 * 60 * 1000,
    };
  }
}

export interface FixedWindowRateLimiterOptions {
  readonly store: QuotaStore;
  /**
   * Max total cost allowed per window, per key. MUST be a positive
   * finite number.
   */
  readonly limit: number;
  /** Window size in ms. MUST be positive finite. */
  readonly windowMs: number;
  /** Injectable clock. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Fixed-window limiter. Denies when the requested `cost` would cause
 * the per-key counter for the current window to exceed `limit`.
 * Allows otherwise, and increments the counter.
 *
 * Denials do NOT increment. This is the load-bearing "denied calls
 * leave state unchanged" clause of the {@link RateLimiter} contract.
 */
export class FixedWindowRateLimiter implements RateLimiter {
  private readonly store: QuotaStore;
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly nowFn: () => number;

  constructor(opts: FixedWindowRateLimiterOptions) {
    if (!Number.isFinite(opts.limit) || opts.limit <= 0) {
      throw new Error(
        `FixedWindowRateLimiter: limit must be a positive finite number, got ${opts.limit}`,
      );
    }
    if (!Number.isFinite(opts.windowMs) || opts.windowMs <= 0) {
      throw new Error(
        `FixedWindowRateLimiter: windowMs must be a positive finite number, got ${opts.windowMs}`,
      );
    }
    this.store = opts.store;
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    this.nowFn = opts.now ?? Date.now;
  }

  async check(input: RateLimitCheckInput): Promise<RateLimitDecision> {
    const cost = input.cost ?? 1;
    if (!Number.isFinite(cost) || cost <= 0) {
      throw new Error(
        `FixedWindowRateLimiter: cost must be a positive finite number, got ${cost}`,
      );
    }
    const at = input.at ?? this.nowFn();
    const current = await this.store.read({
      key: input.key,
      window: { durationMs: this.windowMs },
      at,
    });
    const projected = current.used + cost;
    if (projected > this.limit) {
      // Denied — do NOT increment. retryAfterMs is the distance to
      // the next window boundary (refill moment).
      const retryAfterMs = Math.max(0, current.windowEnd - at);
      return {
        allowed: false,
        remaining: Math.max(0, this.limit - current.used),
        resetAt: current.windowEnd,
        retryAfterMs,
      };
    }
    const incremented = await this.store.increment({
      key: input.key,
      window: { durationMs: this.windowMs },
      at,
      amount: cost,
    });
    return {
      allowed: true,
      remaining: Math.max(0, this.limit - incremented.used),
      resetAt: incremented.windowEnd,
    };
  }
}
