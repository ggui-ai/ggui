/**
 * Bring-your-own-key provider-key handler family.
 *
 * Three thin wrappers over the {@link ProviderKeyStore} seam (plus
 * the optional {@link AppScopedProviderKeyStore} sibling for
 * deployments that store per-app keys). Cloud deployments bind an
 * encrypting datastore-backed store; tests bind in-memory.
 *
 * All seam-pure: no AWS imports, no logging side-channel. NEVER
 * leaks plaintext or the encrypted ciphertext through any tool
 * result.
 */

export type {
  ProviderName,
  ProviderKeySummary,
  ProviderKeyStore,
  AppScopedProviderKeyStore,
  SetProviderKeyInput,
  RemoveResult,
} from './types.js';
export {
  AppScopedKeyAppNotFoundError,
  AppScopedKeysUnavailableError,
  SUPPORTED_PROVIDERS,
  isProviderName,
} from './types.js';

export { createListProviderKeysHandler } from './list-provider-keys.js';
export type {
  ListProviderKeysDeps,
  ListProviderKeysOutput,
} from './list-provider-keys.js';

export { createSetProviderKeyHandler } from './set-provider-key.js';
export type { SetProviderKeyDeps } from './set-provider-key.js';

export { createRemoveProviderKeyHandler } from './remove-provider-key.js';
export type { RemoveProviderKeyDeps } from './remove-provider-key.js';
