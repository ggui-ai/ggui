/**
 * Atomic unit tests for the coverage guard — the deterministic safety
 * floor for cached-blueprint reuse. Pure, no store, no LLM.
 *
 * Guarantees, surface by surface, that `covers`/`coverageGap`:
 *   - accept equal + superset candidates (safe reuse),
 *   - reject a candidate missing ANY request-declared action / prop /
 *     context slot / stream channel / gadget (the 2026-05-09 subset bug),
 *   - ignore differences WITHIN a shared surface (relabel, schema noise),
 *   - report the exact missing keys.
 */

import { describe, it, expect } from 'vitest';
import type { DataContract, JsonSchema } from '@ggui-ai/protocol';
import { covers, coverageGap } from './blueprint-coverage.js';

const voidSchema: JsonSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

describe('covers — equal / superset candidates are safe', () => {
  it('equal surfaces → covers, no gap', () => {
    const c: DataContract = {
      actionSpec: { submit: { label: 'Go', schema: voidSchema } },
      propsSpec: { properties: { city: { schema: { type: 'string' } } } },
    };
    expect(covers(c, c)).toBe(true);
    expect(coverageGap(c, c)).toEqual({
      actions: [],
      props: [],
      context: [],
      streams: [],
      gadgets: [],
      actionMembers: [],
    });
  });

  it('candidate SUPERSET (extra action) still covers the request', () => {
    const candidate: DataContract = {
      actionSpec: {
        increment: { label: 'Inc', schema: voidSchema },
        decrement: { label: 'Dec', schema: voidSchema },
        reset: { label: 'Reset', schema: voidSchema },
      },
    };
    const request: DataContract = {
      actionSpec: {
        increment: { label: 'Inc', schema: voidSchema },
        reset: { label: 'Reset', schema: voidSchema },
      },
    };
    expect(covers(candidate, request)).toBe(true);
  });

  it('an empty request is covered by anything (and by the empty contract)', () => {
    expect(covers({ actionSpec: { x: { label: 'x' } } }, {})).toBe(true);
    expect(covers({}, {})).toBe(true);
  });
});

describe('covers — a SUBSET candidate is rejected (the 2026-05-09 bug)', () => {
  it('candidate missing a request action → NOT covered, names the gap', () => {
    const candidate: DataContract = {
      actionSpec: {
        increment: { label: 'Inc', schema: voidSchema },
        reset: { label: 'Reset', schema: voidSchema },
      },
      contextSpec: { count: { schema: { type: 'number' }, default: 0 } },
    };
    const request: DataContract = {
      actionSpec: {
        increment: { label: 'Inc', schema: voidSchema },
        decrement: { label: 'Dec', schema: voidSchema },
        reset: { label: 'Reset', schema: voidSchema },
      },
      contextSpec: { count: { schema: { type: 'number' }, default: 0 } },
    };
    expect(covers(candidate, request)).toBe(false);
    expect(coverageGap(candidate, request).actions).toEqual(['decrement']);
  });

  it('missing a request prop → gap.props', () => {
    const candidate: DataContract = {
      propsSpec: { properties: { todos: { schema: { type: 'array' } } } },
    };
    const request: DataContract = {
      propsSpec: {
        properties: {
          todos: { schema: { type: 'array' } },
          filter: { schema: { type: 'string' } },
        },
      },
    };
    expect(covers(candidate, request)).toBe(false);
    expect(coverageGap(candidate, request).props).toEqual(['filter']);
  });

  it('missing a request context slot → gap.context', () => {
    const candidate: DataContract = {
      contextSpec: { query: { schema: { type: 'string' }, default: '' } },
    };
    const request: DataContract = {
      contextSpec: {
        query: { schema: { type: 'string' }, default: '' },
        sort: { schema: { type: 'string' }, default: 'asc' },
      },
    };
    expect(coverageGap(candidate, request).context).toEqual(['sort']);
  });

  it('missing a request stream channel → gap.streams', () => {
    const candidate: DataContract = {
      streamSpec: { ticks: { schema: { type: 'object' } } },
    };
    const request: DataContract = {
      streamSpec: {
        ticks: { schema: { type: 'object' } },
        alerts: { schema: { type: 'object' } },
      },
    };
    expect(coverageGap(candidate, request).streams).toEqual(['alerts']);
  });

  it('missing a request gadget → gap.gadgets', () => {
    const candidate: DataContract = {
      clientCapabilities: {
        gadgets: { '@ggui-ai/gadgets': { useGeolocation: {} } },
      },
    };
    const request: DataContract = {
      clientCapabilities: {
        gadgets: { '@ggui-ai/gadgets': { useGeolocation: {}, useCamera: {} } },
      },
    };
    expect(covers(candidate, request)).toBe(false);
    expect(coverageGap(candidate, request).gadgets).toEqual([
      '@ggui-ai/gadgets\tuseCamera',
    ]);
  });

  it('reports multiple gaps at once', () => {
    const candidate: DataContract = { actionSpec: { a: { label: 'a' } } };
    const request: DataContract = {
      actionSpec: { a: { label: 'a' }, b: { label: 'b' } },
      propsSpec: { properties: { x: { schema: { type: 'string' } } } },
    };
    const gap = coverageGap(candidate, request);
    expect(gap.actions).toEqual(['b']);
    expect(gap.props).toEqual(['x']);
    expect(covers(candidate, request)).toBe(false);
  });
});

