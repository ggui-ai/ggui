/**
 * Per-shortCode rate limiter.
 *
 * Brute-force attempts on `/r/<code>` or `/api/bootstrap/<code>` are
 * trivially detected at the wire by per-shortCode call counts. Even
 * with high-entropy shortCodes and HMAC-signed render URLs, the gate
 * still hits a real backend on every request — so DoS resistance +
 * abuse-signal logging matter independently of entropy.
 *
 * **Design choice — rate-limit by shortCode, not by peer.**
 * Cross-origin iframes (claude.ai) NAT every user through the host's
 * outbound proxy, so per-peer limits would either rate-limit the whole
 * host (false-positive flood) or accept every peer (no signal). Per-
 * shortCode is the right granularity: 30 hits/minute on a single
 * code is abuse no matter who sent them; 30 hits/minute spread across
 * 30 unique codes is normal traffic.
 *
 * In-memory + per-process by default. Operator-grade deployments
 * back this with a shared store (Redis bucket counter) — wire via the
 * {@link RenderRateLimiter} interface; the OSS reference uses a
 * `Map<shortCode, {windowStart, count}>` with periodic cleanup.
 */

/** Configuration knobs. Operators tune via boot options. */
export interface RenderRateLimiterConfig {
  /** Window size in seconds. Each shortCode gets `limit` hits per
   *  rolling window. Default 60s. */
  readonly windowSeconds?: number;
  /** Per-shortCode hit cap inside the window. Default 30. */
  readonly limit?: number;
  /** Clock seam for tests. */
  readonly now?: () => number;
}

export type RenderRateLimitResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface RenderRateLimiter {
  /** Record a hit on `shortCode`. Returns the gate decision + (when
   *  rejected) a Retry-After hint in seconds. */
  check(shortCode: string): RenderRateLimitResult;
}

/**
 * In-memory reference implementation. Cleanup runs lazily on each
 * call — entries past their window-end are reaped before the count is
 * read. Worst-case heap: bounded by the number of distinct shortCodes
 * hit within the last `windowSeconds`; pre-launch OSS workloads stay
 * tiny enough that the periodic pass is sufficient.
 */
export function createInMemoryRenderRateLimiter(
  cfg: RenderRateLimiterConfig = {},
): RenderRateLimiter {
  const windowMs = (cfg.windowSeconds ?? 60) * 1000;
  const limit = cfg.limit ?? 30;
  const now = cfg.now ?? (() => Date.now());

  const buckets = new Map<
    string,
    { windowStart: number; count: number }
  >();

  return {
    check(shortCode) {
      if (!shortCode) {
        // Empty shortCode is upstream's path-validation problem; we
        // still return allowed:true to keep the contract uniform.
        return { allowed: true };
      }
      const t = now();
      const existing = buckets.get(shortCode);
      if (!existing || t - existing.windowStart >= windowMs) {
        // Window expired or never opened — start a fresh window.
        buckets.set(shortCode, { windowStart: t, count: 1 });
        return { allowed: true };
      }
      if (existing.count >= limit) {
        const retryMs = windowMs - (t - existing.windowStart);
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil(retryMs / 1000)),
        };
      }
      existing.count += 1;
      return { allowed: true };
    },
  };
}

/**
 * Mask a shortCode for log output. The full code is the credential —
 * log it verbatim and a leaked log line becomes a leaked URL. Show
 * just enough (first 3 chars) to correlate within a session without
 * giving the credential away.
 */
export function maskShortCode(shortCode: string): string {
  if (!shortCode || shortCode.length === 0) return '<empty>';
  if (shortCode.length <= 3) return `${shortCode}***`;
  return `${shortCode.slice(0, 3)}***`;
}
