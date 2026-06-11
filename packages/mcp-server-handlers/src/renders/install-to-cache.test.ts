/**
 * Slice 5.1 (2026-05-18) — `installToCache` bridge.
 *
 * Pins the contract: the bridge forces `source: {kind: 'user'}` + the
 * `installed` lifecycle marker, rejects empty componentCode (would
 * serve blank on cache hit), and is otherwise a thin pass-through to
 * `registerBlueprint`. The matcher MUST be unable to distinguish a
 * bridge-owned row from any other row when looking up by canonical
 * contract key.
 */
import { describe, expect, it } from 'vitest';
import {
  InMemoryBlueprintIndex,
  InMemoryVectorStore,
  MockEmbeddingProvider,
} from '@ggui-ai/mcp-server-core/in-memory';
import type { DataContract } from '@ggui-ai/protocol';
import { blueprintKey } from '@ggui-ai/protocol/blueprint-key';
import {
  findBlueprintExact,
  listBlueprints,
} from './blueprint-registry.js';
import { installToCache } from './install-to-cache.js';

const SCOPE = 'app-install';

const COUNTER_CONTRACT: DataContract = {
  contextSpec: {
    count: { schema: { type: 'number' }, default: 0 },
  },
  actionSpec: { increment: { label: 'Increment' } },
};

function makeDeps(): {
  embedding: MockEmbeddingProvider;
  vectorStore: InMemoryVectorStore;
  index: InMemoryBlueprintIndex;
} {
  return {
    embedding: new MockEmbeddingProvider(),
    vectorStore: new InMemoryVectorStore(),
    index: new InMemoryBlueprintIndex(),
  };
}

describe('installToCache', () => {
  it('writes a user-sourced, bridge-owned blueprint', async () => {
    const deps = makeDeps();
    const bp = await installToCache(deps, SCOPE, {
      contract: COUNTER_CONTRACT,
      componentCode: 'export default () => null;',
      intent: 'A counter from @vendor/counter@1.0.0',
    });
    expect(bp.source).toEqual({ kind: 'user' });
    expect(bp.installed).toBe(true);
    expect(bp.kind).toBe('template');
    expect(bp.contractKey).toBe(blueprintKey(COUNTER_CONTRACT));
    expect(bp.id).toMatch(/^bp_[0-9a-f-]{36}$/);
  });

  it('produces a matcher-visible row at the canonical contract key', async () => {
    // The whole point of Slice 5: installed blueprints share the same
    // read surface as synth/register entries. A subsequent exact-key
    // lookup against the same canonical contract MUST hit.
    const deps = makeDeps();
    await installToCache(deps, SCOPE, {
      contract: COUNTER_CONTRACT,
      componentCode: 'export default () => "installed";',
      intent: 'A counter from @vendor/counter@1.0.0',
    });
    const hit = await findBlueprintExact(
      { vectorStore: deps.vectorStore, index: deps.index },
      SCOPE,
      'template',
      blueprintKey(COUNTER_CONTRACT),
    );
    expect(hit).not.toBeNull();
    expect(hit?.source).toEqual({ kind: 'user' });
    expect(hit?.installed).toBe(true);
    expect(hit?.componentCode).toBe('export default () => "installed";');
  });

  it('rejects empty componentCode (cache hit would serve blank render)', async () => {
    const deps = makeDeps();
    await expect(
      installToCache(deps, SCOPE, {
        contract: COUNTER_CONTRACT,
        componentCode: '',
        intent: 'broken install',
      }),
    ).rejects.toThrow(/componentCode is empty/);
  });

  it('rejects empty intent (delegates to registerBlueprint guard)', async () => {
    // Same fail-closed posture as registerBlueprint — an empty intent
    // would corrupt the RAG embedding input.
    const deps = makeDeps();
    await expect(
      installToCache(deps, SCOPE, {
        contract: COUNTER_CONTRACT,
        componentCode: 'export default () => null;',
        intent: '   ',
      }),
    ).rejects.toThrow(/intent cannot be empty/);
  });

  it('coexists in the same scope with cold-gen (llm-sourced) entries', async () => {
    // Verifies unification: cold-gen + installed entries with different
    // contract keys live side-by-side. `listBlueprints` surfaces both
    // with their respective provenance so the admin/cache/list surface
    // can distinguish them.
    const deps = makeDeps();
    const otherContract: DataContract = {
      contextSpec: { greeting: { schema: { type: 'string' }, default: 'hi' } },
    };
    await installToCache(deps, SCOPE, {
      contract: COUNTER_CONTRACT,
      componentCode: 'installed-code',
      intent: 'installed counter',
    });
    // Direct registerBlueprint with an llm-arm source to simulate the
    // render-side cold-gen path.
    const { registerBlueprint } = await import('./blueprint-registry.js');
    await registerBlueprint(deps, SCOPE, {
      kind: 'template',
      contract: otherContract,
      intent: 'cold-gen greeter',
      componentCode: 'synth-code',
      source: { kind: 'llm', generator: 'ui-gen-default-haiku-4-5', model: 'claude-haiku-4-5' },
    });
    const all = await listBlueprints(deps, SCOPE);
    expect(all).toHaveLength(2);
    const byKind = new Map(all.map((bp) => [bp.source.kind, bp]));
    expect(byKind.get('user')?.componentCode).toBe('installed-code');
    expect(byKind.get('user')?.installed).toBe(true);
    expect(byKind.get('llm')?.componentCode).toBe('synth-code');
  });
});
