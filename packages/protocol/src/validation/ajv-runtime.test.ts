import { describe, expect, it } from 'vitest';
import {
  injectClosedShape,
  compileForValidation,
  compileValidatorModule,
  mapAjvErrorsToViolations,
} from './ajv-runtime';
import type { JsonSchema } from '../types/data-contract';

describe('compileValidatorModule', () => {
  it('emits an ESM module that default-exports a working validator', async () => {
    const src = compileValidatorModule({
      type: 'object',
      additionalProperties: false,
      properties: { count: { type: 'integer', minimum: 0 } },
    });
    expect(src).toMatch(/export default/);
    // No `require(` — Ajv's CJS helper refs are rewritten to ESM imports
    // so the module loads under the renderer iframe's strict CSP.
    expect(src).not.toMatch(/\brequire\(/);
    // The emitted module runs as a real ES module + enforces the schema.
    const mod = (await import(
      `data:text/javascript;base64,${Buffer.from(src).toString('base64')}`
    )) as { default: (d: unknown) => boolean };
    expect(mod.default({ count: 2 })).toBe(true);
    expect(mod.default({ count: -1 })).toBe(false);
    expect(mod.default({ count: 0, extra: 1 })).toBe(false);
  });

  it('inlines the `ucs2length` runtime helper (minLength) — module is self-contained', async () => {
    // `minLength` pulls in `ajv/dist/runtime/ucs2length`. The emitted
    // module must inline it — no bare-specifier import the CSP iframe
    // cannot resolve.
    const src = compileValidatorModule({
      type: 'object',
      properties: { title: { type: 'string', minLength: 3 } },
    });
    expect(src).not.toMatch(/\brequire\(/);
    expect(src).not.toMatch(/import\s+\w+\s+from\s+"ajv\/dist\/runtime\//);
    const mod = (await import(
      `data:text/javascript;base64,${Buffer.from(src).toString('base64')}`
    )) as { default: (d: unknown) => boolean };
    expect(mod.default({ title: 'abc' })).toBe(true);
    expect(mod.default({ title: 'ab' })).toBe(false);
  });

  it('inlines the `equal` runtime helper (uniqueItems) — module is self-contained', async () => {
    // `uniqueItems` on an array of objects pulls in
    // `ajv/dist/runtime/equal` (fast-deep-equal). Must be inlined too.
    const src = compileValidatorModule({
      type: 'array',
      items: { type: 'object', properties: { x: { type: 'number' } } },
      uniqueItems: true,
    });
    expect(src).not.toMatch(/\brequire\(/);
    expect(src).not.toMatch(/import\s+\w+\s+from\s+"ajv\/dist\/runtime\//);
    const mod = (await import(
      `data:text/javascript;base64,${Buffer.from(src).toString('base64')}`
    )) as { default: (d: unknown) => boolean };
    expect(mod.default([{ x: 1 }, { x: 2 }])).toBe(true);
    expect(mod.default([{ x: 1 }, { x: 1 }])).toBe(false);
  });

  it('throws on a malformed schema (layer-B meta-validation)', () => {
    expect(() =>
      compileValidatorModule({ type: 'not-a-real-type' } as unknown as JsonSchema),
    ).toThrow();
  });
});

describe('injectClosedShape', () => {
  it('injects additionalProperties: false at top-level object', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { id: { type: 'string' } },
    };
    const out = injectClosedShape(schema);
    expect(out.additionalProperties).toBe(false);
  });

  it('preserves explicitly-set additionalProperties: true (author escape hatch)', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { id: { type: 'string' } },
      additionalProperties: true,
    };
    const out = injectClosedShape(schema);
    expect(out.additionalProperties).toBe(true);
  });

  it('preserves explicitly-set additionalProperties: <schema> and recurses into it', () => {
    const schema: JsonSchema = {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: { nested: { type: 'string' } },
      },
    };
    const out = injectClosedShape(schema);
    const ap = out.additionalProperties;
    expect(typeof ap).toBe('object');
    if (typeof ap === 'object') {
      expect(ap.additionalProperties).toBe(false);
    }
  });

  it('recurses into nested object properties', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: { name: { type: 'string' } },
        },
      },
    };
    const out = injectClosedShape(schema);
    expect(out.additionalProperties).toBe(false);
    expect(out.properties?.user?.additionalProperties).toBe(false);
  });

  it('recurses into array items', () => {
    const schema: JsonSchema = {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' } },
      },
    };
    const out = injectClosedShape(schema);
    expect(out.items?.additionalProperties).toBe(false);
  });

  it('recurses into deeply nested array items', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              meta: {
                type: 'object',
                properties: { tags: { type: 'array', items: { type: 'string' } } },
              },
            },
          },
        },
      },
    };
    const out = injectClosedShape(schema);
    expect(out.additionalProperties).toBe(false);
    expect(out.properties?.todos?.items?.additionalProperties).toBe(false);
    expect(
      out.properties?.todos?.items?.properties?.meta?.additionalProperties,
    ).toBe(false);
  });

  it('recurses into oneOf / anyOf branches', () => {
    const schema: JsonSchema = {
      oneOf: [
        { type: 'object', properties: { a: { type: 'string' } } },
        { type: 'object', properties: { b: { type: 'number' } } },
      ],
    };
    const out = injectClosedShape(schema);
    expect(out.oneOf?.[0].additionalProperties).toBe(false);
    expect(out.oneOf?.[1].additionalProperties).toBe(false);
  });

  it('does not mutate input', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { id: { type: 'string' } },
    };
    const before = JSON.stringify(schema);
    injectClosedShape(schema);
    expect(JSON.stringify(schema)).toBe(before);
    expect(schema.additionalProperties).toBeUndefined();
  });

  it('leaves primitive schemas unchanged', () => {
    const schema: JsonSchema = { type: 'string', enum: ['a', 'b'] };
    const out = injectClosedShape(schema);
    expect(out).toEqual(schema);
  });
});

