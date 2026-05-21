import { threadStoreContract } from '../contract-tests/thread-store.js';
import { InMemoryThreadStore } from './thread-store.js';

threadStoreContract(
  'InMemoryThreadStore',
  () => new InMemoryThreadStore(),
);
