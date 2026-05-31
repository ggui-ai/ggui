import { describe, it, expect } from 'vitest';
import {
  InMemoryBlueprintIndex,
  InMemoryVectorStore,
  MockEmbeddingProvider,
} from '@ggui-ai/mcp-server-core/in-memory';
import type { DataContract } from '@ggui-ai/protocol';
import { blueprintKey } from '@ggui-ai/protocol/blueprint-key';
import type { ContractValidationResult } from '@ggui-ai/negotiator';
import {
  registerBlueprint,
  findBlueprintExact,
  findBlueprintsByEmbedding,
  listBlueprints,
  recordBlueprintHit,
  deleteBlueprint,
  composeBlueprintId,
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

describe('composeBlueprintId', () => {
  it('joins kind and contractKey with a colon', () => {
    expect(composeBlueprintId('template', 'abc123')).toBe('template:abc123');
    expect(composeBlueprintId('atom', 'xyz')).toBe('atom:xyz');
  });
});

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
  it('writes a template entry with deterministic id', async () => {
    const deps = makeDeps();
    const bp = await registerBlueprint(deps, SCOPE, {
      kind: 'template',
      contract: NOTEPAD_CONTRACT,
      intent: 'Build a notepad',
      componentCode: 'export default () => null;',
    });
    expect(bp.id).toBe(`template:${blueprintKey(NOTEPAD_CONTRACT)}`);
    expect(bp.contractKey).toBe(blueprintKey(NOTEPAD_CONTRACT));
    expect(bp.kind).toBe('template');
    expect(bp.intent).toBe('Build a notepad');
    expect(bp.hitCount).toBe(0);
    expect(bp.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('two paraphrased registrations of the same contract overwrite the same id', async () => {
    const deps = makeDeps();
    const a = await registerBlueprint(deps, SCOPE, {
      kind: 'template',
      contract: NOTEPAD_CONTRACT,
      intent: 'Build a notepad',
      componentCode: 'export default () => null;',
    });
    const b = await registerBlueprint(deps, SCOPE, {
      kind: 'template',
      contract: NOTEPAD_CONTRACT, // same canonical shape
      intent: 'A live notepad panel — different prose',
      componentCode: 'export default () => "newer";',
    });
    expect(a.id).toBe(b.id);
    const all = await listBlueprints(deps, SCOPE);
    expect(all).toHaveLength(1);
    // Latest write wins.
    expect(all[0]?.intent).toBe('A live notepad panel — different prose');
    expect(all[0]?.componentCode).toBe('export default () => "newer";');
  });

  it('different contract produce different ids', async () => {
    const deps = makeDeps();
    const a = await registerBlueprint(deps, SCOPE, {
      kind: 'template',
      contract: NOTEPAD_CONTRACT,
      intent: 'notepad',
      componentCode: 'a',
    });
    const b = await registerBlueprint(deps, SCOPE, {
      kind: 'template',
      contract: FEEDBACK_CONTRACT,
      intent: 'feedback',
      componentCode: 'b',
    });
    expect(a.id).not.toBe(b.id);
    const all = await listBlueprints(deps, SCOPE);
    expect(all).toHaveLength(2);
  });

  it('rejects an empty intent', async () => {
    const deps = makeDeps();
    await expect(
      registerBlueprint(deps, SCOPE, {
        kind: 'template',
        contract: NOTEPAD_CONTRACT,
        intent: '   ',
        componentCode: 'a',
      }),
    ).rejects.toThrow(/intent cannot be empty/);
  });

  // Slice 5 (2026-05-18): provenance round-trips through vector-store
  // metadata. Default is 'synth' (the pre-Slice-5 cold-gen path was
  // the only writer; legacy rows are necessarily synth-origin).
  it('defaults provenance to "synth" when not supplied', async () => {
    const deps = makeDeps();
    const bp = await registerBlueprint(deps, SCOPE, {
      kind: 'template',
      contract: NOTEPAD_CONTRACT,
      intent: 'Build a notepad',
      componentCode: 'export default () => null;',
    });
    expect(bp.provenance).toBe('synth');
    // List-side readback through the metadata layer must also surface
    // 'synth' — guards against rowToBlueprint losing the field.
    const all = await listBlueprints(deps, SCOPE);
    expect(all[0]?.provenance).toBe('synth');
  });

  it('round-trips each provenance value through metadata', async () => {
    const provenances = ['synth', 'register', 'install'] as const;
    for (const provenance of provenances) {
      const deps = makeDeps();
      const bp = await registerBlueprint(deps, SCOPE, {
        kind: 'template',
        contract: NOTEPAD_CONTRACT,
        intent: `Build a notepad (${provenance})`,
        componentCode: 'export default () => null;',
        provenance,
      });
      expect(bp.provenance).toBe(provenance);
      const fetched = await findBlueprintExact(
        { vectorStore: deps.vectorStore },
        SCOPE,
        'template',
        bp.contractKey,
      );
      expect(fetched?.provenance).toBe(provenance);
    }
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
    });
    const bp = await findBlueprintExact(
      deps,
      'scope-B',
      'template',
      blueprintKey(NOTEPAD_CONTRACT),
    );
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
    });
    await registerBlueprint(deps, SCOPE, {
      kind: 'template',
      contract: FEEDBACK_CONTRACT,
      intent: 'feedback',
      componentCode: 'b',
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
    });
    await registerBlueprint(deps, SCOPE, {
      kind: 'atom',
      contract: FEEDBACK_CONTRACT,
      intent: 'b',
      componentCode: 'b',
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
    });
    await registerBlueprint(deps, SCOPE, {
      kind: 'atom',
      contract: FEEDBACK_CONTRACT,
      intent: 'b',
      componentCode: 'b',
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

  it('does not evict on re-registration of an existing key (overwrite, no growth)', async () => {
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
      },
      { maxPerKind: cap },
    );

    // Re-register first contract — same key, overwrite, must NOT
    // evict the second entry (bucket size unchanged).
    await registerBlueprint(
      deps,
      SCOPE,
      {
        kind: 'template',
        contract: uniqueContract(1),
        intent: 'one revised',
        componentCode: 'v2',
      },
      { maxPerKind: cap },
    );

    const all = await listBlueprints(deps, SCOPE);
    expect(all).toHaveLength(cap);
    // The re-registered first contract carries the new componentCode.
    const first = all.find(
      (bp) => bp.contractKey === blueprintKey(uniqueContract(1)),
    );
    expect(first?.componentCode).toBe('v2');
    expect(first?.intent).toBe('one revised');
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
