/**
 * Provider adapter contract — the narrow surface every concrete LLM
 * provider client (Anthropic, Google, OpenAI, OpenRouter) implements
 * before the generator wires them in.
 *
 * The contract is deliberately defined independently of concrete
 * adapters so:
 *
 *   - Adapter implementations can be written against a stable surface —
 *     every concrete adapter MUST pass
 *     {@link providerAdapterContract} or it isn't a `ProviderAdapter`.
 *   - Downstream callers (`createUiGenerator`, push handlers, retry /
 *     backoff plumbing) build against ONE structured failure shape
 *     ({@link ProviderError}) instead of inventing per-provider error
 *     UX.
 *   - The negotiator + cache layers can branch on
 *     `error.kind === 'rate-limited'` etc. without parsing strings.
 *
 * **Scope:**
 *
 *   - Defines the interface, the response shape, the error shape,
 *     a {@link MockProviderAdapter} for tests, and a contract test
 *     runner that asserts every adapter satisfies the seam.
 *   - Does NOT call any LLM. The contract is structural; the runner
 *     fakes responses + errors via the {@link MockProviderAdapter}.
 *
 * **Design choices, locked:**
 *
 *   - One discriminated `ProviderError.kind` union, not per-provider
 *     subclasses. Every provider's raw error funnels through
 *     `mapError` into one of these kinds. Callers branch on `kind`.
 *   - Every error carries `provider` + `message`; transport-shaped
 *     errors carry `status`; backoff-shaped errors carry
 *     `retryAfterSec`. Optional fields don't appear when they don't
 *     apply (no `status: undefined` noise in serialized logs).
 *   - `validateConfig` is synchronous + does NO I/O. It catches the
 *     "operator never configured the provider" case (missing key,
 *     malformed model id) before we attempt a network call.
 *   - `complete` is the single-completion seam. Streaming, tool
 *     calling, function calling, and harness retry land in higher
 *     layers — adapters stay narrow.
 */
import type { LlmProvider, LlmRoute } from '@ggui-ai/protocol';

/**
 * One LLM completion request as the adapter sees it. Plain data so
 * tests can construct it without DI.
 *
 * `route` is a discriminated `LlmRoute` — `(provider, model)` typed
 * together so the model id is structurally constrained to its
 * provider's namespace (per the `MODELS` registry in
 * `@ggui-ai/protocol/types/llm-route`). This makes the #22 / #42 bug
 * class — passing a LiteLLM-prefixed `'anthropic/claude-haiku-4-5'`
 * where Anthropic expected the wire id `'claude-haiku-4-5-20251001'` —
 * a compile error at every adapter call site. The adapter reads the
 * wire-canonical string off `request.route.model` and passes it
 * verbatim to the provider SDK; no transformation step exists to
 * forget.
 */
export interface ProviderRequest {
  /** API key. Resolved upstream by `@ggui-ai/cli/byok-resolver`. */
  readonly apiKey: string;
  /**
   * Discriminated `(provider, model)` route. `route.model` is the
   * wire-canonical id the provider's API expects — adapters pass it
   * verbatim with no stripping or remapping.
   */
  readonly route: LlmRoute;
  /** System prompt text. Adapter wires it into the provider's slot. */
  readonly systemPrompt: string;
  /** User prompt text. */
  readonly userPrompt: string;
  /**
   * Optional cap on output tokens. Adapters MUST honor when the
   * provider supports it; when absent, adapters use the provider
   * default.
   */
  readonly maxTokens?: number;
  /**
   * Optional cancellation. Adapters MUST forward into the provider
   * SDK's abort surface and reject with `ProviderError{kind:'aborted'}`
   * when fired.
   */
  readonly signal?: AbortSignal;
}

/**
 * Successful provider response, normalized.
 *
 * Tool-calling output, multi-turn dialogue, structured-output
 * coercion all land in higher layers — this contract intentionally
 * stays narrow: text + usage + finish reason. The harness layer
 * composes adapters into multi-turn loops.
 */
