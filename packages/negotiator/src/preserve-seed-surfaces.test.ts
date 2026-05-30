/**
 * Seed-surface preservation (L1) pinning. No LLM.
 *
 * findDroppedSeedSurfaces is the deterministic, model-independent check
 * that makes the repair loop FAITHFUL: it flags every agent-owned
 * propsSpec seed surface a candidate dropped. These tests pin the
 * canonical reshape regression (propsSpec.todos → contextSpec.todos) and
 * the preservation-bias (a kept-or-improved surface never flags).
 */

import { describe, it, expect } from 'vitest';
import type { DataContract } from '@ggui-ai/protocol';
import {
  draftSeedPropKeys,
  findDroppedSeedSurfaces,
} from './preserve-seed-surfaces.js';

describe('draftSeedPropKeys', () => {
  it('extracts propsSpec property keys from a (possibly malformed) draft', () => {
    const draft = {
      propsSpec: {
        required: ['todos'], // stray key is irrelevant to key extraction
        properties: { todos: { schema: { type: 'array' } }, count: {} },
      },
    };
    expect(draftSeedPropKeys(draft).sort()).toEqual(['count', 'todos']);
  });

  it('returns [] for drafts with no agent-owned seed surface', () => {
    expect(draftSeedPropKeys({ contextSpec: { q: {} } })).toEqual([]);
    expect(draftSeedPropKeys({})).toEqual([]);
    expect(draftSeedPropKeys(null)).toEqual([]);
    expect(draftSeedPropKeys('x')).toEqual([]);
  });
});

describe('findDroppedSeedSurfaces — the reshape falsifier', () => {
  const draft = {
    propsSpec: {
      properties: {
        todos: { required: true, schema: { type: 'array' } },
      },
    },
  };

  it('flags todos when the candidate reshaped propsSpec → contextSpec', () => {
    const reshaped: DataContract = {
      contextSpec: { todos: { schema: { type: 'array' }, default: [] } },
    };
    expect(findDroppedSeedSurfaces(draft, reshaped)).toEqual(['todos']);
  });

  it('flags todos when the candidate dropped the surface entirely', () => {
    const actionsOnly: DataContract = {
      actionSpec: { addTodo: { label: 'Add' } },
    };
    expect(findDroppedSeedSurfaces(draft, actionsOnly)).toEqual(['todos']);
  });

  it('does NOT flag when the candidate kept todos on propsSpec', () => {
    const preserved: DataContract = {
      propsSpec: {
        properties: { todos: { required: true, schema: { type: 'array' } } },
      },
      actionSpec: { addTodo: { label: 'Add' } },
    };
    expect(findDroppedSeedSurfaces(draft, preserved)).toEqual([]);
  });

  it('flags only the dropped keys when the draft declared several', () => {
    const multi = {
      propsSpec: {
        properties: { todos: { schema: {} }, filter: { schema: {} } },
      },
    };
    const candidate: DataContract = {
      propsSpec: { properties: { todos: { schema: { type: 'array' } } } },
    };
    expect(findDroppedSeedSurfaces(multi, candidate)).toEqual(['filter']);
  });

  it('returns [] when the draft had no seed surface (nothing to preserve)', () => {
    const candidate: DataContract = { contextSpec: { count: { schema: {} } } };
    expect(findDroppedSeedSurfaces({ contextSpec: {} }, candidate)).toEqual([]);
  });
});
