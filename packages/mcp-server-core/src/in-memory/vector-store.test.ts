import {
  enumerableVectorStoreContract,
  keyedVectorStoreContract,
  vectorStoreContract,
} from '../contract-tests/vector-store.js';
import { InMemoryVectorStore } from './vector-store.js';

vectorStoreContract('InMemoryVectorStore', () => new InMemoryVectorStore());
enumerableVectorStoreContract(
  'InMemoryVectorStore',
  () => new InMemoryVectorStore(),
);
keyedVectorStoreContract('InMemoryVectorStore', () => new InMemoryVectorStore());
