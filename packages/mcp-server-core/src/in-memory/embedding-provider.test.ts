import { embeddingProviderContract } from '../contract-tests/embedding-provider.js';
import { MockEmbeddingProvider } from './embedding-provider.js';

embeddingProviderContract(
  'MockEmbeddingProvider (default dimensions=32)',
  () => new MockEmbeddingProvider(),
);

embeddingProviderContract(
  'MockEmbeddingProvider (dimensions=128)',
  () => new MockEmbeddingProvider({ dimensions: 128 }),
);
