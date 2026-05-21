/**
 * Unit tests for the zod → JsonSchema wrapper. Pins the expected
 * normalized shape for every zod construct the
 * {@link isSchemaSubset} algorithm needs to consume at the push-time
 * + blueprint-registration check points.
 *
 * Covers both the `ZodType` and `ZodRawShape` input modes — handlers
 * in `@ggui-ai/mcp-server-handlers` ship `inputSchema` as a
 * ZodRawShape, so the wrapping-in-`z.object` branch is the primary
 * call path.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchema } from '../zod-to-json-schema.js';

describe('zodToJsonSchema — primitives', () => {
  it('string', () => {
    expect(zodToJsonSchema(z.string())).toEqual({ type: 'string' });
  });

  it('number', () => {
    expect(zodToJsonSchema(z.number())).toEqual({ type: 'number' });
  });

  it('boolean', () => {
    expect(zodToJsonSchema(z.boolean())).toEqual({ type: 'boolean' });
  });

  it('z.any() produces an empty schema (unconstrained)', () => {
    expect(zodToJsonSchema(z.any())).toEqual({});
  });

  it('z.unknown() produces an empty schema', () => {
    expect(zodToJsonSchema(z.unknown())).toEqual({});
  });
});

describe('zodToJsonSchema — objects', () => {
  it('object with required + optional fields', () => {
    const result = zodToJsonSchema(
      z.object({
        name: z.string(),
        age: z.number().optional(),
      }),
    );
    expect(result).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
      required: ['name'],
      additionalProperties: false,
    });
  });

  it('nested objects recurse correctly', () => {
    const result = zodToJsonSchema(
      z.object({
        user: z.object({ id: z.string(), name: z.string() }),
      }),
    );
    expect(result).toEqual({
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
          },
          required: ['id', 'name'],
          additionalProperties: false,
        },
      },
      required: ['user'],
      additionalProperties: false,
    });
  });

  it('passthrough emits additionalProperties: {} (structured-but-unconstrained)', () => {
    const result = zodToJsonSchema(
      z.object({ x: z.string() }).passthrough(),
    );
    expect(result).toEqual({
      type: 'object',
      properties: { x: { type: 'string' } },
      required: ['x'],
      additionalProperties: {},
    });
  });
});

describe('zodToJsonSchema — arrays', () => {
  it('array of strings', () => {
    expect(zodToJsonSchema(z.array(z.string()))).toEqual({
      type: 'array',
      items: { type: 'string' },
    });
  });

  it('array of objects', () => {
    expect(
      zodToJsonSchema(
        z.array(z.object({ id: z.string() })),
      ),
    ).toEqual({
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
    });
  });
});

describe('zodToJsonSchema — unions / enums / literals', () => {
  it('enum produces type: string + enum', () => {
    const result = zodToJsonSchema(z.enum(['a', 'b']));
    expect(result).toEqual({
      type: 'string',
      enum: ['a', 'b'],
    });
  });

  it('literal produces type: string + const', () => {
    const result = zodToJsonSchema(z.literal('x'));
    expect(result).toEqual({
      type: 'string',
      const: 'x',
    });
  });

  it('union produces anyOf', () => {
    const result = zodToJsonSchema(
      z.union([z.string(), z.number()]),
    );
    expect(result).toEqual({
      anyOf: [{ type: 'string' }, { type: 'number' }],
    });
  });

  it('nullable produces anyOf with null', () => {
    const result = zodToJsonSchema(z.string().nullable());
    expect(result).toEqual({
      anyOf: [{ type: 'string' }, { type: 'null' }],
    });
  });
});

describe('zodToJsonSchema — raw shape input', () => {
  it('wraps a ZodRawShape in z.object and converts', () => {
    const rawShape = {
      taskId: z.string(),
      priority: z.enum(['low', 'med', 'high']).optional(),
    };
    const result = zodToJsonSchema(rawShape);
    expect(result).toEqual({
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'med', 'high'] },
      },
      required: ['taskId'],
      additionalProperties: false,
    });
  });

  it('empty raw shape produces an empty-object schema', () => {
    const result = zodToJsonSchema({} as Record<string, z.ZodType>);
    expect(result).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });
});

describe('zodToJsonSchema — normalization', () => {
  it('strips top-level $schema', () => {
    const result = zodToJsonSchema(z.string());
    expect(result).not.toHaveProperty('$schema');
  });

  it('strips nested $schema (does not appear in nested constructs)', () => {
    // zod doesn't emit nested $schema, but the normalizer strips at
    // every level — confirm by constructing a deep tree.
    const result = zodToJsonSchema(
      z.object({ a: z.object({ b: z.string() }) }),
    );
    expect(JSON.stringify(result)).not.toContain('$schema');
  });
});

describe('zodToJsonSchema — integration with subset algorithm', () => {
  it('converted schemas participate in compatible pairs', async () => {
    // Use dynamic import so the test doesn't build a hard link in
    // the test file tree — keeps file co-location honest.
    const { isSchemaSubset } = await import('../schema-subset.js');

    // Superset: {taskId: string, priority?: enum[low,med,high]}
    // Subset: {taskId: string}
    // subset ⊆ superset ⇒ compatible (subset's value always fits
    // superset, which additionally accepts an optional priority).
    const supersetShape = {
      taskId: z.string(),
      priority: z.enum(['low', 'med', 'high']).optional(),
    };
    const subsetShape = {
      taskId: z.string(),
    };
    const superset = zodToJsonSchema(supersetShape);
    const subset = zodToJsonSchema(subsetShape);
    // Both sides carry `additionalProperties: false` from zod.
    // The subset algorithm flags enum as unsupported (P1 scope),
    // but the superset's enum lives on `priority` which is NOT on
    // the subset — so the enum node is never reached during the
    // recursive walk, and the result is compatible.
    const result = isSchemaSubset(superset, subset);
    expect(result.compatible).toBe(true);
  });

  it('converted schemas surface incompatibility with named violation', async () => {
    const { isSchemaSubset } = await import('../schema-subset.js');
    // Superset: {taskId: string, priority?: string}
    // Subset: {taskId: string, extra: boolean}
    // Subset adds a property the superset does not allow (zod's
    // additionalProperties: false).
    const superset = zodToJsonSchema({
      taskId: z.string(),
      priority: z.string().optional(),
    });
    const subset = zodToJsonSchema({
      taskId: z.string(),
      extra: z.boolean(),
    });
    const result = isSchemaSubset(superset, subset);
    expect(result.compatible).toBe(false);
    expect(
      result.violations.some(
        (v) => v.reason === 'extra-property' && v.path.includes('extra'),
      ),
    ).toBe(true);
  });
});
