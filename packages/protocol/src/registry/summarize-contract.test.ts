import { describe, it, expect } from 'vitest';
import { summarizeContract } from './summarize-contract.js';

describe('summarizeContract', () => {
  it('emits stable shape on empty / undefined contract', () => {
    expect(summarizeContract(undefined)).toBe(
      'slots=∅; actions=∅; streams=∅',
    );
    expect(summarizeContract({})).toBe(
      'slots=∅; actions=∅; streams=∅',
    );
  });

  it('orders slot keys deterministically (paraphrase-stable) and surfaces type', () => {
    const a = summarizeContract({
      contextSpec: {
        topic: { schema: { type: 'string' }, default: 'Bug' },
        noteText: { schema: { type: 'string' }, default: '' },
      },
    });
    const b = summarizeContract({
      contextSpec: {
        noteText: { schema: { type: 'string' }, default: '' },
        topic: { schema: { type: 'string' }, default: 'Bug' },
      },
    });
    expect(a).toBe(b);
    expect(a).toContain('slots=noteText:string,topic:string');
  });

  it('orders action keys deterministically and bare-names payload-less actions', () => {
    const summary = summarizeContract({
      actionSpec: {
        submit: { label: 'Submit' },
        cancel: { label: 'Cancel' },
      },
    });
    expect(summary).toContain('actions=cancel,submit');
  });

  it('surfaces props names + types, marking required props with a trailing `!`', () => {
    const summary = summarizeContract({
      propsSpec: {
        properties: {
          rating: { schema: { type: 'number' }, required: true },
          comment: { schema: { type: 'string' } },
        },
      },
    });
    // `rating` is required → `rating:number!`; `comment` is optional →
    // `comment:string` (no marker).
    expect(summary).toContain('props=comment:string,rating:number!');
  });

  it('marks a required untyped prop as `name!` and leaves optional/absent unmarked', () => {
    const summary = summarizeContract({
      propsSpec: {
        properties: {
          // required + untyped (no schema.type) → `bare!`
          bare: { schema: {}, required: true },
          // required:false is explicitly NOT required → no marker
          optional: { schema: { type: 'string' }, required: false },
          // absent `required` (undefined) → no marker
          implicit: { schema: { type: 'boolean' } },
        },
      },
    });
    expect(summary).toContain('props=bare!,implicit:boolean,optional:string');
  });

  it('omits props segment entirely when no props declared', () => {
    const summary = summarizeContract({
      contextSpec: { x: { schema: { type: 'string' } } },
    });
    expect(summary).not.toContain('props=');
  });

  it('full surface — all four spec families plus props', () => {
    const summary = summarizeContract({
      propsSpec: { properties: { x: { schema: { type: 'string' } } } },
      contextSpec: { y: { schema: { type: 'string' } } },
      actionSpec: { z: { label: 'Z' } },
      streamSpec: { w: { schema: { type: 'string' } } },
    });
    expect(summary).toBe(
      'slots=y:string; actions=z; streams=w; props=x:string',
    );
  });

  it('docstring example — a required prop renders `name:type!`', () => {
    const summary = summarizeContract({
      propsSpec: {
        properties: { x: { schema: { type: 'string' }, required: true } },
      },
      contextSpec: { y: { schema: { type: 'string' } } },
      actionSpec: { z: { label: 'Z' } },
      streamSpec: { w: { schema: { type: 'string' } } },
    });
    expect(summary).toBe(
      'slots=y:string; actions=z; streams=w; props=x:string!',
    );
  });

  describe('payload-bearing actions (Bug 2 fix — judge sees schema differences)', () => {
    // Two contracts with the SAME action name but DIFFERENT payload
    // shapes must NOT collapse to the same summary string. Otherwise
    // RAG retrieval + the rerank judge would treat them as
    // interchangeable, and a payload-less cached blueprint would be
    // served to a request expecting a payload — runtime emits
    // `data: {}` and the agent loses the user's input.

    it('payload fields land in `actions=name(field1,field2)` form', () => {
      const summary = summarizeContract({
        actionSpec: {
          sendChip: {
            label: 'Send chip',
            schema: {
              type: 'object',
              properties: {
                chipText: { type: 'string' },
              },
              required: ['chipText'],
            },
          },
        },
      });
      expect(summary).toContain('actions=sendChip(chipText)');
    });

    it('multiple payload fields are sorted alphabetically inside the parens', () => {
      const summary = summarizeContract({
        actionSpec: {
          submitForm: {
            label: 'Submit',
            schema: {
              type: 'object',
              properties: {
                rating: { type: 'number' },
                comment: { type: 'string' },
                anonymous: { type: 'boolean' },
              },
            },
          },
        },
      });
      expect(summary).toContain(
        'actions=submitForm(anonymous,comment,rating)',
      );
    });

    it('payload-less and payload-bearing produce DIFFERENT summaries', () => {
      const payloadLess = summarizeContract({
        actionSpec: {
          send: {
            label: 'Send',
            schema: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
          },
        },
      });
      const withPayload = summarizeContract({
        actionSpec: {
          send: {
            label: 'Send',
            schema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
        },
      });
      expect(payloadLess).not.toBe(withPayload);
      expect(payloadLess).toContain('actions=send;');
      expect(withPayload).toContain('actions=send(text);');
    });

    it('mixes payload-less and payload-bearing in one actionSpec', () => {
      const summary = summarizeContract({
        actionSpec: {
          increment: { label: 'Increment' },
          setValue: {
            label: 'Set',
            schema: {
              type: 'object',
              properties: { value: { type: 'number' } },
            },
          },
          reset: { label: 'Reset' },
        },
      });
      expect(summary).toContain('actions=increment,reset,setValue(value)');
    });
  });
});
