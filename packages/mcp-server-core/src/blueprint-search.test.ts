/**
 * Unit tests for `BlueprintSearch` scoring helpers + the in-memory
 * impl's special cases (MVB-2.5, 2026-05-12). Conformance behavior
 * lives in `./contract-tests/blueprint-search.conformance.ts`.
 */
import type { Blueprint, DataContract } from '@ggui-ai/protocol';
import { describe, expect, it } from 'vitest';
import {
  cosineSimilarity,
  DEFAULT_BLUEPRINT_SEARCH_THRESHOLD,
  DEFAULT_BLUEPRINT_SEARCH_TOP_K,
  DEFAULT_BLUEPRINT_SEARCH_WEIGHTS,
  jaccardSimilarity,
  structuralFingerprint,
  structuralSimilarity,
  tokenizeForIntent,
  varianceOverlap,
} from './blueprint-search.js';
import { MockEmbeddingProvider } from './in-memory/embedding-provider.js';
import {
  createInMemoryBlueprintSearch,
  scoreBlueprint,
  stringifyContractForEmbedding,
} from './in-memory/blueprint-search.js';
import { InMemoryBlueprintStore } from './in-memory/blueprint-store.js';

function makeBlueprint(
  overrides: Partial<Blueprint> & { blueprintId: string },
): Blueprint {
  return {
    blueprintId: overrides.blueprintId,
    contractHash: overrides.contractHash ?? 'hash-1',
    appId: overrides.appId ?? 'app-1',
    codeS3Url: overrides.codeS3Url,
    codeHash: overrides.codeHash,
    generator: overrides.generator ?? 'ui-gen-default-haiku-4-5',
    validatorScore: overrides.validatorScore,
    variance: overrides.variance ?? {},
    isOperatorDefault: overrides.isOperatorDefault,
    createdAt: overrides.createdAt ?? '2026-05-12T00:00:00.000Z',
    createdBy: overrides.createdBy ?? 'agent',
    contract: overrides.contract ?? { propsSpec: { properties: {} } },
    contractEmbedding: overrides.contractEmbedding,
  };
}

describe('default constants', () => {
  it('weights sum to a positive number', () => {
    const w = DEFAULT_BLUEPRINT_SEARCH_WEIGHTS;
    expect(w.hash + w.embed + w.struct + w.variance + w.intent).toBeGreaterThan(0);
  });

  it('threshold is in (0, 1]', () => {
    expect(DEFAULT_BLUEPRINT_SEARCH_THRESHOLD).toBeGreaterThan(0);
    expect(DEFAULT_BLUEPRINT_SEARCH_THRESHOLD).toBeLessThanOrEqual(1);
  });

  it('topK default is positive integer', () => {
    expect(DEFAULT_BLUEPRINT_SEARCH_TOP_K).toBeGreaterThan(0);
    expect(Number.isInteger(DEFAULT_BLUEPRINT_SEARCH_TOP_K)).toBe(true);
  });
});

describe('cosineSimilarity', () => {
  it('returns 0 when either vector is undefined', () => {
    expect(cosineSimilarity(undefined, [1, 0])).toBe(0);
    expect(cosineSimilarity([1, 0], undefined)).toBe(0);
  });

  it('returns 0 on dimension mismatch', () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });

  it('returns 1 for identical normalized vectors', () => {
    const v = [0.6, 0.8];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it('clamps negative cosine to 0', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBe(0);
  });

  it('returns 0 on zero magnitude', () => {
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
  });
});

describe('jaccardSimilarity', () => {
  it('returns 0 when both arrays empty', () => {
    expect(jaccardSimilarity([], [])).toBe(0);
  });

  it('returns 1 when arrays identical', () => {
    expect(jaccardSimilarity(['a', 'b'], ['b', 'a'])).toBe(1);
  });

  it('computes correct intersection over union', () => {
    expect(jaccardSimilarity(['a', 'b'], ['a', 'c'])).toBeCloseTo(1 / 3, 5);
  });
});

describe('structuralFingerprint', () => {
  it('returns empty fingerprint for undefined contract', () => {
    const fp = structuralFingerprint(undefined);
    expect(fp.actionNames).toEqual([]);
    expect(fp.streamChannels).toEqual([]);
    expect(fp.propsKeys).toEqual([]);
    expect(fp.contextKeys).toEqual([]);
    expect(fp.hasAgentCapabilities).toBe(false);
    expect(fp.hasClientCapabilities).toBe(false);
  });

  it('sorts keys alphabetically', () => {
    const contract: DataContract = {
      actionSpec: {
        zebra: { label: 'go', schema: { type: 'object' } },
        alpha: { label: 'go', schema: { type: 'object' } },
      },
    };
    const fp = structuralFingerprint(contract);
    expect(fp.actionNames).toEqual(['alpha', 'zebra']);
  });

  it('detects agent capabilities', () => {
    const contract: DataContract = {
      agentCapabilities: {
        tools: {
          fetch_quote: {
            inputSchema: { type: 'object' },
            outputSchema: { type: 'object' },
          },
        },
      },
    };
    expect(structuralFingerprint(contract).hasAgentCapabilities).toBe(true);
  });

  it('treats field-order differences as identical fingerprint', () => {
    const a: DataContract = {
      actionSpec: {
        submit: { label: 'go', schema: { type: 'object' } },
        cancel: { label: 'go', schema: { type: 'object' } },
      },
    };
    const b: DataContract = {
      // Same keys, different declaration order.
      actionSpec: {
        cancel: { label: 'go', schema: { type: 'object' } },
        submit: { label: 'go', schema: { type: 'object' } },
      },
    };
    expect(structuralFingerprint(a)).toEqual(structuralFingerprint(b));
  });
});

