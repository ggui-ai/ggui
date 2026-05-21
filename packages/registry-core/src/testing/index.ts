/**
 * Contract test helpers for {@link RegistryStorage} + {@link BundleStorage}.
 *
 * Subpath export — consumers `import { registryStorageContract } from
 * '@ggui-ai/registry-core/testing'`. Requires `vitest` at test-runtime
 * (declared as an optional peerDep).
 */
export { registryStorageContract } from './registry-storage-contract.js';
export { bundleStorageContract } from './bundle-storage-contract.js';
