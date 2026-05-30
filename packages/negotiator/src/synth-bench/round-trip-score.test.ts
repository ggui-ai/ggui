/**
 * Deterministic round-trip scorer pinning. Runs WITHOUT an LLM.
 *
 * Two roles:
 *   1. Scorer pinning — hand-built contracts exercise each round-trip
 *      failure mode (and the clean pass) so a regression in
 *      scoreContractRoundTrip surfaces in CI without burning LLM cost.
 *      The load-bearing case: a contract that reshapes a seedable
 *      collection propsSpec → contextSpec scores `props-no-home` even
 *      though it is structurally valid — the exact "valid-but-broken"
 *      bug the shape scorer is blind to.
 *   2. Repair-corpus integrity — every REPAIR_CORPUS entry carries a
 *      draft + a round-trip expectation, so the live repair probe is
 *      well-formed.
 */

import { describe, it, expect } from 'vitest';
import type { DataContract } from '@ggui-ai/protocol';
import { scoreContractRoundTrip } from './round-trip-score.js';
import { REPAIR_CORPUS } from './corpus.js';

describe('scoreContractRoundTrip — reshape regression (the falsifier)', () => {
  it('flags props-no-home when a seedable collection was reshaped to contextSpec', () => {
    // VALID contract (passes lintContract) but round-trip-BROKEN: the
    // agent's seed props { todos } hit a contract with no propsSpec.
    const reshaped: DataContract = {
      contextSpec: {
        todos: {
          schema: { type: 'array', items: { type: 'object' } },
          default: [],
        },
      },
      actionSpec: {
        toggleTodo: { label: 'Toggle todo' },
        addTodo: { label: 'Add todo' },
      },
    };
    const score = scoreContractRoundTrip(reshaped, {
      renderProps: { todos: [{ id: 't1', text: 'Buy milk', completed: false }] },
      consumableActions: ['toggleTodo', 'addTodo'],
    });
    expect(score.pass).toBe(false);
    expect(score.failures.map((f) => f.kind)).toContain('props-no-home');
    // The declared gestures still round-trip — only the seed channel broke.
    expect(score.failures.map((f) => f.kind)).not.toContain('action-undeclared');
  });

  it('passes the round-trip-correct todo contract (todos stays on propsSpec)', () => {
    const good: DataContract = {
      propsSpec: {
        properties: {
          todos: {
            required: true,
            schema: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  text: { type: 'string' },
                  completed: { type: 'boolean' },
                },
                required: ['id', 'text', 'completed'],
              },
            },
          },
        },
      },
      actionSpec: {
        toggleTodo: { label: 'Toggle todo' },
        addTodo: { label: 'Add todo' },
      },
    };
    const score = scoreContractRoundTrip(good, {
      renderProps: { todos: [{ id: 't1', text: 'Buy milk', completed: false }] },
      consumableActions: ['toggleTodo', 'addTodo'],
    });
    expect(score.pass).toBe(true);
    expect(score.failures).toEqual([]);
  });
});

describe('scoreContractRoundTrip — consumable gestures', () => {
  it('flags action-undeclared when an expected gesture is missing from actionSpec', () => {
    const formNoSubmit: DataContract = {
      contextSpec: { name: { schema: { type: 'string' }, default: '' } },
    };
    const score = scoreContractRoundTrip(formNoSubmit, {
      consumableActions: ['submit'],
    });
    expect(score.pass).toBe(false);
    expect(score.failures.map((f) => f.kind)).toContain('action-undeclared');
  });

  it('passes when the expected gesture is declared', () => {
    const formWithSubmit: DataContract = {
      contextSpec: { name: { schema: { type: 'string' }, default: '' } },
      actionSpec: { submit: { label: 'Send message' } },
    };
    const score = scoreContractRoundTrip(formWithSubmit, {
      consumableActions: ['submit'],
    });
    expect(score.pass).toBe(true);
    expect(score.failures).toEqual([]);
  });
});

describe('scoreContractRoundTrip — props validity + structure', () => {
  it('flags contract-empty when repair bailed to {} but data was expected', () => {
    const empty: DataContract = {};
    const score = scoreContractRoundTrip(empty, {
      renderProps: { todos: [] },
    });
    expect(score.pass).toBe(false);
    expect(score.failures.map((f) => f.kind)).toContain('contract-empty');
  });

  it('flags props-rejected when seed props violate the propsSpec schema', () => {
    const numProps: DataContract = {
      propsSpec: {
        properties: { count: { required: true, schema: { type: 'number' } } },
      },
    };
    const score = scoreContractRoundTrip(numProps, {
      renderProps: { count: 'five' },
    });
    expect(score.pass).toBe(false);
    expect(score.failures.map((f) => f.kind)).toContain('props-rejected');
    expect(score.failures.map((f) => f.kind)).not.toContain('props-no-home');
  });

  it('flags props-key-unhomed when a seed key has no propsSpec entry', () => {
    const cityProps: DataContract = {
      propsSpec: {
        properties: { city: { required: true, schema: { type: 'string' } } },
      },
    };
    const score = scoreContractRoundTrip(cityProps, {
      renderProps: { city: 'San Francisco', extra: 'x' },
    });
    expect(score.pass).toBe(false);
    expect(score.failures.map((f) => f.kind)).toContain('props-key-unhomed');
  });

  it('vacuously passes a contract with no seed / gesture expectation', () => {
    const counter: DataContract = {
      contextSpec: { count: { schema: { type: 'number' }, default: 0 } },
    };
    const score = scoreContractRoundTrip(counter, {});
    expect(score.pass).toBe(true);
    expect(score.failures).toEqual([]);
  });
});

describe('REPAIR_CORPUS integrity', () => {
  it('has at least the four quadrant entries', () => {
    expect(REPAIR_CORPUS.length).toBeGreaterThanOrEqual(4);
  });

  it('every entry has a unique id', () => {
    const ids = REPAIR_CORPUS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every entry carries a draft and a non-empty intent', () => {
    for (const entry of REPAIR_CORPUS) {
      expect(entry.draft, `entry ${entry.id} has no draft`).toBeDefined();
      expect(entry.intent.trim().length).toBeGreaterThan(0);
    }
  });

  it('every entry declares a round-trip expectation', () => {
    for (const entry of REPAIR_CORPUS) {
      expect(
        entry.roundTrip,
        `entry ${entry.id} has no roundTrip expectation`,
      ).toBeDefined();
    }
  });
});
