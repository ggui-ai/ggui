/**
 * Unit tests for the synthesizer's JSON Schema `type` normalizer.
 *
 * Pins the deterministic repair of the enumerable invalid-`type`
 * spellings an LLM emits — the layer that eliminates the dominant
 * synth-decline class before the validation gate ever sees it.
 */
import { describe, it, expect } from 'vitest';
import { normalizeSchema } from './normalize-schema.js';

describe('normalizeSchema — valid schemas pass through unchanged', () => {
  it('leaves a valid object schema untouched', () => {
    const valid = {
      type: 'object',
      properties: { name: { type: 'string' }, age: { type: 'integer' } },
      required: ['name'],
    };
    expect(normalizeSchema(valid)).toEqual(valid);
  });

  it('leaves a valid array schema untouched', () => {
    const valid = { type: 'array', items: { type: 'number' } };
    expect(normalizeSchema(valid)).toEqual(valid);
  });

  it('passes non-object input (booleans, primitives) through', () => {
    expect(normalizeSchema(false)).toBe(false);
    expect(normalizeSchema(true)).toBe(true);
    expect(normalizeSchema('x')).toBe('x');
    expect(normalizeSchema(null)).toBe(null);
    expect(normalizeSchema(42)).toBe(42);
  });
});

describe('normalizeSchema — invalid type spellings', () => {
  it('maps type:"enum" with a string enum to type:"string"', () => {
    expect(
      normalizeSchema({ type: 'enum', enum: ['waiting', 'playing', 'done'] }),
    ).toEqual({ type: 'string', enum: ['waiting', 'playing', 'done'] });
  });

  it('maps type:"enum" with a numeric enum to type:"number"', () => {
    expect(normalizeSchema({ type: 'enum', enum: [1, 2, 3] })).toEqual({
      type: 'number',
      enum: [1, 2, 3],
    });
  });

  it('maps type:"enum" with no enum sibling to type:"string"', () => {
    expect(normalizeSchema({ type: 'enum' })).toEqual({ type: 'string' });
  });

  it('maps common aliases to canonical primitives', () => {
    expect(normalizeSchema({ type: 'list' })).toEqual({ type: 'array' });
    expect(normalizeSchema({ type: 'dict' })).toEqual({ type: 'object' });
    expect(normalizeSchema({ type: 'int' })).toEqual({ type: 'integer' });
    expect(normalizeSchema({ type: 'str' })).toEqual({ type: 'string' });
    expect(normalizeSchema({ type: 'bool' })).toEqual({ type: 'boolean' });
    expect(normalizeSchema({ type: 'float' })).toEqual({ type: 'number' });
    expect(normalizeSchema({ type: 'tuple' })).toEqual({ type: 'array' });
  });

  it('canonicalizes capitalized types', () => {
    expect(normalizeSchema({ type: 'String' })).toEqual({ type: 'string' });
    expect(normalizeSchema({ type: 'OBJECT' })).toEqual({ type: 'object' });
  });

  it('collapses a union type array to its first valid non-null member', () => {
    expect(normalizeSchema({ type: ['string', 'null'] })).toEqual({
      type: 'string',
    });
    expect(normalizeSchema({ type: ['null', 'number'] })).toEqual({
      type: 'number',
    });
  });

  it('collapses a pipe-union type STRING to its first valid non-null member', () => {
    // Gemini emits the union as a single pipe-string, e.g. "STRING|null",
    // rather than the JSON Schema array form. Recover the first valid
    // non-null member (case-insensitive), dropping the nullable arm.
    expect(normalizeSchema({ type: 'STRING|null' })).toEqual({
      type: 'string',
    });
    expect(normalizeSchema({ type: 'null|number' })).toEqual({
      type: 'number',
    });
    // Aliases inside the pipe-union normalize too.
    expect(normalizeSchema({ type: 'int|null' })).toEqual({
      type: 'integer',
    });
  });

  it('canonicalizes a nested pipe-union under a capitalized object type', () => {
    expect(
      normalizeSchema({
        type: 'OBJECT',
        properties: { text: { type: 'STRING|null' } },
      }),
    ).toEqual({
      type: 'object',
      properties: { text: { type: 'string' } },
    });
  });

  it('drops the type key for no-constraint words (any/unknown/mixed)', () => {
    expect(normalizeSchema({ type: 'any', description: 'x' })).toEqual({
      description: 'x',
    });
    expect(normalizeSchema({ type: 'unknown' })).toEqual({});
    expect(normalizeSchema({ type: 'mixed' })).toEqual({});
  });

  it('drops an unrecognized garbage type', () => {
    expect(normalizeSchema({ type: 'leaderboard' })).toEqual({});
    expect(normalizeSchema({ type: 42 })).toEqual({});
  });
});

describe('normalizeSchema — recursion into sub-schema positions', () => {
  it('fixes invalid types nested in properties', () => {
    expect(
      normalizeSchema({
        type: 'object',
        properties: {
          tags: { type: 'list' },
          status: { type: 'enum', enum: ['on', 'off'] },
        },
      }),
    ).toEqual({
      type: 'object',
      properties: {
        tags: { type: 'array' },
        status: { type: 'string', enum: ['on', 'off'] },
      },
    });
  });

  it('fixes invalid types nested in items', () => {
    expect(
      normalizeSchema({ type: 'array', items: { type: 'dict' } }),
    ).toEqual({ type: 'array', items: { type: 'object' } });
  });

  it('fixes invalid types nested in anyOf', () => {
    expect(
      normalizeSchema({ anyOf: [{ type: 'str' }, { type: 'int' }] }),
    ).toEqual({ anyOf: [{ type: 'string' }, { type: 'integer' }] });
  });

  it('does NOT rewrite a type inside a data-value position (default)', () => {
    // `default` is user data — a default value of {type:"list"} is a
    // literal object the field holds, not a schema. It must survive
    // verbatim.
    expect(
      normalizeSchema({
        type: 'object',
        properties: { cfg: { type: 'string' } },
        default: { type: 'list', other: 1 },
      }),
    ).toEqual({
      type: 'object',
      properties: { cfg: { type: 'string' } },
      default: { type: 'list', other: 1 },
    });
  });

  it('leaves additionalProperties:false intact', () => {
    expect(
      normalizeSchema({
        type: 'object',
        properties: {},
        additionalProperties: false,
      }),
    ).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });
});

describe('normalizeSchema — string-shorthand expansion', () => {
  it('expands a string items shorthand to a schema object', () => {
    expect(
      normalizeSchema({ type: 'array', items: 'number' }),
    ).toEqual({ type: 'array', items: { type: 'number' } });
  });

  it('expands a string items shorthand through an alias', () => {
    expect(normalizeSchema({ type: 'array', items: 'int' })).toEqual({
      type: 'array',
      items: { type: 'integer' },
    });
  });

  it('expands a doubly-nested array-of-array items shorthand', () => {
    // "a route as a list of [lat, lng] pairs" — the leaflet failure.
    expect(
      normalizeSchema({
        type: 'array',
        items: { type: 'array', items: 'number' },
      }),
    ).toEqual({
      type: 'array',
      items: { type: 'array', items: { type: 'number' } },
    });
  });

  it('expands a string property shorthand to a schema object', () => {
    expect(
      normalizeSchema({ type: 'object', properties: { count: 'int' } }),
    ).toEqual({
      type: 'object',
      properties: { count: { type: 'integer' } },
    });
  });

  it('expands an unrecognized string shorthand to the unconstrained schema', () => {
    expect(normalizeSchema({ type: 'array', items: 'whatever' })).toEqual({
      type: 'array',
      items: {},
    });
  });
});
