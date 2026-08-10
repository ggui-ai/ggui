/**
 * `CodeStore` conformance runner for this package's reference impl.
 *
 * `FileSystemCodeStore` (`@ggui-ai/mcp-server`) and any hosted adapter
 * plug their own runners in from their own packages.
 */
import { InMemoryCodeStore } from '../in-memory/code-store.js';
import { runCodeStoreConformance } from './code-store.conformance.js';

runCodeStoreConformance('InMemoryCodeStore', {
  expectedDurability: 'ephemeral',
  create: async () => new InMemoryCodeStore(),
});
