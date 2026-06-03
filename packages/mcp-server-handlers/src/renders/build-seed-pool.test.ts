import { describe, it, expect } from 'vitest';
import { buildSeedPool } from './build-seed-pool.js';
import { findBlueprintExact } from './blueprint-registry.js';
import { findBlueprintsByEmbedding } from './blueprint-registry.js';
import { blueprintKey, variantKey, toPortableBlueprint } from '@ggui-ai/protocol/blueprint-key';
import type { BlueprintSource } from './blueprint-source.js';
import type { PortableBlueprint } from '@ggui-ai/protocol';

const contract = { propsSpec: { properties: { title: { schema: { type: 'string' } } } } };
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
});
