/**
 * Plaintext / file-backed reference adapters for
 * `@ggui-ai/mcp-server-core`. Personal-mode OSS defaults:
 * auditable, single-user, filesystem-first.
 *
 * Scope — intentionally small for this slice:
 *   - {@link PlaintextFileProviderKeyStore} — BYOK outbound LLM keys.
 *   - {@link PlaintextFileApiKeyProvider}   — inbound API keys (hash-only).
 *
 * Each adapter writes a single JSON document at the configured
 * path with `chmod 0o600`. Hosts that care about multi-user
 * isolation or encryption at rest bind a production adapter
 * against the same interface — these are OSS defaults, not a
 * secret-management subsystem.
 */

export { PlaintextFileProviderKeyStore } from './provider-key-store.js';
export type { PlaintextFileProviderKeyStoreOptions } from './provider-key-store.js';
export { PlaintextFileApiKeyProvider } from './api-key-provider.js';
export type { PlaintextFileApiKeyProviderOptions } from './api-key-provider.js';
