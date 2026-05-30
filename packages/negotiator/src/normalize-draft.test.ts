/**
 * Deterministic normalization tier (L3) pinning. No LLM.
 *
 * normalizeDraft must fix the MECHANICAL malformation classes (stray
 * illegal wrapper keys, non-canonical schema types) so they never reach
 * the LLM repair loop — and must do so FAITHFULLY (the agent's real
 * specs survive untouched). These tests pin the two load-bearing cases
 * (the R1 stray-`required` key and the R4 stray-`additionalProperties`
 * key) plus the no-op-on-clean-input invariant.
 */

import { describe, it, expect } from 'vitest';
import { lintContract } from '@ggui-ai/protocol';
import { normalizeDraft } from './normalize-draft.js';

describe('normalizeDraft — strips illegal wrapper keys, preserves the rest', () => {
  it('drops a stray propsSpec-wrapper `required` array (R1) → draft now lint-clean, todos preserved', () => {
    const draft = {
      propsSpec: {
        description: "The user's todos",
        required: ['todos'], // illegal at the wrapper level
        properties: {
          todos: {
            required: true,
            schema: { type: 'array', items: { type: 'object' } },
          },
        },
      },
    };
    const out = normalizeDraft(draft) as Record<string, unknown>;
    const propsSpec = out['propsSpec'] as Record<string, unknown>;
    // stray key gone…
    expect(propsSpec['required']).toBeUndefined();
    // …agent's real seed surface untouched
    const properties = propsSpec['properties'] as Record<string, unknown>;
    expect(properties['todos']).toBeDefined();
    // and the whole draft now passes the gate WITHOUT an LLM
    expect(lintContract(out).errors).toEqual([]);
  });

  it('drops a stray propsSpec-wrapper `additionalProperties` key (R4)', () => {
    const draft = {
      propsSpec: {
        description: 'Current weather',
        additionalProperties: false, // illegal at the wrapper level
        properties: {
          city: { required: true, schema: { type: 'string' } },
          temp: { required: true, schema: { type: 'number' } },
        },
      },
    };
    const out = normalizeDraft(draft) as Record<string, unknown>;
    const propsSpec = out['propsSpec'] as Record<string, unknown>;
    expect(propsSpec['additionalProperties']).toBeUndefined();
    expect(Object.keys(propsSpec['properties'] as object)).toEqual([
      'city',
      'temp',
    ]);
    expect(lintContract(out).errors).toEqual([]);
  });

  it('strips illegal keys on actionSpec / contextSpec / agentCapabilities entries', () => {
    const draft = {
      contextSpec: { q: { schema: { type: 'string' }, bogusSlotKey: 1 } },
      actionSpec: {
        submit: { label: 'Go', schema: { type: 'object' }, bogusActionKey: 2 },
      },
      agentCapabilities: {
        tools: { t: { inputSchema: { type: 'object' }, bogusToolKey: 3 } },
      },
    };
    const out = normalizeDraft(draft) as Record<string, unknown>;
    expect(
      (out['contextSpec'] as Record<string, Record<string, unknown>>)['q'][
        'bogusSlotKey'
      ],
    ).toBeUndefined();
    expect(
      (out['actionSpec'] as Record<string, Record<string, unknown>>)['submit'][
        'bogusActionKey'
      ],
    ).toBeUndefined();
    expect(
      (
        (out['agentCapabilities'] as Record<string, unknown>)['tools'] as Record<
          string,
          Record<string, unknown>
        >
      )['t']['bogusToolKey'],
    ).toBeUndefined();
  });

  it('leaves an already-valid draft semantically intact (no spurious churn)', () => {
    const draft = {
      propsSpec: {
        properties: { city: { required: true, schema: { type: 'string' } } },
      },
      actionSpec: { submit: { label: 'Submit', schema: { type: 'object' } } },
    };
    const out = normalizeDraft(draft);
    expect(lintContract(out).errors).toEqual([]);
    // the seed surface and action survive
    const o = out as Record<string, Record<string, Record<string, unknown>>>;
    expect(o['propsSpec']['properties']['city']).toBeDefined();
    expect(o['actionSpec']['submit']).toBeDefined();
  });

  it('passes non-record input through untouched', () => {
    expect(normalizeDraft(null)).toBeNull();
    expect(normalizeDraft('nope')).toBe('nope');
    expect(normalizeDraft(undefined)).toBeUndefined();
  });
});