describe('covers — tolerates differences WITHIN a shared surface', () => {
  it('same action keyset, different labels + payload schema → still covers (the todo case)', () => {
    const cached: DataContract = {
      propsSpec: { properties: { todos: { schema: { type: 'array' } } } },
      actionSpec: {
        addTodo: { label: 'Add todo item' },
        toggleTodo: {
          label: 'Toggle',
          schema: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
          },
        },
      },
    };
    const agent: DataContract = {
      propsSpec: { properties: { todos: { schema: { type: 'array' } } } },
      actionSpec: {
        addTodo: { label: 'Add a NEW todo item' }, // relabeled
        toggleTodo: {
          label: "Toggle a todo's done state", // relabeled
          schema: {
            type: 'object',
            properties: { id: { type: 'string' }, done: { type: 'boolean' } },
            required: ['id', 'done'], // different payload schema
          },
        },
      },
    };
    // Same key-sets {todos} / {addTodo, toggleTodo} → covered, despite
    // label + schema noise. This is the legitimate reuse the cache must allow.
    expect(covers(cached, agent)).toBe(true);
    expect(covers(agent, cached)).toBe(true);
  });
});

// ggui#1428 — coverage on a shared action also compares the members that
// change what the runtime does with a gesture. A stored card without the
// `oneShot` the draft declares serves a card with no one-shot guard; before
// this the gap was empty and the agent was told nothing.
describe('coverageGap — load-bearing members of a shared action (ggui#1428)', () => {
  const draft = (entry: NonNullable<DataContract['actionSpec']>[string]): DataContract => ({
    actionSpec: { confirm: entry },
  });

  it('a stored action without the oneShot the draft declares is a gap at <action>.oneShot, and no longer covers', () => {
    const stored = draft({ label: 'Confirm' });
    const request = draft({ label: 'Confirm', oneShot: true });
    expect(coverageGap(stored, request).actionMembers).toEqual(['confirm.oneShot']);
    expect(coverageGap(stored, request).actions).toEqual([]);
    expect(covers(stored, request)).toBe(false);
  });

  it('equal members are no gap', () => {
    const both = draft({ label: 'Confirm', oneShot: true, confirm: true, nextStep: 'order_place' });
    expect(coverageGap(both, both).actionMembers).toEqual([]);
    expect(covers(both, both)).toBe(true);
  });

  it('confirm and nextStep are compared the same way; a different nextStep is a gap', () => {
    const stored = draft({ label: 'Confirm', nextStep: 'order_cancel' });
    const request = draft({ label: 'Confirm', confirm: true, nextStep: 'order_place' });
    expect(coverageGap(stored, request).actionMembers).toEqual(['confirm.confirm', 'confirm.nextStep']);
  });

  it('one direction: a stored card that is stricter than the draft is not a gap', () => {
    const stored = draft({ label: 'Confirm', oneShot: true, confirm: true, nextStep: 'order_place' });
    const request = draft({ label: 'Confirm' });
    expect(coverageGap(stored, request).actionMembers).toEqual([]);
    expect(covers(stored, request)).toBe(true);
  });

  it('a member declared false reads as not declared', () => {
    const stored = draft({ label: 'Confirm' });
    const request = draft({ label: 'Confirm', oneShot: false, confirm: false });
    expect(coverageGap(stored, request).actionMembers).toEqual([]);
  });

  it('an action the stored card lacks altogether stays in `actions`, never in `actionMembers`', () => {
    const stored: DataContract = { actionSpec: { cancel: { label: 'Cancel' } } };
    const request = draft({ label: 'Confirm', oneShot: true });
    const gap = coverageGap(stored, request);
    expect(gap.actions).toEqual(['confirm']);
    expect(gap.actionMembers).toEqual([]);
  });
});
