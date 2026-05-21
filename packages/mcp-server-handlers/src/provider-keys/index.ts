/**
 * Bring-your-own-key provider-key handler family.
 *
 * Three thin wrappers over the {@link ProviderKeyStore} seam. Cloud
 * deployments bind an AWS-backed store (database + KMS); tests bind
 * in-memory.
 *
 * All seam-pure: no AWS imports, no logging side-channel. NEVER
 * leaks plaintext or the encrypted ciphertext through any tool
 * result.
 */

export type {
  ProviderName,
  ProviderKeySummary,
  ProviderKeyStore,
  SetProviderKeyInput,
  RemoveResult,
} from './types.js';
export { SUPPORTED_PROVIDERS, isProviderName } from './types.js';

export { createListProviderKeysHandler } from './list-provider-keys.js';
export type {
  ListProviderKeysDeps,
  ListProviderKeysOutput,
} from './list-provider-keys.js';

export { createSetProviderKeyHandler } from './set-provider-key.js';
export type { SetProviderKeyDeps } from './set-provider-key.js';

export { createRemoveProviderKeyHandler } from './remove-provider-key.js';
export type { RemoveProviderKeyDeps } from './remove-provider-key.js';
