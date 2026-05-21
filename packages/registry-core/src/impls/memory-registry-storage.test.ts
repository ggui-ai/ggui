import { registryStorageContract } from '../testing/registry-storage-contract.js';
import { inMemoryRegistryStorage } from './memory-registry-storage.js';

registryStorageContract(() => inMemoryRegistryStorage());
