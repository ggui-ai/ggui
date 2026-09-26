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
import { actionEntrySchema, lintContract, streamChannelEntrySchema } from '@ggui-ai/protocol';
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
        tools: {
          t: {
            toolInfo: { inputSchema: { type: 'object' }, bogusInnerKey: 4 },
            bogusToolKey: 3,
          },
        },
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
    const cleanedTool = (
      (out['agentCapabilities'] as Record<string, unknown>)['tools'] as Record<
        string,
        Record<string, unknown>
      >
    )['t'];
    // Stray key on the OUTER entry is stripped.
    expect(cleanedTool['bogusToolKey']).toBeUndefined();
    // Stray key INSIDE toolInfo is stripped too (nested clean).
    expect(
      (cleanedTool['toolInfo'] as Record<string, unknown>)['bogusInnerKey'],
    ).toBeUndefined();
    // The legitimate nested inputSchema survives.
    expect(
      (cleanedTool['toolInfo'] as Record<string, unknown>)['inputSchema'],
    ).toBeDefined();
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

describe('normalizeDraft — keeps every member the protocol entry schemas name (ggui#1421)', () => {
  // The allowed-key sets are DERIVED from the protocol's `.strict()` entry
  // schemas, so this pin cannot drift when a schema grows: it builds one
  // entry per spec carrying every key its schema names and expects every
  // key back. `oneShot` is the member that was lost for eleven days.
  it('an action entry carrying every actionEntrySchema key survives, oneShot included', () => {
    const memberKeys = Object.keys(actionEntrySchema.shape).sort();
    expect(memberKeys).toContain('oneShot');
    // Built FROM the schema's keys, so a member added to actionEntrySchema
    // tomorrow is exercised here the same day (a hand-listed entry would not be).
    const sample: Record<string, unknown> = {
      description: 'Places the reservation',
      label: 'Confirm booking',
      schema: { type: 'object', properties: {}, additionalProperties: false },
      example: {},
      icon: 'check',
      confirm: true,
      oneShot: true,
      nextStep: 'booking_confirm',
    };
    for (const key of memberKeys) expect(sample, `no sample value for actionEntrySchema key '${key}'`).toHaveProperty(key);
    const draft = {
      agentCapabilities: { tools: { booking_confirm: { toolInfo: { inputSchema: { type: 'object' } } } } },
      actionSpec: { confirm: Object.fromEntries(memberKeys.map((k) => [k, sample[k]])) },
    };
    const out = normalizeDraft(draft) as { actionSpec: Record<string, Record<string, unknown>> };
    const confirm = out.actionSpec['confirm'];
    expect(confirm).toBeDefined();
    expect(Object.keys(confirm ?? {}).sort()).toEqual(memberKeys);
    expect(confirm?.['oneShot']).toBe(true);
    expect(lintContract(out).errors).toEqual([]);
  });

  it('a stream entry carrying every streamChannelEntrySchema key survives (mode / replay / complete / example)', () => {
    const memberKeys = Object.keys(streamChannelEntrySchema.shape).sort();
    const draft = {
      streamSpec: {
        ticks: {
          description: 'live ticks',
          schema: { type: 'object', properties: {}, additionalProperties: false },
          example: {},
          mode: 'append',
          replay: 'latest',
          complete: false,
          source: { tool: 'ticker' },
        },
      },
      agentCapabilities: { tools: { ticker: { toolInfo: { inputSchema: { type: 'object' } } } } },
    };
    const out = normalizeDraft(draft) as { streamSpec: Record<string, Record<string, unknown>> };
    expect(Object.keys(out.streamSpec['ticks'] ?? {}).sort()).toEqual(memberKeys);
  });
});