describe('structuralSimilarity', () => {
  it('returns 1 for identical fingerprints', () => {
    const c: DataContract = {
      actionSpec: { submit: { label: 'go', schema: { type: 'object' } } },
      propsSpec: { properties: { name: { schema: { type: 'string' } } } },
    };
    const a = structuralFingerprint(c);
    const b = structuralFingerprint(c);
    expect(structuralSimilarity(a, b)).toBe(1);
  });

  it('returns 1 for two empty fingerprints (agreement on absence)', () => {
    // structuralSimilarity treats empty-vs-empty as "agreement on
    // shape" — both contracts are identical (no actions, no streams,
    // no props, no context, no capabilities), so they score 1.
    // Distinct from `jaccardSimilarity` which reads empty-empty as
    // "no signal" / 0 — see file-level note on `keySetSimilarity`.
    const fp = structuralFingerprint(undefined);
    expect(structuralSimilarity(fp, fp)).toBe(1);
  });
});

describe('varianceOverlap', () => {
  it('returns 0 when query variance is undefined', () => {
    expect(varianceOverlap(undefined, { persona: 'minimalist' })).toBe(0);
  });

  it('fires on persona equality', () => {
    expect(
      varianceOverlap(
        { persona: 'minimalist' },
        { persona: 'minimalist' },
      ),
    ).toBeGreaterThan(0);
  });

  it('does not fire on persona mismatch', () => {
    expect(
      varianceOverlap(
        { persona: 'minimalist' },
        { persona: 'data-dense' },
      ),
    ).toBe(0);
  });
});

describe('tokenizeForIntent', () => {
  it('returns empty array for undefined', () => {
    expect(tokenizeForIntent(undefined)).toEqual([]);
  });

  it('lowercases + splits on non-alphanumeric', () => {
    expect(tokenizeForIntent('Make a Sparse Weather-Card')).toEqual([
      'make',
      'a',
      'sparse',
      'weather',
      'card',
    ]);
  });

  it('deduplicates', () => {
    const out = tokenizeForIntent('weather weather card');
    expect(out.filter((t) => t === 'weather')).toHaveLength(1);
  });
});

describe('scoreBlueprint', () => {
  it('returns score 0 when sumWeights is zero', () => {
    const out = scoreBlueprint({
      candidate: makeBlueprint({ blueprintId: 'bp-1' }),
      criteria: { appId: 'app-1', variance: { persona: 'x' } },
      queryEmbedding: undefined,
      weights: { hash: 0, embed: 0, struct: 0, variance: 0, intent: 0 },
    });
    expect(out.score).toBe(0);
    expect(out.matchedOn).toEqual([]);
  });

  it('normalizes by sumWeights', () => {
    // With only the hash axis weighted, an exact hash match scores 1.0.
    const out = scoreBlueprint({
      candidate: makeBlueprint({
        blueprintId: 'bp-1',
        contractHash: 'hash-a',
      }),
      criteria: { appId: 'app-1', contractHash: 'hash-a' },
      queryEmbedding: undefined,
      weights: { hash: 1, embed: 0, struct: 0, variance: 0, intent: 0 },
    });
    expect(out.score).toBe(1.0);
  });

  it('aggregates multiple axes', () => {
    const out = scoreBlueprint({
      candidate: makeBlueprint({
        blueprintId: 'bp-1',
        contractHash: 'hash-a',
        variance: { persona: 'minimalist' },
      }),
      criteria: {
        appId: 'app-1',
        contractHash: 'hash-a',
        variance: { persona: 'minimalist' },
      },
      queryEmbedding: undefined,
      weights: DEFAULT_BLUEPRINT_SEARCH_WEIGHTS,
    });
    expect(out.score).toBeGreaterThan(0);
    expect(out.matchedOn).toContain('contract-hash');
    expect(out.matchedOn).toContain('persona');
  });
});

