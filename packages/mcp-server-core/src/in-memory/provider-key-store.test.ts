import { providerKeyStoreContract } from '../contract-tests/provider-key-store.js';
import { InMemoryProviderKeyStore } from './provider-key-store.js';

providerKeyStoreContract(
  'InMemoryProviderKeyStore',
  () => new InMemoryProviderKeyStore(),
);
