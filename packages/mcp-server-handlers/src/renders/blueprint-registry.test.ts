import { describe, it, expect, vi } from 'vitest';
import {
  InMemoryBlueprintIndex,
  InMemoryVectorStore,
  MockEmbeddingProvider,
} from '@ggui-ai/mcp-server-core/in-memory';
import type { BlueprintStore } from '@ggui-ai/mcp-server-core';
import type {
  Blueprint as DurableBlueprint,
  BlueprintSource,
  DataContract,
} from '@ggui-ai/protocol';
import { blueprintKey, variantKey } from '@ggui-ai/protocol/blueprint-key';
import type { ContractValidationResult } from '@ggui-ai/negotiator';
import {
  registerBlueprint,
  findBlueprintExact,
  findBlueprintsByEmbedding,
  listBlueprints,
  recordBlueprintHit,
  deleteBlueprint,
  composeExactKey,
  composeEmbeddingInput,
  BlueprintRejectedError,
  type ContractValidator,
} from './blueprint-registry.js';

const SCOPE = 'app-test';

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

const NOTEPAD_CONTRACT: DataContract = {
  contextSpec: {
    noteText: { schema: { type: 'string' }, default: '' },
    topic: {
      schema: { type: 'string', enum: ['Bug', 'Feature', 'Question'] },
      default: 'Bug',
    },
  },
};

const FEEDBACK_CONTRACT: DataContract = {
  actionSpec: { submit: { label: 'Submit' } },
  propsSpec: {
    properties: {
      rating: { schema: { type: 'number' }, required: true },
      comment: { schema: { type: 'string' } },
    },
  },
};

describe('composeExactKey', () => {
  it('joins kind, contractKey, and variantKey with colons', () => {
    expect(composeExactKey('template', 'abc123', 'v0')).toBe(
      'template:abc123:v0',
    );
    expect(composeExactKey('atom', 'xyz', 'default')).toBe('atom:xyz:default');
  });

  it('distinct variantKeys produce distinct exact keys', () => {
    const a = composeExactKey('template', 'abc123', 'variant-a');
    const b = composeExactKey('template', 'abc123', 'variant-b');
    expect(a).not.toBe(b);
  });
});

describe('composeEmbeddingInput', () => {
  it('combines summary + intent on separate lines', () => {
    const input = composeEmbeddingInput(NOTEPAD_CONTRACT, 'Build a notepad');
    // Slots format includes type after the rerank-fingerprint upgrade
    // (`summarizeContract` now emits `name:type` for slots so payload-
    // bearing schema differences are visible to the rerank judge).
    expect(input).toContain('slots=noteText:string,topic:string');
    expect(input).toContain('INTENT: Build a notepad');
  });

  it('handles undefined contract', () => {
    const input = composeEmbeddingInput(undefined, 'something');
    expect(input).toContain('slots=∅');
    expect(input).toContain('INTENT: something');
  });
});