export interface ProviderResponse {
  /** The completion text returned by the provider. */
  readonly text: string;
  /** Token usage, per-call. Required — adapters synthesize 0 if the
   *  provider didn't report it (and document that in their adapter). */
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
  /**
   * Why the model stopped. Mapped through a normalized union so
   * callers don't have to know each provider's vocabulary.
   *
   *   - `'stop'`         model emitted EOS / stop sequence
   *   - `'length'`       hit `maxTokens` or provider context limit
   *   - `'content-filter'` provider safety filter intervened
   *   - `'other'`        anything else (provider-specific reason)
   */
  readonly finishReason: 'stop' | 'length' | 'content-filter' | 'other';
}

/**
 * The structured failure contract. Every concrete adapter's
 * `mapError` MUST funnel raw provider errors into this shape so
 * downstream code branches on `kind`, not on string parsing.
 *
 * Discriminator + optional carriers:
 *
 *   - `'no-credentials'`   — no key supplied (pre-flight failure;
 *                            usually surfaced by `validateConfig`,
 *                            not `mapError`).
 *   - `'unauthorized'`     — provider returned 401. Key invalid /
 *                            revoked / wrong type.
 *   - `'forbidden'`        — provider returned 403. Quota exhausted,
 *                            org-level block, model not allowed for
 *                            this key. (Distinct from 401 because
 *                            "rotate the key" doesn't help.)
 *   - `'rate-limited'`     — provider returned 429. Carries
 *                            `retryAfterSec` when the provider
 *                            advertised one (`Retry-After` header).
 *   - `'server-error'`     — provider returned 5xx. Retryable.
 *   - `'client-error'`     — provider returned other 4xx. Usually
 *                            non-retryable (bad model id, malformed
 *                            request).
 *   - `'network'`          — TCP-level failure, DNS, EAI_AGAIN, etc.
 *                            No `status`. Retryable.
 *   - `'invalid-response'` — provider returned 2xx with a body the
 *                            adapter couldn't parse. Bug in the
 *                            adapter or in the provider; treat as
 *                            non-retryable.
 *   - `'aborted'`          — caller aborted via `signal`.
 *   - `'unknown'`          — last-resort bucket. Adapters that hit
 *                            this should be patched to map the
 *                            specific case explicitly.
 */
export type ProviderErrorKind =
  | 'no-credentials'
  | 'unauthorized'
  | 'forbidden'
  | 'rate-limited'
  | 'server-error'
  | 'client-error'
  | 'network'
  | 'invalid-response'
  | 'aborted'
  | 'unknown';

export interface ProviderError {
  readonly kind: ProviderErrorKind;
  readonly provider: LlmProvider;
  /** Human-readable message. Safe to log; should not contain key
   *  material — adapters MUST scrub before placing here. */
  readonly message: string;
  /** HTTP status when transport-shaped. Absent for pre-flight,
   *  network, aborted, invalid-response. */
  readonly status?: number;
  /**
   * Seconds to wait before retrying. Set ONLY for `'rate-limited'`
   * when the provider advertised a `Retry-After` header. Higher-level
   * retry policy uses this when present; falls back to its own
   * exponential backoff when absent.
   */
  readonly retryAfterSec?: number;
}

/**
 * Pre-flight config validation. Synchronous, no I/O. Catches:
 *
 *   - missing or empty API key       → no-credentials
 *   - missing or empty model id      → client-error
 *
 * Adapters MAY widen the check with provider-specific rules
 * (e.g. "openrouter model id MUST contain a `/`"). Failures
 * surface through the same {@link ProviderError} so callers branch
 * on one union.
 */
export type ProviderValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: ProviderError };

/**
 * The contract every provider client implements.
 */
