/**
 * ApiKeyProvider — API keys the SERVER issues to agents.
 *
 * Composes with {@link AuthAdapter}:
 * `ApiKeyProvider.verify(secret)` is the lookup used by the
 * `ApiKeyAuthAdapter` (future extension) at request ingress. Every
 * minted key is scoped to a single `appId` and is presented to the
 * caller ONCE — the store keeps only a hash for later verification.
 *
 * **Scope (deliberately narrow):**
 *
 *   - One secret → one {@link ApiKey} record → one `appId`.
 *   - `mint` returns the plaintext secret exactly once; `list`
 *     never returns secrets.
 *   - `verify` uses a constant-time comparison on the hash (binding
 *     implementations MUST use `timingSafeEqual` or equivalent).
 *   - `revoke` is idempotent by id.
 *
 * **Explicitly out of scope** (kept here so future work stays
 * honest):
 *
 *   - Per-key scopes / permissions beyond `appId`. Every key has
 *     full app-level access today.
 *   - Expiring keys / auto-rotation.
 *   - Per-key rate limits. Layer on top via `RateLimiter`.
 *   - Organisation-level keys, workspace-shared keys — hosted
 *     closed-runtime territory, not OSS.
 *
 * **Relationship to {@link AuthAdapter}:** distinct. `AuthAdapter`
 * is framework-agnostic identity resolution. `ApiKeyProvider` is
 * the API-key lifecycle store that one kind of `AuthAdapter`
 * consults. An OSS deployment can skip `ApiKeyProvider` entirely
 * and use a dev-mode `InMemoryAuthAdapter` — keys become a real
 * concern when the operator hardens auth.
 *
 * **Relationship to {@link ProviderKeyStore}:** different direction.
 * `ProviderKeyStore` = outbound (server → LLM provider). This =
 * inbound (agent → server). Never collapse them.
 *
 * **OSS reference adapters:**
 *   - `InMemoryApiKeyProvider` — ephemeral Map, tests + dev.
 *   - `PlaintextFileApiKeyProvider` — JSON on disk (hash-only).
 *
 * Production bindings (DynamoDB, Postgres, Keychain) bind the same
 * interface; every binding MUST pass `apiKeyProviderContract`.
 */

/**
 * Stored record for an issued key. Never contains the plaintext
 * secret — only a hash and public metadata.
 */
export interface ApiKey {
  /** Stable id (public — shown in "api keys" lists, logs, etc.). */
  id: string;
  /** The app this key is scoped to. */
  appId: string;
  /** Display label — "laptop agent", "ci runner", etc. */
  label?: string;
  /** Epoch ms at mint time. */
  createdAt: number;
  /**
   * Epoch ms of the most recent successful `verify`. Optional;
   * implementations MAY update this asynchronously / at a lower
   * frequency for write-performance reasons.
   */
  lastUsedAt?: number;
}

/**
 * Return shape of {@link ApiKeyProvider.mint} — the plaintext
 * secret PLUS the stored record. The caller MUST surface the
 * secret to the user exactly once (CLI output, dashboard reveal)
 * and never persist it locally.
 */
export interface MintedApiKey {
  readonly record: ApiKey;
  /** Plaintext bearer secret. One-shot — the store does not
   *  retain it. */
  readonly secret: string;
}

/**
 * Input for {@link ApiKeyProvider.mint}.
 */
export interface MintApiKeyInput {
  appId: string;
  label?: string;
}

export interface ApiKeyProvider {
  /**
   * Verify a plaintext bearer secret. Returns the matching
   * {@link ApiKey} record on success, `null` otherwise. Comparison
   * MUST be constant-time.
   *
   * Implementations SHOULD update `record.lastUsedAt` on a hit;
   * best-effort / async is fine.
   */
  verify(secret: string): Promise<ApiKey | null>;

  /**
   * Mint a fresh key for the given `appId`. Returns the plaintext
   * secret exactly once — the store only retains the hash + public
   * record.
   */
  mint(input: MintApiKeyInput): Promise<MintedApiKey>;

  /**
   * List keys issued for `appId`. Returns public records only —
   * NEVER includes secrets or hashes. Order is
   * implementation-defined; callers sort if they care.
   */
  list(appId: string): Promise<ApiKey[]>;

  /**
   * Revoke a key by id. Idempotent — revoking a missing or
   * already-revoked key does not throw.
   */
  revoke(id: string): Promise<void>;
}
