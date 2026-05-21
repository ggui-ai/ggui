/**
 * RateLimiter — admission-control seam.
 *
 * Paired with {@link QuotaStore} but deliberately distinct — this is
 * the admission-decision layer, NOT the counter store.
 *
 * **Intent (what rate limiting is for):** answer "can this request
 * proceed right now, under this bucket's policy?" at each high-signal
 * handler ingress. The canonical consumer today is `ggui_push` — the
 * single highest-cost tool on OSS — but the seam is general. Every
 * admission check composes a caller-chosen `key` with a `cost`; the
 * limiter returns an allow/deny decision plus `remaining` + a retry
 * hint.
 *
 * **Deliberately distinct from {@link QuotaStore}.** The store just
 * counts. The limiter applies a policy on top of a counter (or
 * several; token-bucket limiters track two). Composition runs one
 * direction only: limiters MAY wrap stores; stores do NOT know about
 * limiters. Do not collapse the two into a single abstraction.
 *
 * **Contract for implementations:**
 *
 *   - `check` is ASYNC. In-process implementations can resolve
 *     synchronously wrapped in a resolved Promise; the async shape
 *     accommodates durable/remote limiters without reshaping the
 *     interface later.
 *   - `check` MAY throw on transport-level failures (e.g. Redis
 *     unreachable in a distributed limiter). Default hosted policy
 *     SHOULD be "fail-open on limiter errors" — a limiter outage
 *     must not take down the whole server — but that's a policy
 *     decision owned by the caller, not mandated by the interface.
 *   - `remaining` in the response is the caller's allowance AFTER
 *     this check's `cost` was accounted (if allowed) or the unchanged
 *     allowance (if denied). Never negative.
 *   - `resetAt` is the epoch ms at which the bucket's `remaining`
 *     returns to full capacity. Callers render this as "Retry after
 *     {resetAt - now} ms" or surface it as an `X-RateLimit-Reset`
 *     header.
 *   - `retryAfterMs` is set ONLY when `allowed === false`. Implies
 *     "the request, AS CHECKED, would succeed after waiting this
 *     long"; callers MUST re-check, not blindly retry in-flight.
 *
 * **Key conventions (caller-owned):** the interface does not mandate
 * key shape. In practice OSS wiring uses `<handler>:<identity-kind>:<appId>`
 * (e.g. `ggui_push:builder:local`) for per-app admission. Hosted
 * deployments layer richer shapes as their identity model grows.
 *
 * **OSS reference adapters (this slice):**
 *   - `NoopRateLimiter` — always allows. The shipped default for
 *     every `createGguiServer` deployment that doesn't bind a real
 *     limiter. Zero-cost on hot paths; matches the "handler is not
 *     broken when limiter is absent" invariant.
 *   - `FixedWindowRateLimiter` — composes with a {@link QuotaStore}
 *     and a `{limit, windowMs}` policy. Fixed-window semantics (NOT
 *     token-bucket) — the simplest honest primitive. The `QuotaStore`
 *     handles the counter; the limiter handles the policy.
 *
 * Future reference impls (NOT this slice) — token-bucket, leaky-bucket,
 * sliding-window — bind the same `RateLimiter` interface from their
 * own adapter modules.
 */

/**
 * The request an admission check describes.
 */
export interface RateLimitCheckInput {
  /** Caller-chosen bucket key. See "Key conventions" in the module comment. */
  readonly key: string;
  /**
   * Requested cost in units the limiter policy measures. Defaults
   * to `1`. MUST be a positive finite number. Some calls naturally
   * cost more than one unit (bulk operations) — the handler picks
   * a cost that matches policy intent.
   */
  readonly cost?: number;
  /** Epoch ms. Defaults to `Date.now()`. Exposed for tests that need
   *  a deterministic clock. */
  readonly at?: number;
}

/**
 * Decision returned by {@link RateLimiter.check}.
 *
 * Fields are populated on every return (including denials) so callers
 * can render consistent `X-RateLimit-*` headers without branching on
 * `allowed`.
 */
export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Allowance remaining AFTER this check. Never negative. */
  readonly remaining: number;
  /** Epoch ms the bucket's allowance refills to full capacity at.
   *  Implementations that never refill (e.g. a per-process
   *  `NoopRateLimiter`) return `at + Number.MAX_SAFE_INTEGER` or a
   *  similar far-future value. */
  readonly resetAt: number;
  /** Wait ceiling for a retry. Set ONLY when `allowed === false`. */
  readonly retryAfterMs?: number;
}

export interface RateLimiter {
  /**
   * Admission check. See {@link RateLimitDecision}. MUST be
   * idempotent per-call — the check itself is not an increment;
   * denied calls leave state unchanged. Allowed calls consume
   * `cost` from the bucket (the limiter's own concern, not the
   * caller's).
   */
  check(input: RateLimitCheckInput): Promise<RateLimitDecision>;
}

/**
 * Thrown by handlers when their configured {@link RateLimiter}
 * returns `allowed: false`. Carries the full decision so transport
 * layers can project it into HTTP headers / error payloads without
 * a second check.
 *
 * Kept in `@ggui-ai/mcp-server-core` (not in a handler package) so
 * every handler that wires rate limiting throws the same typed
 * error — transport-layer error-mapping branches on one class, not
 * string matching.
 */
export class RateLimitedError extends Error {
  readonly code = 'rate_limited';
  readonly decision: RateLimitDecision;
  readonly key: string;
  constructor(key: string, decision: RateLimitDecision) {
    super(
      `Rate limit exceeded for key "${key}" — retry after ${decision.retryAfterMs ?? 0}ms.`,
    );
    this.name = 'RateLimitedError';
    this.key = key;
    this.decision = decision;
  }
}
