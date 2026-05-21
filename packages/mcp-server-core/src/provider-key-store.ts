/**
 * ProviderKeyStore — BYOK credential storage for LLM providers.
 *
 * Sits between the server and the harness. When
 * `UiGenerator.generate(...)` runs, the server resolves a
 * {@link ProviderKeyRef} for the target app + provider by calling this
 * store. The resolved key flows into the UI-generation input as
 * plaintext and is NOT persisted by the harness.
 *
 * **Scope (deliberately narrow):**
 *
 *   - Keyed by `(appId, provider)`. Every app scopes its own BYOK
 *     credentials. Cross-app isolation is the caller's responsibility
 *     via the `appId` they pass.
 *   - Values are opaque strings (API key, bearer token, assume-role
 *     ARN). The store doesn't interpret them.
 *   - `get` returns plaintext at the harness boundary — only the
 *     server's provider-resolution path should ever call it. List /
 *     metadata operations intentionally do NOT echo key material.
 *
 * **Explicitly out of scope** (kept here so future work stays
 * honest):
 *
 *   - KMS-wrapped values, HSM integration, per-key rotation policy,
 *     per-key audit log, per-key scope (which app features can use
 *     this key). All real — none belong in this interface.
 *   - Hosted-runtime sharing (an org-level key that many apps inherit).
 *     Layer on top with a wrapping `ProviderKeyStore` that falls
 *     through to a workspace-default.
 *
 * **Relationship to {@link ApiKeyProvider}:** different concerns.
 * `ProviderKeyStore` stores keys the server hands to a provider
 * (outbound — LLM calls). `ApiKeyProvider` stores keys the server
 * issues to agents (inbound — auth). Never collapse them.
 *
 * **OSS reference adapters:**
 *   - `InMemoryProviderKeyStore` — ephemeral Map, tests + dev.
 *   - `PlaintextFileProviderKeyStore` — JSON on disk, personal mode.
 *
 * Production bindings (Keychain, Secrets Manager, Vault, SQLite, …)
 * bind to the same interface; every binding MUST pass
 * `providerKeyStoreContract`.
 */
import type { LlmProvider, ProviderKeyRef } from './ui-generator.js';

/**
 * The contract. Every method is async so on-disk / over-network
 * bindings fit without wrapping.
 */
export interface ProviderKeyStore {
  /**
   * Resolve the stored key for `(appId, provider)`. Returns the
   * plaintext {@link ProviderKeyRef} the harness needs, or `null` if
   * no key is configured.
   */
  get(appId: string, provider: LlmProvider): Promise<ProviderKeyRef | null>;

  /**
   * Persist a key for `(appId, provider)`. Overwrites any existing
   * entry — rotation is just a subsequent `set`. Returns the stored
   * record so callers can confirm what's in the store.
   *
   * Implementations that encrypt at rest (KMS-wrapped, Keychain)
   * accept plaintext here; transformation is an implementation
   * detail.
   */
  set(
    appId: string,
    provider: LlmProvider,
    key: string,
  ): Promise<ProviderKeyRef>;

  /**
   * Remove the key for `(appId, provider)`. Idempotent — removing a
   * missing key does not throw.
   */
  delete(appId: string, provider: LlmProvider): Promise<void>;

  /**
   * List providers that have a key configured for `appId`. Used by
   * dashboards / provider-picker UIs.
   *
   * **Does NOT return key material.** Every binding MUST return
   * only the provider names. The contract test asserts this.
   */
  listProviders(appId: string): Promise<LlmProvider[]>;
}
