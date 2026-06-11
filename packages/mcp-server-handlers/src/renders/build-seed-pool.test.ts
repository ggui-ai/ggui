import { describe, it, expect, vi } from 'vitest';
import { buildSeedPool } from './build-seed-pool.js';
import { findBlueprintExact } from './blueprint-registry.js';
import { findBlueprintsByEmbedding } from './blueprint-registry.js';
import {
  blueprintKey,
  variantKey,
  toPortableBlueprint,
  PORTABLE_BLUEPRINT_V1_REJECTION,
} from '@ggui-ai/protocol/blueprint-key';
import { PROTOCOL_VERSION } from '@ggui-ai/protocol';
import type { SeedPoolSource } from './seed-pool-source.js';
import type { ImportGateCtx } from './import-gate.js';
import type { PortableBlueprint, DataContract } from '@ggui-ai/protocol';

const contract: DataContract = {
  propsSpec: { properties: { title: { schema: { type: 'string' } } } },
};
const LLM_SOURCE = {
  kind: 'llm',
  generator: 'ui-gen-default-haiku-4-5',
  model: 'claude-haiku-4-5',
} as const;
const record: PortableBlueprint = toPortableBlueprint({
  contract, componentCode: 'export default () => null;', variance: {}, source: LLM_SOURCE,
});
const poolSource: SeedPoolSource = { label: 'test', loadAll: async () => [record] };

describe('buildSeedPool', () => {
  it('makes records reusable by exact key under the fixed scope', async () => {
    const poolP = await buildSeedPool(poolSource, { scope: 'shared' });
    const hit = await findBlueprintExact(
      { vectorStore: poolP.registry.vectorStore, index: poolP.registry.index },
      'shared', 'template', blueprintKey(contract), variantKey({}),
    );
    expect(hit).not.toBeNull();
    expect(poolP.scope).toBe('shared');
    expect(poolP.label).toBe('test');
  });

  it('is semantic-inert (vectorStore.query yields no candidates)', async () => {
    const poolP = await buildSeedPool(poolSource, { scope: 'shared' });
    const candidates = await findBlueprintsByEmbedding(poolP.registry, 'shared', { intent: 'a todo list' });
    expect(candidates).toEqual([]);
  });

  it('defaults the scope to "shared"', async () => {
    expect((await buildSeedPool(poolSource, {})).scope).toBe('shared');
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
      contract, componentCode: 'export default () => null;', variance: {}, source: LLM_SOURCE,
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

  it('with an import-gate ctx, filters out a retired-field record and keeps the good one', async () => {
    const good = record;
    // A record whose contract carries a retired top-level field — the gate
    // hard-rejects it. Craft the contract directly so the retired key rides
    // through the PortableBlueprint untouched.
    const retiredContract = {
      propsSpec: { properties: { title: { schema: { type: 'string' } } } },
      wiredTools: { foo: { name: 'foo' } },
    } as unknown as DataContract;
    const bad: PortableBlueprint = toPortableBlueprint({
      contract: retiredContract,
      componentCode: 'export default () => null;',
      variance: {},
      source: LLM_SOURCE,
    });
    const ctx: ImportGateCtx = { protocolVersion: PROTOCOL_VERSION, catalog: {} };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const poolP = await buildSeedPool(
        { label: 'mixed', loadAll: async () => [good, bad] },
        { scope: 'shared', ctx },
      );
      // The good record is reusable.
      const goodHit = await findBlueprintExact(
        { vectorStore: poolP.registry.vectorStore, index: poolP.registry.index },
        'shared', 'template', blueprintKey(contract), variantKey({}),
      );
      expect(goodHit).not.toBeNull();
      // The bad record was filtered out — its key is absent.
      const badHit = await findBlueprintExact(
        { vectorStore: poolP.registry.vectorStore, index: poolP.registry.index },
        'shared', 'template', blueprintKey(retiredContract), variantKey({}),
      );
      expect(badHit).toBeNull();
      // The skip was reported.
      const reported = warn.mock.calls
        .map((c) => String(c[0]))
        .some((m) => /skipped a blueprint failing the import gate/.test(m));
      expect(reported).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('without a ctx, applies NO gating (a retired-field record still registers)', async () => {
    // The persistence-contract GATE is opt-in via ctx; the v2 shape
    // validation (fromPortableBlueprint) is not — it always runs.
    const retiredContract = {
      propsSpec: { properties: { title: { schema: { type: 'string' } } } },
      wiredTools: { foo: { name: 'foo' } },
    } as unknown as DataContract;
    const bad: PortableBlueprint = toPortableBlueprint({
      contract: retiredContract,
      componentCode: 'export default () => null;',
      variance: {},
      source: LLM_SOURCE,
    });
    const poolP = await buildSeedPool(
      { label: 'ungated', loadAll: async () => [bad] },
      { scope: 'shared' },
    );
    const hit = await findBlueprintExact(
      { vectorStore: poolP.registry.vectorStore, index: poolP.registry.index },
      'shared', 'template', blueprintKey(retiredContract), variantKey({}),
    );
    expect(hit).not.toBeNull();
  });

  it('preserves the artifact record provenance on the loaded row', async () => {
    const poolP = await buildSeedPool(poolSource, { scope: 'shared' });
    const hit = await findBlueprintExact(
      { vectorStore: poolP.registry.vectorStore, index: poolP.registry.index },
      'shared', 'template', blueprintKey(contract), variantKey({}),
    );
    // An llm-minted record stays llm-sourced — importing never
    // re-labels authorship.
    expect(hit?.source).toEqual(LLM_SOURCE);
  });

  it('skips a schemaVersion-1 record with the canonical rejection message (pool load = skip-with-log)', async () => {
    const v1Record: Record<string, unknown> = { ...record, schemaVersion: 1 };
    delete v1Record['source'];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const poolP = await buildSeedPool(
        { label: 'mixed-era', loadAll: async () => [v1Record, record] },
        { scope: 'shared' },
      );
      // The v2 record still loads — one rejected seed entry is just a
      // cold-gen, never an aborted build.
      const hit = await findBlueprintExact(
        { vectorStore: poolP.registry.vectorStore, index: poolP.registry.index },
        'shared', 'template', blueprintKey(contract), variantKey({}),
      );
      expect(hit).not.toBeNull();
      const reported = warn.mock.calls
        .map((c) => String(c[0]))
        .some((m) => m.includes(PORTABLE_BLUEPRINT_V1_REJECTION));
      expect(reported).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not throw on an empty seedPrompt and stays reusable', async () => {
    const emptyPrompt = toPortableBlueprint({
      contract,
      componentCode: 'export default () => null;',
      variance: { seedPrompt: '' },
      source: LLM_SOURCE,
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