export interface ProviderAdapter {
  /** Provider this adapter speaks to. Stable identifier; lets the
   *  caller route a `ProviderRequest` to the right adapter. */
  readonly provider: LlmProvider;
  /**
   * Pre-flight check. MUST return synchronously and MUST NOT touch
   * the network. Returns `{ok: true}` when the request is at least
   * structurally valid; returns `{ok: false, error}` otherwise.
   */
  validateConfig(request: Pick<ProviderRequest, 'apiKey' | 'route'>): ProviderValidation;
  /**
   * Single-completion call. Resolves with `{ok: true, response}` on
   * success or `{ok: false, error}` on any failure (network,
   * provider 4xx/5xx, abort). Implementations MUST:
   *
   *   1. Funnel every raw provider error through `mapError`.
   *   2. NOT throw. The result discriminator IS the error path.
   *   3. Forward `request.signal` into the provider SDK's abort
   *      mechanism + return `kind:'aborted'` when fired.
   */
  complete(request: ProviderRequest): Promise<ProviderResult>;
  /**
   * Map an arbitrary thrown / rejected value into a
   * {@link ProviderError}. Exposed (not just internal) so test
   * harnesses + retry policies can normalize errors without going
   * through `complete`.
   *
   * MUST NEVER throw — `mapError(unknown)` is the safety net.
   */
  mapError(raw: unknown): ProviderError;
}

/**
 * Discriminated result of a `complete` call. Mirrors `validateConfig`
 * so callers never have to handle thrown errors from this seam.
 */
export type ProviderResult =
  | { readonly ok: true; readonly response: ProviderResponse }
  | { readonly ok: false; readonly error: ProviderError };

// ─── Helpers concrete adapters compose with ────────────────────────

/**
 * Build a `ProviderError` of the supplied kind. Centralized so
 * concrete adapters don't drift on field shape. Provider-aware so
 * callers don't have to thread it through.
 */
export function makeProviderError(args: {
  readonly kind: ProviderErrorKind;
  readonly provider: LlmProvider;
  readonly message: string;
  readonly status?: number;
  readonly retryAfterSec?: number;
}): ProviderError {
  const out: ProviderError = {
    kind: args.kind,
    provider: args.provider,
    message: args.message,
    ...(args.status !== undefined ? { status: args.status } : {}),
    ...(args.retryAfterSec !== undefined
      ? { retryAfterSec: args.retryAfterSec }
      : {}),
  };
  return out;
}

/**
 * Map an HTTP status code to the canonical error kind. Adapters
 * call this from `mapError` after they've classified the failure as
 * "the provider returned a status we understand". Network / abort /
 * pre-flight live outside this mapping.
 */
export function statusToErrorKind(status: number): ProviderErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rate-limited';
  if (status >= 500 && status < 600) return 'server-error';
  if (status >= 400 && status < 500) return 'client-error';
  return 'unknown';
}

/**
 * Default `validateConfig` implementation. Concrete adapters
 * compose this and add their own provider-specific checks on top.
 *
 * Catches the two universal failures: missing key + missing model.
 * Returns `{ok: true}` when both are present.
 *
 * The model-id check is defense-in-depth — typed `LlmRoute` callers
 * cannot construct a route with an empty model string, but the
 * adapter still validates at runtime in case the request crossed an
 * untyped JSON boundary (e.g. deserialized from a wire format).
 */
export function defaultValidateConfig(
  provider: LlmProvider,
  request: Pick<ProviderRequest, 'apiKey' | 'route'>,
): ProviderValidation {
  if (!request.apiKey || request.apiKey.length === 0) {
    return {
      ok: false,
      error: makeProviderError({
        kind: 'no-credentials',
        provider,
        message: `${provider}: no API key supplied`,
      }),
    };
  }
  if (!request.route?.model || request.route.model.length === 0) {
    return {
      ok: false,
      error: makeProviderError({
        kind: 'client-error',
        provider,
        message: `${provider}: model id is required`,
      }),
    };
  }
  return { ok: true };
}
