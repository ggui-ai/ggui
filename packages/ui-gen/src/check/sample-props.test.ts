import { describe, expect, it } from 'vitest';
import { generateSampleProps } from './sample-props.js';
import { generateSampleProps as fromCheck } from './index.js';

describe('generateSampleProps (ggui#1386 — the one synthesizer, exported from @ggui-ai/ui-gen/check)', () => {
  it('is the same function on the check entry as in its module', () => {
    expect(fromCheck).toBe(generateSampleProps);
  });

  it('precedence per prop: example, then default, then a type-driven fill', () => {
    const props = generateSampleProps({
      properties: {
        title: { schema: { type: 'string' }, example: 'Motion check', default: 'unused' },
        note: { schema: { type: 'string' }, default: 'A note' },
        count: { schema: { type: 'integer' } },
        on: { schema: { type: 'boolean' } },
        tags: { schema: { type: 'array', items: { type: 'string' } } },
        who: { schema: { type: 'object', properties: { name: { type: 'string' }, age: { type: 'number' } } } },
        maybe: { schema: { type: ['string', 'null'] } },
      },
    });
    expect(props).toEqual({
      title: 'Motion check',
      note: 'A note',
      count: 0,
      on: false,
      tags: ['sample'],
      who: { name: 'sample', age: 0 },
      maybe: 'sample',
    });
  });

  it('an unknown schema type synthesizes undefined for that prop, never throws', () => {
    expect(generateSampleProps({ properties: { x: { schema: {} } } })).toEqual({ x: undefined });
  });
});
