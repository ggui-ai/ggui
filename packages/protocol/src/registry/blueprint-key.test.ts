import { describe, it, expect } from 'vitest';
import { blueprintKey } from './blueprint-key.js';
import type { DataContract } from '../types/data-contract.js';

describe('blueprintKey', () => {
  it('returns a 16-char lowercase hex string', () => {
    const key = blueprintKey({ contextSpec: { x: { schema: { type: 'string' } } } });
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });

  it('produces the same key for paraphrased-but-equivalent contract', () => {
    const a: DataContract = {
      contextSpec: {
        topic: {
          schema: { type: 'string' },
          default: 'Bug',
          description: 'topic of the note',
        },
        noteText: {
          schema: { type: 'string' },
          default: '',
          description: 'live mirror of the textarea',
        },
      },
    };
    const b: DataContract = {
      contextSpec: {
        // Different key order
        noteText: { schema: { type: 'string' }, default: '' },
        // Different description, different field order, no description on topic
        topic: { default: 'Bug', schema: { type: 'string' } },
      },
    };
    expect(blueprintKey(a)).toBe(blueprintKey(b));
  });

  it('produces different keys when defaults differ (load-bearing)', () => {
    const jan: DataContract = {
      propsSpec: {
        properties: { month: { schema: { type: 'string' }, default: 'Jan' } },
      },
    };
    const mar: DataContract = {
      propsSpec: {
        properties: { month: { schema: { type: 'string' }, default: 'Mar' } },
      },
    };
    expect(blueprintKey(jan)).not.toBe(blueprintKey(mar));
  });

  it('produces different keys when slot names differ', () => {
    const a: DataContract = {
      contextSpec: { noteText: { schema: { type: 'string' } } },
    };
    const b: DataContract = {
      contextSpec: { text: { schema: { type: 'string' } } },
    };
    expect(blueprintKey(a)).not.toBe(blueprintKey(b));
  });

  it('empty / undefined / {} produce the same stable sentinel key', () => {
    const empty = blueprintKey(undefined);
    expect(blueprintKey({})).toBe(empty);
    expect(empty).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is stable across runs (deterministic over the canonicalization)', () => {
    const contract: DataContract = {
      actionSpec: { submit: { label: 'Submit' } },
      contextSpec: { text: { schema: { type: 'string' }, default: '' } },
    };
    const k1 = blueprintKey(contract);
    const k2 = blueprintKey(contract);
    const k3 = blueprintKey({ ...contract });
    expect(k1).toBe(k2);
    expect(k1).toBe(k3);
  });
});
