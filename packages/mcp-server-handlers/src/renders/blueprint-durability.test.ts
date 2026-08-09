/**
 * #430 slice 2 — durable blueprint write-through.
 *
 * Three things are pinned here. The EVENT NAMES as wire literals, because
 * an operator's alert filter matches the string and a rename that only
 * updates the const would silently stop matching. The PROJECTION between
 * the registry's `Blueprint` and the protocol's — two different shapes
 * sharing a name, where a field mix-up is invisible to the type checker
 * on the `contractKey` → `contractHash` hop, since both are `string`.
 * And the BEST-EFFORT contract: a failing store must not fail the write,
 * and must say so by name.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { BlueprintStore, CodeStore } from '@ggui-ai/mcp-server-core';
import { blueprintKey, variantKey } from '@ggui-ai/protocol/blueprint-key';
import type {
  Blueprint as DurableBlueprint,
  DataContract,
} from '@ggui-ai/protocol';
import type { Blueprint as RegistryBlueprint } from './blueprint-registry.js';
import {
  BLUEPRINT_DURABILITY_EVENTS,
  projectDurableBlueprint,
  writeBlueprintDurably,
} from './blueprint-durability.js';

const CONTRACT: DataContract = {
  propsSpec: { properties: { title: { schema: { type: 'string' } } } },
};

const CODE = 'export default function Card(){return null;}';

function makeRegistryBlueprint(
  overrides: Partial<RegistryBlueprint> = {},
): RegistryBlueprint {
  return {
    id: 'bp_11111111-1111-4111-8111-111111111111',
    kind: 'template',
    contractKey: blueprintKey(CONTRACT),
    variantKey: variantKey({}),
    variance: {},
    contract: CONTRACT,
    intent: 'a weather card',
    componentCode: CODE,
    createdAt: '2026-08-09T00:00:00.000Z',
    hitCount: 0,
    source: {
      kind: 'llm',
      generator: 'ui-gen-default-haiku-4-5',
      model: 'claude-haiku-4-5',
    },
    ...overrides,
  };
}

/** Recording `BlueprintStore` — only `put` is exercised here. */
function fakeBlueprintStore() {
  const rows: DurableBlueprint[] = [];
  const put = vi.fn(async (bp: DurableBlueprint) => {
    rows.push(bp);
  });
  const store: BlueprintStore = {
    put,
    list: async () => [],
    get: async () => null,
    setOperatorDefault: async () => {},
    delete: async () => {},
  };
  /** The one row written, or a failure naming what was expected. */
  const firstRow = (): DurableBlueprint => {
    const row = rows[0];
    if (!row) throw new Error('expected a durable blueprint write, got none');
    return row;
  };
  return { store, put, rows, firstRow };
}

/** Recording `CodeStore` over a Map. */
function fakeCodeStore() {
  const objects = new Map<string, string>();
  const put = vi.fn(async (hash: string, code: string) => {
    objects.set(hash, code);
  });
  const store: CodeStore = {
    put,
    get: async (hash) => objects.get(hash) ?? null,
    delete: async (hash) => {
      objects.delete(hash);
    },
    // Distinct from sha256Hex so a test can tell whether the code path
    // used the store's own derivation rather than recomputing.
    hashOf: (code) => `hash-of-${code.length}`,
  };
  return { store, put, objects };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BLUEPRINT_DURABILITY_EVENTS — the registry', () => {
  it('pins each event to its exact wire literal', () => {
    expect(BLUEPRINT_DURABILITY_EVENTS.durableWriteFailed).toBe(
      'blueprint_durable_write_failed',
    );
    expect(BLUEPRINT_DURABILITY_EVENTS.codeWriteFailed).toBe(
      'blueprint_code_write_failed',
    );
  });

  it('maps every key to a distinct value — one key per emitted name', () => {
    // A copy-paste that leaves two keys pointing at one wire name makes
    // one of them dead: emitters spell it, operators filter on it, and
    // nothing ever matches the key that lost.
    const values = Object.values(BLUEPRINT_DURABILITY_EVENTS);
    expect(new Set(values).size).toBe(values.length);
  });

  it('contains exactly these events and no others', () => {
    // Spelled as a literal array rather than derived from the registry:
    // rewriting this to `Object.values(...)` on both sides would make
    // the assertion vacuous, which is the whole failure mode it guards.
    expect(Object.values(BLUEPRINT_DURABILITY_EVENTS).sort()).toEqual(
      ['blueprint_code_write_failed', 'blueprint_durable_write_failed'].sort(),
    );
  });
});

