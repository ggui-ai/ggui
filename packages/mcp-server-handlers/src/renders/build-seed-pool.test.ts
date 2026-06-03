import { describe, it, expect, vi } from 'vitest';
import { buildSeedPool } from './build-seed-pool.js';
import { findBlueprintExact } from './blueprint-registry.js';
import { findBlueprintsByEmbedding } from './blueprint-registry.js';
import { blueprintKey, variantKey, toPortableBlueprint } from '@ggui-ai/protocol/blueprint-key';
import type { BlueprintSource } from './blueprint-source.js';
import type { PortableBlueprint, DataContract } from '@ggui-ai/protocol';

const contract: DataContract = {
  propsSpec: { properties: { title: { schema: { type: 'string' } } } },
};
const record: PortableBlueprint = toPortableBlueprint({
  contract, componentCode: 'export default () => null;', generator: 'g', variance: {},
});
const source: BlueprintSource = { label: 'test', loadAll: async () => [record] };

describe('buildSeedPool', () => {
  it('makes records reusable by exact key under the fixed scope', async () => {
    const poolP = await buildSeedPool(source, { scope: 'shared' });
    const hit = await findBlueprintExact(
      { vectorStore: poolP.registry.vectorStore, index: poolP.registry.index },
      'shared', 'template', blueprintKey(contract), variantKey({}),
    );
    expect(hit).not.toBeNull();
    expect(poolP.scope).toBe('shared');
    expect(poolP.label).toBe('test');
  });

  it('is semantic-inert (vectorStore.query yields no candidates)', async () => {
    const poolP = await buildSeedPool(source, { scope: 'shared' });
    const candidates = await findBlueprintsByEmbedding(poolP.registry, 'shared', { intent: 'a todo list' });
    expect(candidates).toEqual([]);
  });

  it('defaults the scope to "shared"', async () => {
    expect((await buildSeedPool(source, {})).scope).toBe('shared');
  });

  it('still builds + stays reusable when a shipped contractHash is tampered (keyMismatch warns)', async () => {
    const tampered: PortableBlueprint = { ...record, contractHash: 'tampered-not-a-real-hash' };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const poolP = await buildSeedPool(
        { label: 'tampered', loadAll: async () => [tampered] },
        { scope: 'shared' },
      );
      // Recomputed key wins — reusable under the true contract hash.
      const hit = await findBlueprintExact(
        { vectorStore: poolP.registry.vectorStore, index: poolP.registry.index },
        'shared', 'template', blueprintKey(contract), variantKey({}),
      );
      expect(hit).not.toBeNull();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('dedups two records with the same (contract, variance) without throwing', async () => {
    // Two distinct record objects, identical contract + variance — first-write-wins.
    const dup = toPortableBlueprint({
      contract, componentCode: 'export default () => null;', generator: 'g', variance: {},
    });
    const poolP = await buildSeedPool(
      { label: 'dup', loadAll: async () => [record, dup] },
      { scope: 'shared' },
    );
    const hit = await findBlueprintExact(
      { vectorStore: poolP.registry.vectorStore, index: poolP.registry.index },
      'shared', 'template', blueprintKey(contract), variantKey({}),
    );
    expect(hit).not.toBeNull();
  });

  it('does not throw on an empty seedPrompt and stays reusable', async () => {
    const emptyPrompt = toPortableBlueprint({
      contract,
      componentCode: 'export default () => null;',
      generator: 'g',
      variance: { seedPrompt: '' },
    });
    const poolP = await buildSeedPool(
      { label: 'empty-prompt', loadAll: async () => [emptyPrompt] },
      { scope: 'shared' },
    );
    const hit = await findBlueprintExact(
      { vectorStore: poolP.registry.vectorStore, index: poolP.registry.index },
      'shared', 'template', blueprintKey(contract), variantKey({ seedPrompt: '' }),
    );
    expect(hit).not.toBeNull();
  });
});
