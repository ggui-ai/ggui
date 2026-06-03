import { describe, it, expect } from 'vitest';
import { InMemoryVectorStore, InMemoryBlueprintIndex } from '@ggui-ai/mcp-server-core/in-memory';
import { registerBlueprint } from './blueprint-registry.js';
import { listRegistryBlueprintsForExport } from './export-registry.js';

const embedding = { id: 'x', dimensions: 1, embed: async () => [0] };

describe('listRegistryBlueprintsForExport', () => {
  it('returns contract+componentCode+variance for every stored template blueprint', async () => {
    const registry = { embedding, vectorStore: new InMemoryVectorStore(), index: new InMemoryBlueprintIndex() };
    await registerBlueprint(registry, 'builder', {
      kind: 'template', // RegisterBlueprintInput requires kind; blueprints are always templates
      contract: { propsSpec: { properties: { a: { schema: { type: 'string' } } } } },
      intent: 'x', componentCode: 'export default () => null;', provenance: 'register', variance: {},
    });
    const rows = await listRegistryBlueprintsForExport(registry.vectorStore, 'builder');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.componentCode).toBe('export default () => null;');
    expect(rows[0]!.contract).toEqual({ propsSpec: { properties: { a: { schema: { type: 'string' } } } } });
  });
});
