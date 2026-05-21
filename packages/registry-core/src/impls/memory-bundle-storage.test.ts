import { bundleStorageContract } from '../testing/bundle-storage-contract.js';
import { inMemoryBundleStorage } from './memory-bundle-storage.js';

bundleStorageContract(() => inMemoryBundleStorage({ bundleHost: 'https://test.invalid' }));