describe('createInMemoryBlueprintSearch with EmbeddingProvider', () => {
  it('embeds the query contract and scores the embed axis', async () => {
    const provider = new MockEmbeddingProvider({ dimensions: 16 });
    const store = new InMemoryBlueprintStore({ embeddingProvider: provider });
    const search = createInMemoryBlueprintSearch({
      blueprintStore: store,
      embeddingProvider: provider,
    });
    const contract: DataContract = {
      actionSpec: { submit: { label: 'go', schema: { type: 'object' } } },
    };
    await store.put(
      makeBlueprint({
        blueprintId: 'bp-1',
        contract,
        // The store auto-embeds on put — no need to pre-compute here.
      }),
    );
    const result = await search.search({
      appId: 'app-1',
      contract,
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.matchedOn).toContain('contract-embed');
  });

  it('survives EmbeddingProvider failures gracefully (embed axis = 0)', async () => {
    const flakyProvider = {
      id: 'flaky',
      dimensions: 16,
      embed: async () => {
        throw new Error('upstream embed failed');
      },
    };
    const store = new InMemoryBlueprintStore();
    const search = createInMemoryBlueprintSearch({
      blueprintStore: store,
      embeddingProvider: flakyProvider,
    });
    await store.put(
      makeBlueprint({
        blueprintId: 'bp-1',
        variance: { persona: 'minimalist' },
        // No contractEmbedding cached — and the query-time embed
        // will throw — so the embed axis contributes 0.
      }),
    );
    const result = await search.search({
      appId: 'app-1',
      variance: { persona: 'minimalist' },
      contract: { propsSpec: { properties: {} } },
    });
    // Other axes (variance) still score; result is non-empty.
    expect(result).toHaveLength(1);
    expect(result[0]!.matchedOn).toContain('persona');
    expect(result[0]!.matchedOn).not.toContain('contract-embed');
  });
});

describe('InMemoryBlueprintStore auto-embed on put', () => {
  it('attaches contractEmbedding when provider wired + caller omitted', async () => {
    const provider = new MockEmbeddingProvider({ dimensions: 8 });
    const store = new InMemoryBlueprintStore({ embeddingProvider: provider });
    await store.put(
      makeBlueprint({
        blueprintId: 'bp-1',
        contract: { actionSpec: { go: { label: 'go', schema: { type: 'object' } } } },
      }),
    );
    const got = await store.get('bp-1');
    expect(got).not.toBeNull();
    expect(got!.contractEmbedding).toBeDefined();
    expect(got!.contractEmbedding!.length).toBe(8);
  });

  it('respects caller-supplied contractEmbedding (does not overwrite)', async () => {
    const provider = new MockEmbeddingProvider({ dimensions: 8 });
    const store = new InMemoryBlueprintStore({ embeddingProvider: provider });
    const preComputed = [0.5, 0.5, 0, 0, 0, 0, 0, 0];
    await store.put(
      makeBlueprint({
        blueprintId: 'bp-1',
        contract: { actionSpec: { go: { label: 'go', schema: { type: 'object' } } } },
        contractEmbedding: preComputed,
      }),
    );
    const got = await store.get('bp-1');
    expect(got!.contractEmbedding).toEqual(preComputed);
  });

  it('persists row without embedding when provider not wired', async () => {
    const store = new InMemoryBlueprintStore();
    await store.put(
      makeBlueprint({
        blueprintId: 'bp-1',
        contract: { actionSpec: { go: { label: 'go', schema: { type: 'object' } } } },
      }),
    );
    const got = await store.get('bp-1');
    expect(got!.contractEmbedding).toBeUndefined();
  });
});

describe('stringifyContractForEmbedding', () => {
  it('returns a string', () => {
    const out = stringifyContractForEmbedding({
      actionSpec: { go: { label: 'go', schema: { type: 'object' } } },
    });
    expect(typeof out).toBe('string');
    expect(out).toContain('go');
  });
});

describe('per-app config resolver', () => {
  it('layers per-app config over global default', async () => {
    const store = new InMemoryBlueprintStore();
    const search = createInMemoryBlueprintSearch({
      blueprintStore: store,
      defaultConfig: { topK: 100 },
      resolveAppConfig: async (appId) =>
        appId === 'app-strict' ? { topK: 1 } : undefined,
    });
    for (let i = 0; i < 5; i++) {
      await store.put(
        makeBlueprint({
          blueprintId: `bp-strict-${i}`,
          appId: 'app-strict',
          variance: { persona: 'minimalist' },
        }),
      );
      await store.put(
        makeBlueprint({
          blueprintId: `bp-loose-${i}`,
          appId: 'app-loose',
          variance: { persona: 'minimalist' },
        }),
      );
    }
    const strictResult = await search.search({
      appId: 'app-strict',
      variance: { persona: 'minimalist' },
    });
    const looseResult = await search.search({
      appId: 'app-loose',
      variance: { persona: 'minimalist' },
    });
    expect(strictResult).toHaveLength(1); // per-app topK: 1
    expect(looseResult).toHaveLength(5); // global topK: 100
  });
});