describe('projectDurableBlueprint', () => {
  it('maps the registry contractKey onto the protocol contractHash', () => {
    const bp = makeRegistryBlueprint();
    const record = projectDurableBlueprint(bp, 'app-1', undefined);
    expect(record.contractHash).toBe(bp.contractKey);
    expect(record.contractHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('carries id, app, provenance, variance, contract and timestamp across', () => {
    const bp = makeRegistryBlueprint();
    const record = projectDurableBlueprint(bp, 'app-1', undefined);
    expect(record.blueprintId).toBe(bp.id);
    expect(record.appId).toBe('app-1');
    expect(record.source).toEqual(bp.source);
    expect(record.variance).toEqual(bp.variance);
    expect(record.contract).toEqual(bp.contract);
    expect(record.createdAt).toBe(bp.createdAt);
    expect(record.createdBy).toBe('agent');
  });

  it('omits codeHash when no body was stored', () => {
    const record = projectDurableBlueprint(
      makeRegistryBlueprint(),
      'app-1',
      undefined,
    );
    expect(record).not.toHaveProperty('codeHash');
  });

  it('sets codeHash when a body was stored', () => {
    const record = projectDurableBlueprint(
      makeRegistryBlueprint(),
      'app-1',
      'abc123',
    );
    expect(record.codeHash).toBe('abc123');
  });

  it('assigns the registry key rather than re-deriving it from the contract', () => {
    // Deliberately inconsistent: a row whose stored `contractKey`
    // disagrees with `blueprintKey(contract)`. The registry always
    // computes the two from the same contract, so a consistent fixture
    // passes whether the projection ASSIGNS the field or RECOMPUTES it
    // — this is the only shape that tells them apart.
    const bp = makeRegistryBlueprint({ contractKey: 'ffffffffffffffff' });
    const record = projectDurableBlueprint(bp, 'app-1', undefined);
    expect(record.contractHash).toBe('ffffffffffffffff');
    expect(record.contractHash).not.toBe(blueprintKey(CONTRACT));
  });

  it('defaults createdBy to agent', () => {
    const record = projectDurableBlueprint(
      makeRegistryBlueprint(),
      'app-1',
      undefined,
    );
    expect(record.createdBy).toBe('agent');
  });

  it('carries an operator-initiated mint through as operator', () => {
    // WHO invoked is a different axis from WHAT produced the code: an
    // operator-dispatched generation is `createdBy: 'operator'` AND
    // `source.kind: 'llm'`, so this cannot be derived from `source`.
    const record = projectDurableBlueprint(
      makeRegistryBlueprint(),
      'app-1',
      undefined,
      'operator',
    );
    expect(record.createdBy).toBe('operator');
    expect(record.source.kind).toBe('llm');
  });

  it('never invents a codeS3Url — the location is the adapter’s to compose', () => {
    const record = projectDurableBlueprint(
      makeRegistryBlueprint(),
      'app-1',
      'abc123',
    );
    expect(record.codeS3Url).toBeUndefined();
  });
});

describe('writeBlueprintDurably — wired', () => {
  it('writes the body first, then the row that points at it', async () => {
    const { store: bpStore, put: bpPut } = fakeBlueprintStore();
    const { store: codeStore, put: codePut } = fakeCodeStore();
    const bp = makeRegistryBlueprint();

    await writeBlueprintDurably(
      { blueprintStore: bpStore, codeStore },
      'app-1',
      bp,
    );

    expect(codePut).toHaveBeenCalledTimes(1);
    expect(bpPut).toHaveBeenCalledTimes(1);
    // Ordering is the contract: an orphan body is harmless, a row
    // naming an absent body is a lie. Defaults of -1 keep this
    // typesafe and would fail the comparison rather than pass vacuously
    // if either call were somehow missing.
    const [codeOrder = -1] = codePut.mock.invocationCallOrder;
    const [rowOrder = -1] = bpPut.mock.invocationCallOrder;
    expect(codeOrder).toBeGreaterThan(0);
    expect(codeOrder).toBeLessThan(rowOrder);
  });

  it('keys the body by the code store’s own hashOf, and the row agrees', async () => {
    const { store: bpStore, firstRow } = fakeBlueprintStore();
    const { store: codeStore, put: codePut, objects } = fakeCodeStore();
    const bp = makeRegistryBlueprint();

    await writeBlueprintDurably(
      { blueprintStore: bpStore, codeStore },
      'app-1',
      bp,
    );

    const expectedHash = codeStore.hashOf(CODE);
    expect(codePut).toHaveBeenCalledWith(expectedHash, CODE);
    expect(objects.get(expectedHash)).toBe(CODE);
    expect(firstRow().codeHash).toBe(expectedHash);
  });

  it('writes the row with the projected domain values', async () => {
    const { store: bpStore, firstRow } = fakeBlueprintStore();
    const bp = makeRegistryBlueprint();

    await writeBlueprintDurably({ blueprintStore: bpStore }, 'app-7', bp);

    const record = firstRow();
    expect(record.blueprintId).toBe(bp.id);
    expect(record.appId).toBe('app-7');
    expect(record.contractHash).toBe(blueprintKey(CONTRACT));
  });

  it('passes createdBy through to the persisted row', async () => {
    const { store: bpStore, firstRow } = fakeBlueprintStore();
    await writeBlueprintDurably(
      { blueprintStore: bpStore },
      'app-1',
      makeRegistryBlueprint(),
      'operator',
    );
    expect(firstRow().createdBy).toBe('operator');
  });

  it('persists metadata with no codeHash when no code store is bound', async () => {
    const { store: bpStore, put: bpPut, firstRow } = fakeBlueprintStore();

    await writeBlueprintDurably(
      { blueprintStore: bpStore },
      'app-1',
      makeRegistryBlueprint(),
    );

    expect(bpPut).toHaveBeenCalledTimes(1);
    expect(firstRow()).not.toHaveProperty('codeHash');
  });
});

describe('writeBlueprintDurably — unwired', () => {
  it('is a no-op with no deps at all', async () => {
    await expect(
      writeBlueprintDurably(undefined, 'app-1', makeRegistryBlueprint()),
    ).resolves.toBeUndefined();
  });

  it('touches nothing — not even the code store — without a blueprint store', async () => {
    const { store: codeStore, put: codePut } = fakeCodeStore();
    await writeBlueprintDurably({ codeStore }, 'app-1', makeRegistryBlueprint());
    // A body with no row to reference it is pure orphan; skip the write
    // rather than pay for garbage.
    expect(codePut).not.toHaveBeenCalled();
  });
});

describe('writeBlueprintDurably — best-effort failure', () => {
  it('emits blueprint_durable_write_failed and resolves when the row write rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bpStore: BlueprintStore = {
      put: async () => {
        throw new Error('blueprint store down');
      },
      list: async () => [],
      get: async () => null,
      setOperatorDefault: async () => {},
      delete: async () => {},
    };

    await expect(
      writeBlueprintDurably(
        { blueprintStore: bpStore },
        'app-1',
        makeRegistryBlueprint(),
      ),
    ).resolves.toBeUndefined();

    const event = JSON.parse(warn.mock.calls[0]?.[0] as string);
    expect(event.msg).toBe('blueprint_durable_write_failed');
    expect(event.blueprintId).toBe(
      'bp_11111111-1111-4111-8111-111111111111',
    );
    expect(event.contractKey).toBe(blueprintKey(CONTRACT));
    expect(event.appId).toBe('app-1');
    expect(event.source).toBe('llm');
    expect(event.error).toBe('blueprint store down');
  });

  it('emits blueprint_code_write_failed and still writes the row — without a codeHash', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { store: bpStore, put: bpPut, firstRow } = fakeBlueprintStore();
    const codeStore: CodeStore = {
      put: async () => {
        throw new Error('code store down');
      },
      get: async () => null,
      delete: async () => {},
      hashOf: () => 'unused',
    };

    await writeBlueprintDurably(
      { blueprintStore: bpStore, codeStore },
      'app-1',
      makeRegistryBlueprint(),
    );

    const event = JSON.parse(warn.mock.calls[0]?.[0] as string);
    expect(event.msg).toBe('blueprint_code_write_failed');
    // The row still lands, and it does NOT claim a body that is not
    // there — that lie is the failure mode this ordering exists to
    // prevent.
    expect(bpPut).toHaveBeenCalledTimes(1);
    expect(firstRow()).not.toHaveProperty('codeHash');
  });

  it('does not let a body failure suppress a subsequent row failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bpStore: BlueprintStore = {
      put: async () => {
        throw new Error('blueprint store down');
      },
      list: async () => [],
      get: async () => null,
      setOperatorDefault: async () => {},
      delete: async () => {},
    };
    const codeStore: CodeStore = {
      put: async () => {
        throw new Error('code store down');
      },
      get: async () => null,
      delete: async () => {},
      hashOf: () => 'unused',
    };

    await expect(
      writeBlueprintDurably(
        { blueprintStore: bpStore, codeStore },
        'app-1',
        makeRegistryBlueprint(),
      ),
    ).resolves.toBeUndefined();

    const names = warn.mock.calls.map(
      (call) => JSON.parse(call[0] as string).msg,
    );
    expect(names).toEqual([
      'blueprint_code_write_failed',
      'blueprint_durable_write_failed',
    ]);
  });
});
