/**
 * `salvageConformingSubset` pins (ggui#523 item 3 — "make `{}`
 * impossible"). Deterministic, no LLM. The two properties that matter:
 *
 *   - what conforms in the draft SURVIVES, entry by entry, and every
 *     removal is reported with the gate's own finding at the cut path;
 *   - when nothing usable survives, the answer is `null` (decline), never
 *     an empty contract dressed as a proposal.
 */
import { describe, expect, it } from 'vitest';
import { lintContract } from '@ggui-ai/protocol';
import { cutFor, declaresAnySurface, salvageConformingSubset } from './salvage-draft.js';

const goodProps = {
  description: 'Board state',
  properties: {
    columns: { required: true, schema: { type: 'array', items: { type: 'object' } } },
    title: { required: false, schema: { type: 'string' } },
  },
};

describe('salvageConformingSubset', () => {
  it('returns a clean draft untouched, with nothing dropped', () => {
    const draft = {
      propsSpec: goodProps,
      actionSpec: { moveCard: { label: 'Move', schema: { type: 'object' } } },
    };
    const out = salvageConformingSubset(draft);
    expect(out).not.toBeNull();
    expect(out!.dropped).toEqual([]);
    expect(Object.keys(out!.contract.actionSpec!)).toEqual(['moveCard']);
    expect(lintContract(out!.contract).errors).toEqual([]);
  });

  it('drops ONLY the offending action entry and reports it at the entry path', () => {
    const draft = {
      propsSpec: goodProps,
      actionSpec: {
        moveCard: { label: 'Move', schema: { type: 'object' } },
        // The classic malformation: a flat JSON Schema instead of the
        // `{label, schema}` wrapper.
        addCard: { type: 'object', properties: { text: { type: 'string' } } },
      },
    };
    const out = salvageConformingSubset(draft);
    expect(out).not.toBeNull();
    expect(Object.keys(out!.contract.actionSpec!)).toEqual(['moveCard']);
    expect(Object.keys(out!.contract.propsSpec!.properties)).toEqual(['columns', 'title']);
    expect(out!.dropped.length).toBeGreaterThan(0);
    expect(out!.dropped.every((d) => d.path.startsWith('actionSpec.addCard'))).toBe(true);
    expect(out!.dropped[0]!.severity).toBe('error');
    expect(lintContract(out!.contract).errors).toEqual([]);
  });

  it('cuts a bad sub-field before the whole entry when that is enough', () => {
    const draft = {
      propsSpec: goodProps,
      actionSpec: {
        // `nextStep` names a tool the contract does not declare — a
        // reference-phase error at `actionSpec.archive.nextStep`. The
        // action itself is fine without the hint.
        archive: { label: 'Archive', schema: { type: 'object' }, nextStep: 'todo_archive' },
      },
    };
    const out = salvageConformingSubset(draft);
    expect(out).not.toBeNull();
    expect(out!.contract.actionSpec).toBeDefined();
    expect(Object.keys(out!.contract.actionSpec!)).toEqual(['archive']);
    expect((out!.contract.actionSpec!['archive'] as { nextStep?: string }).nextStep).toBeUndefined();
    expect(out!.dropped.map((d) => d.path)).toContain('actionSpec.archive.nextStep');
  });

  it('drops a bad prop AND its stale `propsSpec.required` name in one cut', () => {
    const draft = {
      propsSpec: {
        properties: {
          columns: { required: true, schema: { type: 'array', items: { type: 'object' } } },
          broken: { required: true }, // no schema — the wrapper is incomplete
        },
      },
      actionSpec: { moveCard: { label: 'Move', schema: { type: 'object' } } },
    };
    const out = salvageConformingSubset(draft);
    expect(out).not.toBeNull();
    expect(Object.keys(out!.contract.propsSpec!.properties)).toEqual(['columns']);
    expect(lintContract(out!.contract).errors).toEqual([]);
  });

  it('removes a retired top-level field and keeps the rest', () => {
    const draft = {
      propsSpec: goodProps,
      // Retired top-level field (→ clientCapabilities.gadgets) — a hard
      // error the gate names at the field (`RETIRED_CONTRACT_FIELDS`).
      libraries: ['@ggui-ai/gadgets'],
    };
    const out = salvageConformingSubset(draft);
    expect(out).not.toBeNull();
    expect((out!.contract as Record<string, unknown>)['libraries']).toBeUndefined();
    expect(Object.keys(out!.contract.propsSpec!.properties)).toEqual(['columns', 'title']);
    expect(out!.dropped.some((d) => d.path === 'libraries')).toBe(true);
  });

  it('DECLINES (null) when nothing usable survives — never an empty proposal', () => {
    const draft = {
      // Every entry is a flat schema (no wrapper): all of them go, and
      // what is left declares no surface.
      actionSpec: {
        a: { type: 'object' },
        b: { type: 'string' },
      },
    };
    expect(salvageConformingSubset(draft)).toBeNull();
  });

  it('DECLINES a draft that is not an object at all', () => {
    expect(salvageConformingSubset('not a contract')).toBeNull();
    expect(salvageConformingSubset(null)).toBeNull();
    expect(salvageConformingSubset(['a'])).toBeNull();
  });

  it('DECLINES an empty draft rather than echoing `{}` as a salvage', () => {
    // A clean `{}` is the caller's verbatim case, not a salvage; here it
    // is the "nothing survives" verdict by construction.
    expect(salvageConformingSubset({})).toBeNull();
  });

  it('never mutates the input', () => {
    const draft = {
      propsSpec: goodProps,
      actionSpec: { bad: { type: 'object' }, ok: { label: 'Ok', schema: { type: 'object' } } },
    };
    const before = JSON.stringify(draft);
    salvageConformingSubset(draft);
    expect(JSON.stringify(draft)).toBe(before);
  });
});

describe('declaresAnySurface', () => {
  it('is false for the empty contract and true for any single declared surface', () => {
    expect(declaresAnySurface({})).toBe(false);
    expect(declaresAnySurface({ propsSpec: { properties: {} } })).toBe(false);
    expect(declaresAnySurface({ contextSpec: { q: { schema: { type: 'string' } } } })).toBe(true);
    expect(declaresAnySurface({ streamSpec: { s: { schema: { type: 'string' } } } })).toBe(true);
  });
});

describe('cutFor', () => {
  it('maps gate paths to the cut, leaf-first then entry', () => {
    expect(cutFor('actionSpec.archive.nextStep', true)).toEqual(['actionSpec', 'archive', 'nextStep']);
    expect(cutFor('actionSpec.archive.nextStep', false)).toEqual(['actionSpec', 'archive']);
    expect(cutFor('propsSpec.properties.title.schema.type', false)).toEqual(['propsSpec', 'properties', 'title']);
    expect(cutFor('agentCapabilities.tools.todo_add.toolInfo', false)).toEqual(['agentCapabilities', 'tools', 'todo_add']);
    expect(cutFor('propsSpec.description', true)).toEqual(['propsSpec']);
    expect(cutFor('libraries', true)).toEqual(['libraries']);
    expect(cutFor('<root>', true)).toBeNull();
  });
});
