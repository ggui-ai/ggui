import { apiKeyProviderContract } from '../contract-tests/api-key-provider.js';
import { InMemoryApiKeyProvider } from './api-key-provider.js';

apiKeyProviderContract(
  'InMemoryApiKeyProvider',
  () => new InMemoryApiKeyProvider(),
);