describe('compileForValidation', () => {
  it('returns a validator that accepts well-shaped data', () => {
    const validate = compileForValidation({
      type: 'object',
      properties: {
        id: { type: 'string' },
        count: { type: 'number' },
      },
      required: ['id'],
    });
    expect(validate({ id: 'a', count: 1 })).toBe(true);
  });

  it('rejects data with undeclared key (closed-shape)', () => {
    const validate = compileForValidation({
      type: 'object',
      properties: { id: { type: 'string' } },
    });
    expect(validate({ id: 'a', extra: 1 })).toBe(false);
    expect(validate.errors?.[0].keyword).toBe('additionalProperties');
  });

  it('rejects deeply-nested undeclared key (the done/completed class)', () => {
    const validate = compileForValidation({
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: { title: { type: 'string' }, completed: { type: 'boolean' } },
          },
        },
      },
    });
    expect(validate({ todos: [{ title: 'a', done: true }] })).toBe(false);
    const errs = validate.errors ?? [];
    const violation = errs.find(e => e.keyword === 'additionalProperties');
    expect(violation).toBeDefined();
    expect(violation?.instancePath).toBe('/todos/0');
    expect((violation?.params as { additionalProperty?: string }).additionalProperty).toBe('done');
  });

  it('tolerates `example` and `nullable` keywords (Ajv strict mode would otherwise reject)', () => {
    const validate = compileForValidation({
      type: 'object',
      properties: {
        id: { type: 'string', example: 'foo', nullable: true },
      },
    });
    expect(validate({ id: 'a' })).toBe(true);
  });

  it('compiles non-object root schemas (string + enum)', () => {
    const validate = compileForValidation({ type: 'string', enum: ['red', 'blue'] });
    expect(validate('red')).toBe(true);
    expect(validate('green')).toBe(false);
  });

  it('throws on malformed JSON Schema (layer B side effect)', () => {
    expect(() =>
      compileForValidation({
        type: 'object',
        properties: {
          bad: { type: 'array' as never, items: 'not-a-schema' as unknown as JsonSchema },
        },
      }),
    ).toThrow();
  });
});

describe('mapAjvErrorsToViolations', () => {
  it('returns [] for null/undefined errors', () => {
    expect(mapAjvErrorsToViolations(null, {})).toEqual([]);
    expect(mapAjvErrorsToViolations(undefined, {})).toEqual([]);
  });

  it('maps additionalProperties with deep path', () => {
    const validate = compileForValidation({
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: { title: { type: 'string' } },
          },
        },
      },
    });
    const data = { todos: [{ title: 'a', done: true }] };
    validate(data);
    const violations = mapAjvErrorsToViolations(validate.errors, data);
    const extra = violations.find(v => v.message.includes('done'));
    expect(extra).toBeDefined();
    expect(extra?.field).toBe('todos[0].done');
    expect(extra?.expected).toBe('<declared key>');
  });

  it('maps required missing-property', () => {
    const validate = compileForValidation({
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    });
    const data = {};
    validate(data);
    const violations = mapAjvErrorsToViolations(validate.errors, data);
    const missing = violations.find(v => v.message.includes('Required'));
    expect(missing).toBeDefined();
    expect(missing?.field).toBe('id');
    expect(missing?.expected).toBe('present');
    expect(missing?.received).toBe('undefined');
  });

  it('maps type mismatch with received-type from data', () => {
    const validate = compileForValidation({
      type: 'object',
      properties: { count: { type: 'number' } },
    });
    const data = { count: 'not-a-number' };
    validate(data);
    const violations = mapAjvErrorsToViolations(validate.errors, data);
    const typeViolation = violations.find(v => v.expected === 'number');
    expect(typeViolation).toBeDefined();
    expect(typeViolation?.field).toBe('count');
    expect(typeViolation?.received).toBe('string');
  });

  it('maps enum mismatch', () => {
    const validate = compileForValidation({
      type: 'object',
      properties: { color: { type: 'string', enum: ['red', 'blue'] } },
    });
    const data = { color: 'green' };
    validate(data);
    const violations = mapAjvErrorsToViolations(validate.errors, data);
    const enumViolation = violations.find(v => v.expected?.includes('red'));
    expect(enumViolation).toBeDefined();
    expect(enumViolation?.field).toBe('color');
    expect(enumViolation?.received).toBe('"green"');
  });

  it('translates slash path to bracket-dot path', () => {
    const validate = compileForValidation({
      type: 'object',
      properties: {
        users: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              address: {
                type: 'object',
                properties: { zip: { type: 'string' } },
              },
            },
          },
        },
      },
    });
    const data = { users: [{ address: { zip: 123 } }] };
    validate(data);
    const violations = mapAjvErrorsToViolations(validate.errors, data);
    const v = violations.find(x => x.field === 'users[0].address.zip');
    expect(v).toBeDefined();
  });
});