describe('registerBlueprint', () => {
  it('mints an opaque bp_<uuid> id keyed off the contract', async () => {
    const deps = makeDeps();
    const bp = await registerBlueprint(deps, SCOPE, {
      kind: 'template',
      contract: NOTEPAD_CONTRACT,
      intent: 'Build a notepad',
      componentCode: 'export default () => null;',
      source: { kind: 'user' },
    });
    // Identity is opaque — no longer derived from (kind, contractKey).
    expect(bp.id).toMatch(/^bp_[0-9a-f-]{36}$/);
    expect(bp.contractKey).toBe(blueprintKey(NOTEPAD_CONTRACT));
    expect(bp.kind).toBe('template');
    expect(bp.intent).toBe('Build a notepad');
    expect(bp.hitCount).toBe(0);
    expect(bp.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('dedups: same (contract, variance) twice returns the same uuid, first write wins', async () => {
    const deps = makeDeps();
    const a = await registerBlueprint(deps, SCOPE, {
      kind: 'template',
      contract: NOTEPAD_CONTRACT,
      intent: 'Build a notepad',
      componentCode: 'export default () => "first";',
      source: { kind: 'user' },
    });
    const b = await registerBlueprint(deps, SCOPE, {
      kind: 'template',
      contract: NOTEPAD_CONTRACT, // same canonical shape, same (default) variance
      intent: 'A live notepad panel — different prose',
      componentCode: 'export default () => "newer";',
      source: { kind: 'user' },
    });
    // Same UUID — the second registration is a dedup hit, not a new row.
    expect(b.id).toBe(a.id);
    const all = await listBlueprints(deps, SCOPE);
    expect(all).toHaveLength(1);
    // First write wins — no overwrite, no re-mint, no metadata churn.
    expect(b.intent).toBe('Build a notepad');
    expect(b.componentCode).toBe('export default () => "first";');
    expect(all[0]?.intent).toBe('Build a notepad');
    expect(all[0]?.componentCode).toBe('export default () => "first";');
  });

  it('same contract + different variance mints distinct sibling uuids', async () => {
    const deps = makeDeps();
    const a = await registerBlueprint(deps, SCOPE, {
      kind: 'template',
      contract: NOTEPAD_CONTRACT,
      intent: 'notepad — minimalist',
      componentCode: 'a',
      source: { kind: 'user' },
      variance: { persona: 'minimalist' },
    });
    const b = await registerBlueprint(deps, SCOPE, {
      kind: 'template',
      contract: NOTEPAD_CONTRACT, // same contract shape
      intent: 'notepad — data-dense',
      componentCode: 'b',
      source: { kind: 'user' },
      variance: { persona: 'data-dense' },
    });
    // Distinct variance → distinct exact keys → distinct sibling rows.
    expect(a.id).not.toBe(b.id);
    expect(a.contractKey).toBe(b.contractKey);
    expect(a.variantKey).not.toBe(b.variantKey);
    const all = await listBlueprints(deps, SCOPE);
    expect(all).toHaveLength(2);
  });

  it('different contract produce different ids', async () => {
    const deps = makeDeps();
    const a = await registerBlueprint(deps, SCOPE, {
      kind: 'template',
      contract: NOTEPAD_CONTRACT,
      intent: 'notepad',
      componentCode: 'a',
      source: { kind: 'user' },
    });
    const b = await registerBlueprint(deps, SCOPE, {
      kind: 'template',
      contract: FEEDBACK_CONTRACT,
      intent: 'feedback',
      componentCode: 'b',
      source: { kind: 'user' },
    });
    expect(a.id).not.toBe(b.id);
    const all = await listBlueprints(deps, SCOPE);
    expect(all).toHaveLength(2);
  });

  it('uses an injected mintId for the registry id', async () => {
    const deps = makeDeps();
    const bp = await registerBlueprint(
      deps,
      SCOPE,
      {
        kind: 'template',
        contract: NOTEPAD_CONTRACT,
        intent: 'notepad',
        componentCode: 'a',
        source: { kind: 'user' },
      },
      { mintId: () => 'bp_injected-fixed-id' },
    );
    expect(bp.id).toBe('bp_injected-fixed-id');
  });

  it('rejects an empty intent', async () => {
    const deps = makeDeps();
    await expect(
      registerBlueprint(deps, SCOPE, {
        kind: 'template',
        contract: NOTEPAD_CONTRACT,
        intent: '   ',
        componentCode: 'a',
        source: { kind: 'user' },
      }),
    ).rejects.toThrow(/intent cannot be empty/);
  });

  // Provenance (BlueprintSource union) round-trips through the flat
  // vector-store metadata encoding (sourceKind / sourceGenerator /
  // sourceModel). No default exists — every mint site stamps the
  // union explicitly.
  it('round-trips each BlueprintSource arm through metadata', async () => {
    const sources: readonly BlueprintSource[] = [
      { kind: 'llm', generator: 'ui-gen-default-haiku-4-5', model: 'claude-haiku-4-5' },
      { kind: 'user' },
      { kind: 'curated' },
    ];
    for (const source of sources) {
      const deps = makeDeps();
      const bp = await registerBlueprint(deps, SCOPE, {
        kind: 'template',
        contract: NOTEPAD_CONTRACT,
        intent: `Build a notepad (${source.kind})`,
        componentCode: 'export default () => null;',
        source,
      });
      expect(bp.source).toEqual(source);
      const fetched = await findBlueprintExact(
        { vectorStore: deps.vectorStore, index: deps.index },
        SCOPE,
        'template',
        bp.contractKey,
      );
      expect(fetched?.source).toEqual(source);
      // List-side readback through the metadata layer must also
      // surface the union — guards against rowToBlueprint losing it.
      const all = await listBlueprints(deps, SCOPE);
      expect(all[0]?.source).toEqual(source);
    }
  });

  it('drops rows written under the retired flat provenance vocabulary (rebuild posture, no coercion)', async () => {
    const deps = makeDeps();
    // Simulate a pre-union row: blueprint-shaped metadata carrying the
    // retired `provenance` scalar instead of sourceKind/…
    await deps.vectorStore.putVector(SCOPE, {
      key: 'bp_legacy',
      vector: [0],
      metadata: {
        intent: 'legacy row',
        componentCode: 'export default () => null;',
        contract: JSON.stringify(NOTEPAD_CONTRACT),
        contractKey: blueprintKey(NOTEPAD_CONTRACT),
        variantKey: variantKey(undefined),
        variance: JSON.stringify({}),
        kind: 'template',
        createdAt: '2026-01-01T00:00:00.000Z',
        hitCount: 3,
        provenance: 'synth',
      },
    });
    const all = await listBlueprints(deps, SCOPE);
    expect(all).toHaveLength(0);
  });

  it('drops an llm-kinded row missing its engine provenance scalars', async () => {
    const deps = makeDeps();
    // sourceKind says llm but the generator/model scalars are absent —
    // not a real state; the validating narrower must drop, not coerce.
    await deps.vectorStore.putVector(SCOPE, {
      key: 'bp_hollow_llm',
      vector: [0],
      metadata: {
        intent: 'hollow llm row',
        componentCode: 'export default () => null;',
        contract: JSON.stringify(NOTEPAD_CONTRACT),
        contractKey: blueprintKey(NOTEPAD_CONTRACT),
        variantKey: variantKey(undefined),
        variance: JSON.stringify({}),
        kind: 'template',
        createdAt: '2026-01-01T00:00:00.000Z',
        hitCount: 0,
        sourceKind: 'llm',
      },
    });
    const all = await listBlueprints(deps, SCOPE);
    expect(all).toHaveLength(0);
  });
});

describe('findBlueprintExact', () => {
  it('returns null on empty scope', async () => {
    const deps = makeDeps();
    const bp = await findBlueprintExact(
      deps,
      SCOPE,
      'template',
      blueprintKey(NOTEPAD_CONTRACT),
    );
    expect(bp).toBeNull();
  });

  it('hits the registered blueprint by exact contractKey', async () => {
    const deps = makeDeps();
    await registerBlueprint(deps, SCOPE, {
      kind: 'template',
      contract: NOTEPAD_CONTRACT,
      intent: 'notepad',
      componentCode: 'code-1',
      source: { kind: 'user' },
    });
    const bp = await findBlueprintExact(
      deps,
      SCOPE,
      'template',
      blueprintKey(NOTEPAD_CONTRACT),
    );
    expect(bp).not.toBeNull();
    expect(bp?.componentCode).toBe('code-1');
    expect(bp?.contract.contextSpec).toBeDefined();
  });

  it('returns null when contractKey matches but kind differs', async () => {
    const deps = makeDeps();
    await registerBlueprint(deps, SCOPE, {
      kind: 'template',
      contract: NOTEPAD_CONTRACT,
      intent: 'notepad',
      componentCode: 'code',
      source: { kind: 'user' },
    });
    // Looking up under kind='atom' should miss even with the same hash.
    const bp = await findBlueprintExact(
      deps,
      SCOPE,
      'atom',
      blueprintKey(NOTEPAD_CONTRACT),
    );
    expect(bp).toBeNull();
  });

  it('isolates scopes (cross-tenant cannot leak)', async () => {
    const deps = makeDeps();
    await registerBlueprint(deps, 'scope-A', {
      kind: 'template',
      contract: NOTEPAD_CONTRACT,
      intent: 'notepad',
      componentCode: 'A',
      source: { kind: 'user' },
    });
    const bp = await findBlueprintExact(
      deps,
      'scope-B',
      'template',
      blueprintKey(NOTEPAD_CONTRACT),
    );
    expect(bp).toBeNull();
  });

  it('distinguishes two variants of the same contract by variantKey', async () => {
    const deps = makeDeps();
    const minimalist = await registerBlueprint(deps, SCOPE, {
      kind: 'template',
      contract: NOTEPAD_CONTRACT,
      intent: 'notepad — minimalist',
      componentCode: 'minimalist',
      source: { kind: 'user' },
      variance: { persona: 'minimalist' },
    });
    const dense = await registerBlueprint(deps, SCOPE, {
      kind: 'template',
      contract: NOTEPAD_CONTRACT,
      intent: 'notepad — data-dense',
      componentCode: 'dense',
      source: { kind: 'user' },
      variance: { persona: 'data-dense' },
    });
    const contractKey = blueprintKey(NOTEPAD_CONTRACT);
    const hitMinimalist = await findBlueprintExact(
      deps,
      SCOPE,
      'template',
      contractKey,
      variantKey({ persona: 'minimalist' }),
    );
    const hitDense = await findBlueprintExact(
      deps,
      SCOPE,
      'template',
      contractKey,
      variantKey({ persona: 'data-dense' }),
    );
    expect(hitMinimalist?.id).toBe(minimalist.id);
    expect(hitMinimalist?.componentCode).toBe('minimalist');
    expect(hitDense?.id).toBe(dense.id);
    expect(hitDense?.componentCode).toBe('dense');
    // Omitting variantKey resolves the default variant — neither of
    // these non-default siblings — so it misses.
    const hitDefault = await findBlueprintExact(
      deps,
      SCOPE,
      'template',
      contractKey,
    );
    expect(hitDefault).toBeNull();
  });

  it('self-heals an index hit that points at a missing row (returns null)', async () => {
    const deps = makeDeps();
    const contractKey = blueprintKey(NOTEPAD_CONTRACT);
    // Manually bind a dangling exact key → no vector row exists for it.
    const exactKey = composeExactKey(
      'template',
      contractKey,
      variantKey(undefined),
    );
    await deps.index.putId(SCOPE, exactKey, 'bp_dangling-no-row');
    const bp = await findBlueprintExact(
      deps,
      SCOPE,
      'template',
      contractKey,
    );
    // Index hit, UUID miss → null, never a throw.
    expect(bp).toBeNull();
  });
});

describe('findBlueprintsByEmbedding', () => {
  it('returns empty array on empty scope', async () => {
    const deps = makeDeps();
    const candidates = await findBlueprintsByEmbedding(deps, SCOPE, {
      intent: 'anything',
      contract: NOTEPAD_CONTRACT,
    });
    expect(candidates).toEqual([]);
  });

  it('returns blueprints with cosine ≥ 0 (mock embedder is deterministic)', async () => {
    const deps = makeDeps();
    await registerBlueprint(deps, SCOPE, {
      kind: 'template',
      contract: NOTEPAD_CONTRACT,
      intent: 'notepad',
      componentCode: 'a',
      source: { kind: 'user' },
    });
    await registerBlueprint(deps, SCOPE, {
      kind: 'template',
      contract: FEEDBACK_CONTRACT,
      intent: 'feedback',
      componentCode: 'b',
      source: { kind: 'user' },
    });
    const candidates = await findBlueprintsByEmbedding(deps, SCOPE, {
      intent: 'notepad',
      contract: NOTEPAD_CONTRACT,
    });
    expect(candidates.length).toBeGreaterThan(0);
    // Each candidate carries cosine + blueprint
    for (const c of candidates) {
      expect(typeof c.cosine).toBe('number');
      expect(c.blueprint.id).toBeDefined();
    }
    // Top result should be the notepad (identical embedding input).
    expect(candidates[0]?.blueprint.contractKey).toBe(
      blueprintKey(NOTEPAD_CONTRACT),
    );
  });

  it('filters by kind when requested', async () => {
    const deps = makeDeps();
    await registerBlueprint(deps, SCOPE, {
      kind: 'template',
      contract: NOTEPAD_CONTRACT,
      intent: 'notepad',
      componentCode: 'a',
      source: { kind: 'user' },
    });
    const templateOnly = await findBlueprintsByEmbedding(
      deps,
      SCOPE,
      { intent: 'notepad', contract: NOTEPAD_CONTRACT },
      { kind: 'template' },
    );
    expect(templateOnly).toHaveLength(1);
    const atomOnly = await findBlueprintsByEmbedding(
      deps,
      SCOPE,
      { intent: 'notepad', contract: NOTEPAD_CONTRACT },
      { kind: 'atom' },
    );
    expect(atomOnly).toHaveLength(0);
  });

  it('respects topK when more entries exist', async () => {
    const deps = makeDeps();
    for (let i = 0; i < 5; i++) {
      await registerBlueprint(deps, SCOPE, {
        kind: 'template',
        contract: { actionSpec: { [`act${i}`]: { label: `A${i}` } } },
        intent: `intent ${i}`,
        componentCode: `code-${i}`,
        source: { kind: 'user' },
      });
    }
    const candidates = await findBlueprintsByEmbedding(
      deps,
      SCOPE,
      { intent: 'anything' },
      { topK: 2 },
    );
    expect(candidates.length).toBeLessThanOrEqual(2);
  });
});

describe('listBlueprints', () => {
  it('returns all template + non-template blueprints when no kind filter', async () => {
    const deps = makeDeps();
    await registerBlueprint(deps, SCOPE, {
      kind: 'template',
      contract: NOTEPAD_CONTRACT,
      intent: 'a',
      componentCode: 'a',
      source: { kind: 'user' },
    });
    await registerBlueprint(deps, SCOPE, {
      kind: 'atom',
      contract: FEEDBACK_CONTRACT,
      intent: 'b',
      componentCode: 'b',
      source: { kind: 'user' },
    });
    const all = await listBlueprints(deps, SCOPE);
    expect(all).toHaveLength(2);
  });

  it('filters by kind', async () => {
    const deps = makeDeps();
    await registerBlueprint(deps, SCOPE, {
      kind: 'template',
      contract: NOTEPAD_CONTRACT,
      intent: 'a',
      componentCode: 'a',
      source: { kind: 'user' },
    });
    await registerBlueprint(deps, SCOPE, {
      kind: 'atom',
      contract: FEEDBACK_CONTRACT,
      intent: 'b',
      componentCode: 'b',
      source: { kind: 'user' },
    });
    const templates = await listBlueprints(deps, SCOPE, 'template');
    expect(templates).toHaveLength(1);
    expect(templates[0]?.kind).toBe('template');
  });
});

describe('recordBlueprintHit', () => {
  it('bumps hitCount and stamps lastHitAt', async () => {
    const deps = makeDeps();
    const bp = await registerBlueprint(deps, SCOPE, {
      kind: 'template',
      contract: NOTEPAD_CONTRACT,
      intent: 'notepad',
      componentCode: 'a',
      source: { kind: 'user' },
    });
    await recordBlueprintHit(deps, SCOPE, bp.id);
    const after = await findBlueprintExact(
      deps,
      SCOPE,
      'template',
      blueprintKey(NOTEPAD_CONTRACT),
    );
    expect(after?.hitCount).toBe(1);
    expect(after?.lastHitAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('is idempotent on a missing id', async () => {
    const deps = makeDeps();
    await expect(
      recordBlueprintHit(deps, SCOPE, 'template:missing'),
    ).resolves.toBeUndefined();
  });
});

describe('deleteBlueprint', () => {
  it('removes the blueprint from listings', async () => {
    const deps = makeDeps();
    const bp = await registerBlueprint(deps, SCOPE, {
      kind: 'template',
      contract: NOTEPAD_CONTRACT,
      intent: 'notepad',
      componentCode: 'a',
      source: { kind: 'user' },
    });
    await deleteBlueprint(deps, SCOPE, bp.id);
    const all = await listBlueprints(deps, SCOPE);
    expect(all).toHaveLength(0);
  });

  it('idempotent on missing id', async () => {
    const deps = makeDeps();
    await expect(
      deleteBlueprint(deps, SCOPE, 'template:missing'),
    ).resolves.toBeUndefined();
  });
});

describe('registerBlueprint — bucket eviction (Slice 16h)', () => {
  // Build N templates with structurally distinct contracts so each
  // gets its own contractKey + bucket row. Each template has its own
  // single-property contextSpec slot keyed by a unique field name —
  // canonicalization preserves the slot key set, so deep-sort-then-
  // hash produces N distinct contractKeys.
  function uniqueContract(seed: number): DataContract {
    return {
      contextSpec: {
        [`field_${seed}`]: { schema: { type: 'string' }, default: '' },
      },
    };
  }

  it('evicts the lowest-hitCount entry when bucket is at capacity', async () => {
    const deps = makeDeps();
    // Cap = 3. Insert three blueprints, hit two of them so the third
    // has hitCount=0. The fourth registration must evict that third.
    const cap = 3;
    const a = await registerBlueprint(
      deps,
      SCOPE,
      {
        kind: 'template',
        contract: uniqueContract(1),
        intent: 'one',
        componentCode: 'a',
        source: { kind: 'user' },
      },
      { maxPerKind: cap },
    );
    const b = await registerBlueprint(
      deps,
      SCOPE,
      {
        kind: 'template',
        contract: uniqueContract(2),
        intent: 'two',
        componentCode: 'b',
        source: { kind: 'user' },
      },
      { maxPerKind: cap },
    );
    const c = await registerBlueprint(
      deps,
      SCOPE,
      {
        kind: 'template',
        contract: uniqueContract(3),
        intent: 'three',
        componentCode: 'c',
        source: { kind: 'user' },
      },
      { maxPerKind: cap },
    );

    // Bump A and B; C stays cold.
    await recordBlueprintHit(deps, SCOPE, a.id);
    await recordBlueprintHit(deps, SCOPE, b.id);

    // Fourth registration → C is evicted (hitCount=0; A/B have 1).
    const d = await registerBlueprint(
      deps,
      SCOPE,
      {
        kind: 'template',
        contract: uniqueContract(4),
        intent: 'four',
        componentCode: 'd',
        source: { kind: 'user' },
      },
      { maxPerKind: cap },
    );

    const all = await listBlueprints(deps, SCOPE);
    const ids = new Set(all.map((bp) => bp.id));
    expect(all).toHaveLength(cap);
    expect(ids.has(a.id)).toBe(true);
    expect(ids.has(b.id)).toBe(true);
    expect(ids.has(d.id)).toBe(true);
    expect(ids.has(c.id), 'cold C should have been evicted').toBe(false);
  });

  it('evicts the oldest entry when hitCounts tie', async () => {
    const deps = makeDeps();
    const cap = 2;
    const first = await registerBlueprint(
      deps,
      SCOPE,
      {
        kind: 'template',
        contract: uniqueContract(1),
        intent: 'first',
        componentCode: 'a',
        source: { kind: 'user' },
      },
      { maxPerKind: cap },
    );
    // Force a measurable createdAt gap by waiting a millisecond — the
    // tiebreak compares ISO strings which round to the millisecond.
    await new Promise((r) => setTimeout(r, 5));
    const second = await registerBlueprint(
      deps,
      SCOPE,
      {
        kind: 'template',
        contract: uniqueContract(2),
        intent: 'second',
        componentCode: 'b',
        source: { kind: 'user' },
      },
      { maxPerKind: cap },
    );

    // Both at hitCount=0; the older `first` must be evicted.
    const third = await registerBlueprint(
      deps,
      SCOPE,
      {
        kind: 'template',
        contract: uniqueContract(3),
        intent: 'third',
        componentCode: 'c',
        source: { kind: 'user' },
      },
      { maxPerKind: cap },
    );

    const all = await listBlueprints(deps, SCOPE);
    const ids = new Set(all.map((bp) => bp.id));
    expect(all).toHaveLength(cap);
    expect(ids.has(first.id), 'oldest tie-break victim').toBe(false);
    expect(ids.has(second.id)).toBe(true);
    expect(ids.has(third.id)).toBe(true);
  });

  it('does not evict on re-registration of an existing key (dedup, no growth)', async () => {
    const deps = makeDeps();
    const cap = 2;
    await registerBlueprint(
      deps,
      SCOPE,
      {
        kind: 'template',
        contract: uniqueContract(1),
        intent: 'one',
        componentCode: 'v1',
        source: { kind: 'user' },
      },
      { maxPerKind: cap },
    );
    await registerBlueprint(
      deps,
      SCOPE,
      {
        kind: 'template',
        contract: uniqueContract(2),
        intent: 'two',
        componentCode: 'v1',
        source: { kind: 'user' },
      },
      { maxPerKind: cap },
    );

    // Re-register first contract — same (contractKey, variantKey) is a
    // dedup hit (first write wins). The bucket does not grow, so the
    // second entry must NOT be evicted.
    await registerBlueprint(
      deps,
      SCOPE,
      {
        kind: 'template',
        contract: uniqueContract(1),
        intent: 'one revised',
        componentCode: 'v2',
        source: { kind: 'user' },
      },
      { maxPerKind: cap },
    );

    const all = await listBlueprints(deps, SCOPE);
    expect(all).toHaveLength(cap);
    // Dedup is first-write-wins — the re-registration returned the
    // original row verbatim, so the first write's code/intent survive.
    const first = all.find(
      (bp) => bp.contractKey === blueprintKey(uniqueContract(1)),
    );
    expect(first?.componentCode).toBe('v1');
    expect(first?.intent).toBe('one');
  });

  it('eviction drops the evicted exact key from the index — re-register mints a fresh uuid', async () => {
    const deps = makeDeps();
    const cap = 1;
    // Register one entry at cap=1.
    const first = await registerBlueprint(
      deps,
      SCOPE,
      {
        kind: 'template',
        contract: uniqueContract(1),
        intent: 'one',
        componentCode: 'a',
        source: { kind: 'user' },
      },
      { maxPerKind: cap },
    );
    const firstExactKey = composeExactKey(
      'template',
      blueprintKey(uniqueContract(1)),
      variantKey(undefined),
    );
    expect(await deps.index.getId(SCOPE, firstExactKey)).toBe(first.id);

    // A second distinct contract at cap+1 evicts `first` (cold, oldest).
    await registerBlueprint(
      deps,
      SCOPE,
      {
        kind: 'template',
        contract: uniqueContract(2),
        intent: 'two',
        componentCode: 'b',
        source: { kind: 'user' },
      },
      { maxPerKind: cap },
    );
    // The evicted entry's index binding is gone.
    expect(await deps.index.getId(SCOPE, firstExactKey)).toBeNull();

    // Re-registering the evicted contract mints a NEW uuid (no dedup
    // hit — the prior binding was dropped by eviction).
    const reborn = await registerBlueprint(
      deps,
      SCOPE,
      {
        kind: 'template',
        contract: uniqueContract(1),
        intent: 'one again',
        componentCode: 'a2',
        source: { kind: 'user' },
      },
      { maxPerKind: Number.POSITIVE_INFINITY },
    );
    expect(reborn.id).not.toBe(first.id);
    expect(reborn.id).toMatch(/^bp_[0-9a-f-]{36}$/);
    expect(await deps.index.getId(SCOPE, firstExactKey)).toBe(reborn.id);
  });

  it('does not evict cross-kind — atom and template buckets are independent', async () => {
    const deps = makeDeps();
    const cap = 2;
    const tmpl = await registerBlueprint(
      deps,
      SCOPE,
      {
        kind: 'template',
        contract: uniqueContract(1),
        intent: 'tmpl',
        componentCode: 't',
        source: { kind: 'user' },
      },
      { maxPerKind: cap },
    );
    // Two atoms — fills the atom bucket exactly at cap.
    await registerBlueprint(
      deps,
      SCOPE,
      {
        kind: 'atom',
        contract: uniqueContract(2),
        intent: 'atom 1',
        componentCode: 'a',
        source: { kind: 'user' },
      },
      { maxPerKind: cap },
    );
    await registerBlueprint(
      deps,
      SCOPE,
      {
        kind: 'atom',
        contract: uniqueContract(3),
        intent: 'atom 2',
        componentCode: 'a',
        source: { kind: 'user' },
      },
      { maxPerKind: cap },
    );

    // Adding a third atom evicts an atom — but template stays.
    await registerBlueprint(
      deps,
      SCOPE,
      {
        kind: 'atom',
        contract: uniqueContract(4),
        intent: 'atom 3',
        componentCode: 'a',
        source: { kind: 'user' },
      },
      { maxPerKind: cap },
    );

    const all = await listBlueprints(deps, SCOPE);
    const stillTmpl = all.find((bp) => bp.id === tmpl.id);
    expect(stillTmpl, 'template bucket must be unaffected').toBeDefined();
    const atoms = all.filter((bp) => bp.kind === 'atom');
    expect(atoms).toHaveLength(cap);
  });

  it('does not evict when maxPerKind is Infinity', async () => {
    const deps = makeDeps();
    for (let i = 0; i < 5; i += 1) {
      await registerBlueprint(
        deps,
        SCOPE,
        {
          kind: 'template',
          contract: uniqueContract(i),
          intent: `bp ${i}`,
          componentCode: 'x',
          source: { kind: 'user' },
        },
        { maxPerKind: Number.POSITIVE_INFINITY },
      );
    }
    const all = await listBlueprints(deps, SCOPE);
    expect(all).toHaveLength(5);
  });
});

describe('registerBlueprint — contract structural validation', () => {
  const COUNTER_OVER_SPECIFIED: DataContract = {
    contextSpec: {
      count: { schema: { type: 'number' }, default: 0 },
    },
    actionSpec: {
      // Empty-payload mutator masquerading as an action — the load-bearing
      // case the heuristic was built for. Default validator emits
      // severity:'warn' on this shape.
      increment: { label: 'Increment' },
    },
  };

  it('clean contract registers without warnings', async () => {
    const deps = makeDeps();
    const bp = await registerBlueprint(deps, SCOPE, {
      kind: 'template',
      contract: NOTEPAD_CONTRACT,
      intent: 'notepad',
      componentCode: 'export default () => null;',
      source: { kind: 'user' },
    });
    expect(bp.validationWarnings).toBeUndefined();
    expect(bp.contractKey).toBe(blueprintKey(NOTEPAD_CONTRACT));
  });

  it('over-specified counter contract registers with a warning surfaced', async () => {
    const deps = makeDeps();
    const bp = await registerBlueprint(deps, SCOPE, {
      kind: 'template',
      contract: COUNTER_OVER_SPECIFIED,
      intent: 'counter that increments on click',
      componentCode: 'export default () => null;',
      source: { kind: 'user' },
    });
    // Registration succeeds — heuristic is warn-only by default.
    const all = await listBlueprints(deps, SCOPE);
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe(bp.id);
    // Warnings surface on the return value so operators see the smell
    // without us widening the persisted vector-store schema.
    expect(bp.validationWarnings).toBeDefined();
    expect(bp.validationWarnings?.length).toBeGreaterThan(0);
    const finding = bp.validationWarnings?.[0];
    expect(finding?.severity).toBe('warn');
    expect(finding?.kind).toBe('redundant-action');
    expect(finding?.actionName).toBe('increment');
    expect(finding?.slotName).toBe('count');
  });

  it('refuses to register when validator emits severity:error', async () => {
    const deps = makeDeps();
    // Inject a validator that promotes findings to severity:'error'
    // — exercises the fail-closed branch which the current default
    // heuristic never trips, so we can prove the path lights up the
    // moment graduated findings ship.
    const failClosed: ContractValidator = (): ContractValidationResult => ({
      findings: [
        {
          kind: 'redundant-action',
          severity: 'error',
          actionName: 'increment',
          slotName: 'count',
          hint: 'redundant action that should be a slot setter',
        },
      ],
    });
    const before = await listBlueprints(deps, SCOPE);
    expect(before).toHaveLength(0);
    let caught: unknown;
    try {
      await registerBlueprint(
        deps,
        SCOPE,
        {
          kind: 'template',
          contract: COUNTER_OVER_SPECIFIED,
          intent: 'counter',
          componentCode: 'export default () => null;',
          source: { kind: 'user' },
        },
        { validator: failClosed },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BlueprintRejectedError);
    const rejected = caught as BlueprintRejectedError;
    expect(rejected.code).toBe('blueprint_rejected');
    expect(rejected.findings).toHaveLength(1);
    expect(rejected.findings[0]?.severity).toBe('error');
    // Bad contract MUST NOT enter the registry — that's the whole point.
    const after = await listBlueprints(deps, SCOPE);
    expect(after).toHaveLength(0);
  });

  it('honours a custom validator that returns no findings', async () => {
    const deps = makeDeps();
    const noop: ContractValidator = () => ({ findings: [] });
    const bp = await registerBlueprint(
      deps,
      SCOPE,
      {
        kind: 'template',
        contract: COUNTER_OVER_SPECIFIED,
        intent: 'counter',
        componentCode: 'export default () => null;',
        source: { kind: 'user' },
      },
      { validator: noop },
    );
    // No warnings surface when the validator stays silent — even on a
    // contract the default heuristic would flag.
    expect(bp.validationWarnings).toBeUndefined();
    const all = await listBlueprints(deps, SCOPE);
    expect(all).toHaveLength(1);
  });
});

/**
 * #430 slice 2 — the durable write-through fires from registration
 * itself, so the wiring is pinned where it actually runs rather than
 * only at the unit level in `blueprint-durability.test.ts`.
 */
describe('registerBlueprint — durable write-through', () => {
  function fakeDurableStore() {
    const rows: DurableBlueprint[] = [];
    const blueprintStore: BlueprintStore = {
      durability: 'ephemeral',
      put: async (bp) => {
        rows.push(bp);
      },
      list: async () => [],
      get: async () => null,
      setOperatorDefault: async () => {},
      delete: async () => {},
    };
    return { blueprintStore, rows };
  }

  const INPUT = {
    kind: 'template' as const,
    contract: NOTEPAD_CONTRACT,
    intent: 'a notepad',
    componentCode: 'export default () => null;',
    source: { kind: 'user' } as BlueprintSource,
  };

  it('persists a fresh mint with the registry-minted id and domain keys', async () => {
    const { blueprintStore, rows } = fakeDurableStore();
    const deps = { ...makeDeps(), durability: { blueprintStore } };

    const bp = await registerBlueprint(deps, SCOPE, INPUT);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.blueprintId).toBe(bp.id);
    expect(rows[0]!.appId).toBe(SCOPE);
    expect(rows[0]!.contractHash).toBe(blueprintKey(NOTEPAD_CONTRACT));
  });

  it('stamps createdBy agent by default and operator when asked', async () => {
    const first = fakeDurableStore();
    await registerBlueprint(
      { ...makeDeps(), durability: { blueprintStore: first.blueprintStore } },
      SCOPE,
      INPUT,
    );
    expect(first.rows[0]!.createdBy).toBe('agent');

    // The ops tools reach registerBlueprint through the SAME cache
    // bundle the render path uses, so without this the durable record
    // would claim the standard agent flow minted a permanently-retained
    // operator row.
    const second = fakeDurableStore();
    await registerBlueprint(
      { ...makeDeps(), durability: { blueprintStore: second.blueprintStore } },
      SCOPE,
      { ...INPUT, createdBy: 'operator' as const },
    );
    expect(second.rows[0]!.createdBy).toBe('operator');
  });

  it('does NOT re-persist on a dedup return', async () => {
    const { blueprintStore, rows } = fakeDurableStore();
    const deps = { ...makeDeps(), durability: { blueprintStore } };

    const first = await registerBlueprint(deps, SCOPE, INPUT);
    const second = await registerBlueprint(deps, SCOPE, INPUT);

    // Same row returned, and exactly one durable write — a second one
    // would hit the store's already-exists guard on every cache hit.
    expect(second.id).toBe(first.id);
    expect(rows).toHaveLength(1);
  });

  it('registers normally when no durable store is bound', async () => {
    const deps = makeDeps();
    const bp = await registerBlueprint(deps, SCOPE, INPUT);
    expect(bp.id).toMatch(/^bp_/);
    expect(await listBlueprints(deps, SCOPE)).toHaveLength(1);
  });

  it('still returns the blueprint when the durable store rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const blueprintStore: BlueprintStore = {
      durability: 'ephemeral',
      put: async () => {
        throw new Error('durable store down');
      },
      list: async () => [],
      get: async () => null,
      setOperatorDefault: async () => {},
      delete: async () => {},
    };
    const deps = { ...makeDeps(), durability: { blueprintStore } };

    const bp = await registerBlueprint(deps, SCOPE, INPUT);

    // Registration succeeded and the registry row is queryable — only
    // the future re-mint is degraded, and it said so by name.
    expect(bp.id).toMatch(/^bp_/);
    expect(await listBlueprints(deps, SCOPE)).toHaveLength(1);
    expect(JSON.parse(warn.mock.calls[0]?.[0] as string).msg).toBe(
      'blueprint_durable_write_failed',
    );
    warn.mockRestore();
  });
});

describe('registerBlueprint — authored source', () => {
  function fakeCodeStore() {
    const objects = new Map<string, string>();
    const store = {
      durability: 'ephemeral' as const,
      put: vi.fn(async (hash: string, code: string) => {
        objects.set(hash, code);
      }),
      get: async (hash: string) => objects.get(hash) ?? null,
      delete: async (hash: string) => {
        objects.delete(hash);
      },
      hashOf: (code: string) => `hash-of-${code.length}-${code.slice(0, 8)}`,
    };
    return { store, objects };
  }

  const SOURCE = 'export default function Notepad(props){return <div>{props.noteText}</div>;}';

  const INPUT = {
    kind: 'template' as const,
    contract: NOTEPAD_CONTRACT,
    intent: 'a notepad',
    componentCode: 'export default () => null;',
    source: { kind: 'user' } as BlueprintSource,
  };

  it('computes + persists sourceCodeHash and writes the body when sourceCode is distinct and a codeStore is bound', async () => {
    const { store: codeStore, objects } = fakeCodeStore();
    const blueprintStore: BlueprintStore = {
      durability: 'ephemeral',
      put: async () => {},
      list: async () => [],
      get: async () => null,
      setOperatorDefault: async () => {},
      delete: async () => {},
    };
    const deps = { ...makeDeps(), durability: { blueprintStore, codeStore } };

    const bp = await registerBlueprint(deps, SCOPE, {
      ...INPUT,
      sourceCode: SOURCE,
    });

    const expectedHash = codeStore.hashOf(SOURCE);
    expect(bp.sourceCodeHash).toBe(expectedHash);
    expect(objects.get(expectedHash)).toBe(SOURCE);

    // The hash also round-trips through the vector-store row itself —
    // not just the returned in-memory object.
    const fetched = await findBlueprintExact(deps, SCOPE, 'template', bp.contractKey);
    expect(fetched?.sourceCodeHash).toBe(expectedHash);
  });

  it('skips the hash and the body write when sourceCode is byte-identical to componentCode (fallback-collapse symmetry)', async () => {
    const { store: codeStore } = fakeCodeStore();
    const blueprintStore: BlueprintStore = {
      durability: 'ephemeral',
      put: async () => {},
      list: async () => [],
      get: async () => null,
      setOperatorDefault: async () => {},
      delete: async () => {},
    };
    const deps = { ...makeDeps(), durability: { blueprintStore, codeStore } };

    const bp = await registerBlueprint(deps, SCOPE, {
      ...INPUT,
      sourceCode: INPUT.componentCode, // byte-identical
    });

    expect(bp.sourceCodeHash).toBeUndefined();
    // Exactly ONE put() — the pre-existing componentCode body write
    // (unrelated to this feature, happens regardless). A second call
    // for the byte-identical "source" body would be pure waste, since
    // it's the exact same (hash, code) pair already written.
    expect(codeStore.put).toHaveBeenCalledTimes(1);
    expect(codeStore.put).toHaveBeenCalledWith(
      codeStore.hashOf(INPUT.componentCode),
      INPUT.componentCode,
    );
  });

  it('skips the hash entirely when no durability/codeStore is bound — honest absence, never a guess', async () => {
    const deps = makeDeps(); // no durability at all
    const bp = await registerBlueprint(deps, SCOPE, {
      ...INPUT,
      sourceCode: SOURCE,
    });
    expect(bp.sourceCodeHash).toBeUndefined();
  });

  it('skips the hash when durability is bound but codeStore is not', async () => {
    const blueprintStore: BlueprintStore = {
      durability: 'ephemeral',
      put: async () => {},
      list: async () => [],
      get: async () => null,
      setOperatorDefault: async () => {},
      delete: async () => {},
    };
    const deps = { ...makeDeps(), durability: { blueprintStore } }; // no codeStore
    const bp = await registerBlueprint(deps, SCOPE, {
      ...INPUT,
      sourceCode: SOURCE,
    });
    expect(bp.sourceCodeHash).toBeUndefined();
  });

  it('round-trips sourceCodeHash through findBlueprintExact and listBlueprints', async () => {
    const { store: codeStore } = fakeCodeStore();
    const blueprintStore: BlueprintStore = {
      durability: 'ephemeral',
      put: async () => {},
      list: async () => [],
      get: async () => null,
      setOperatorDefault: async () => {},
      delete: async () => {},
    };
    const deps = { ...makeDeps(), durability: { blueprintStore, codeStore } };

    const bp = await registerBlueprint(deps, SCOPE, {
      ...INPUT,
      sourceCode: SOURCE,
    });

    const all = await listBlueprints(deps, SCOPE);
    expect(all[0]?.sourceCodeHash).toBe(bp.sourceCodeHash);
  });

  it('tolerates a legacy row with no sourceCodeHash key at all — absence, never an error', async () => {
    const deps = makeDeps();
    // Simulate a pre-field row: blueprint-shaped metadata with no
    // sourceCodeHash key whatsoever (written before this field existed).
    await deps.vectorStore.putVector(SCOPE, {
      key: 'bp_legacy_no_source',
      vector: [0],
      metadata: {
        intent: 'legacy row',
        componentCode: 'export default () => null;',
        contract: JSON.stringify(NOTEPAD_CONTRACT),
        contractKey: blueprintKey(NOTEPAD_CONTRACT),
        variantKey: variantKey(undefined),
        variance: JSON.stringify({}),
        kind: 'template',
        createdAt: '2026-01-01T00:00:00.000Z',
        hitCount: 0,
        sourceKind: 'user',
      },
    });
    const all = await listBlueprints(deps, SCOPE);
    expect(all).toHaveLength(1);
    expect(all[0]?.sourceCodeHash).toBeUndefined();
  });
});
