import { describe, it, expect, vi } from 'vitest';
import { InMemoryVectorStore, InMemoryBlueprintIndex } from '@ggui-ai/mcp-server-core/in-memory';
import type { VectorStore } from '@ggui-ai/mcp-server-core';
import { registerBlueprint } from './blueprint-registry.js';
import { listRegistryBlueprintsForExport } from './export-registry.js';

const embedding = { id: 'x', dimensions: 1, embed: async () => [0] };

describe('listRegistryBlueprintsForExport', () => {
  it('returns contract+componentCode+variance+source for every stored template blueprint', async () => {
    const registry = { embedding, vectorStore: new InMemoryVectorStore(), index: new InMemoryBlueprintIndex() };
    await registerBlueprint(registry, 'builder', {
      kind: 'template', // RegisterBlueprintInput requires kind; blueprints are always templates
      contract: { propsSpec: { properties: { a: { schema: { type: 'string' } } } } },
      intent: 'x', componentCode: 'export default () => null;', source: { kind: 'user' }, variance: {},
    });
    const rows = await listRegistryBlueprintsForExport(registry.vectorStore, 'builder');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.componentCode).toBe('export default () => null;');
    expect(rows[0]!.contract).toEqual({ propsSpec: { properties: { a: { schema: { type: 'string' } } } } });
    // Provenance is threaded through so the export codec can stamp
    // PortableBlueprint v2's required `source`.
    expect(rows[0]!.source).toEqual({ kind: 'user' });
  });

  it('throws when the vector store is not enumerable (no listByScope)', async () => {
    // A backend that implements only the base VectorStore contract — no
    // cheap "list all" API. Export must refuse rather than silently
    // returning [].
    const nonEnumerable: VectorStore = {
      putVector: async () => {},
      deleteVector: async () => {},
      query: async () => [],
    };
    await expect(
      listRegistryBlueprintsForExport(nonEnumerable, 'builder'),
    ).rejects.toThrow(/not enumerable/);
  });

  it('skips a row with corrupt contract JSON and keeps the rest (no throw)', async () => {
    const store = new InMemoryVectorStore();
    // A corrupt row: contract is not valid JSON. Hand-written directly so we
    // exercise the skip-and-continue branch the registry writer never produces.
    await store.putVector('builder', {
      key: 'bp_corrupt',
      vector: [0],
      metadata: {
        kind: 'template',
        contract: 'not json{',
        componentCode: 'export default () => null;',
        variance: '{}',
        sourceKind: 'user',
      },
    });
    // A good row alongside it must survive.
    await store.putVector('builder', {
      key: 'bp_good',
      vector: [0],
      metadata: {
        kind: 'template',
        contract: JSON.stringify({ propsSpec: { properties: { a: { schema: { type: 'string' } } } } }),
        componentCode: 'export default () => 1;',
        variance: '{}',
        sourceKind: 'user',
      },
    });
    const rows = await listRegistryBlueprintsForExport(store, 'builder');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.componentCode).toBe('export default () => 1;');
  });

  it('skips a row without valid provenance (legacy flat vocabulary) with a log line', async () => {
    const store = new InMemoryVectorStore();
    await store.putVector('builder', {
      key: 'bp_legacy',
      vector: [0],
      metadata: {
        kind: 'template',
        contract: JSON.stringify({ propsSpec: { properties: {} } }),
        componentCode: 'export default () => null;',
        variance: '{}',
        provenance: 'register',
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const rows = await listRegistryBlueprintsForExport(store, 'builder');
      expect(rows).toHaveLength(0);
      const reported = warn.mock.calls
        .map((c) => String(c[0]))
        .some((m) => /missing or malformed provenance/.test(m));
      expect(reported).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('skips a non-template kind row', async () => {
    const store = new InMemoryVectorStore();
    await store.putVector('builder', {
      key: 'bp_molecule',
      vector: [0],
      metadata: {
        kind: 'molecule',
        contract: JSON.stringify({ propsSpec: { properties: {} } }),
        componentCode: 'export default () => null;',
        variance: '{}',
        sourceKind: 'user',
      },
    });
    const rows = await listRegistryBlueprintsForExport(store, 'builder');
    expect(rows).toHaveLength(0);
  });
});
