/**
 * Unit tests for the subset algorithm. Table-driven per P0 case — one
 * table per construct (type match, required, properties recursion,
 * items recursion, additionalProperties) with both positive (compat)
 * and negative (incompat) rows.
 *
 * Unsupported-construct flagging (oneOf/anyOf/enum/const/$ref/allOf)
 * is also covered so the "deferred to P1/P2" boundary is explicit.
 */
import { describe, expect, it } from 'vitest';
import type { JsonSchema } from '../../types/data-contract.js';
import {
  isSchemaSubset,
  type SchemaSubsetResult,
  type SubsetViolation,
} from '../schema-subset.js';

// ── Helpers ───────────────────────────────────────────────────────

function expectCompatible(result: SchemaSubsetResult): void {
  if (!result.compatible) {
    throw new Error(
      `Expected compatible, got violations: ${JSON.stringify(result.violations, null, 2)}`,
    );
  }
}

function expectIncompatible(
  result: SchemaSubsetResult,
  pred?: (violations: readonly SubsetViolation[]) => boolean,
): void {
  expect(result.compatible).toBe(false);
  expect(result.violations.length).toBeGreaterThan(0);
  if (pred) {
    expect(pred(result.violations)).toBe(true);
  }
}

// ── Type match ────────────────────────────────────────────────────

describe('isSchemaSubset — type match', () => {
  it('compat: exact type match (string)', () => {
    expectCompatible(
      isSchemaSubset({ type: 'string' }, { type: 'string' }),
    );
  });

  it('compat: exact type match (object with no properties)', () => {
    expectCompatible(
      isSchemaSubset({ type: 'object' }, { type: 'object' }),
    );
  });

  it('compat: superset omits type (wildcard)', () => {
    expectCompatible(isSchemaSubset({}, { type: 'string' }));
  });

  it('incompat: type mismatch (string vs number)', () => {
    expectIncompatible(
      isSchemaSubset({ type: 'string' }, { type: 'number' }),
      (v) => v.some((vv) => vv.reason === 'type-mismatch'),
    );
  });

  it('incompat: subset omits type when superset declares one', () => {
    expectIncompatible(
      isSchemaSubset({ type: 'string' }, {}),
      (v) => v.some((vv) => vv.reason === 'type-mismatch'),
    );
  });

  it('incompat: integer vs number treated as distinct', () => {
    expectIncompatible(
      isSchemaSubset({ type: 'integer' }, { type: 'number' }),
      (v) => v.some((vv) => vv.reason === 'type-mismatch'),
    );
  });
});

// ── Properties recursion ─────────────────────────────────────────

describe('isSchemaSubset — properties', () => {
  const person: JsonSchema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      age: { type: 'number' },
    },
    additionalProperties: false,
  };

  it('compat: subset with a proper subset of properties (additionalProperties: false on both)', () => {
    expectCompatible(
      isSchemaSubset(person, {
        type: 'object',
        properties: { name: { type: 'string' } },
        additionalProperties: false,
      }),
    );
  });

  it('compat: subset property schemas are themselves subsets', () => {
    const supersetNested: JsonSchema = {
      type: 'object',
      properties: { payload: { type: 'object' } },
    };
    const subsetNested: JsonSchema = {
      type: 'object',
      properties: {
        payload: {
          type: 'object',
          properties: { id: { type: 'string' } },
        },
      },
    };
    expectCompatible(isSchemaSubset(supersetNested, subsetNested));
  });

  it('incompat: subset declares a property the superset does not allow', () => {
    expectIncompatible(
      isSchemaSubset(person, {
        type: 'object',
        properties: {
          name: { type: 'string' },
          rogue: { type: 'string' },
        },
        additionalProperties: false,
      }),
      (v) =>
        v.some(
          (vv) =>
            vv.reason === 'extra-property' && vv.path.includes('rogue'),
        ),
    );
  });

  it('incompat: subset property schema violates superset property schema (type)', () => {
    expectIncompatible(
      isSchemaSubset(person, {
        type: 'object',
        properties: {
          name: { type: 'number' },
          age: { type: 'number' },
        },
      }),
      (v) =>
        v.some(
          (vv) =>
            vv.reason === 'type-mismatch' && vv.path.includes('name'),
        ),
    );
  });
});

// ── Required set ─────────────────────────────────────────────────

describe('isSchemaSubset — required', () => {
  it('compat: subset requires a superset-optional field (subset is stricter)', () => {
    const superset: JsonSchema = {
      type: 'object',
      properties: { x: { type: 'string' } },
    };
    const subset: JsonSchema = {
      type: 'object',
      properties: { x: { type: 'string' } },
      required: ['x'],
    };
    expectCompatible(isSchemaSubset(superset, subset));
  });

  it('incompat: superset requires a field the subset does not require', () => {
    const superset: JsonSchema = {
      type: 'object',
      properties: { x: { type: 'string' } },
      required: ['x'],
    };
    const subset: JsonSchema = {
      type: 'object',
      properties: { x: { type: 'string' } },
    };
    expectIncompatible(
      isSchemaSubset(superset, subset),
      (v) => v.some((vv) => vv.reason === 'missing-required'),
    );
  });

  it('compat: exact required parity', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      required: ['a'],
    };
    expectCompatible(isSchemaSubset(schema, schema));
  });
});

// ── additionalProperties semantics ────────────────────────────────

describe('isSchemaSubset — additionalProperties', () => {
  it('compat: superset true (default), subset false — subset is strictly narrower on extras', () => {
    expectCompatible(
      isSchemaSubset(
        { type: 'object' }, // default: true
        { type: 'object', additionalProperties: false },
      ),
    );
  });

  it('compat: superset true (explicit), subset true', () => {
    expectCompatible(
      isSchemaSubset(
        { type: 'object', additionalProperties: true },
        { type: 'object', additionalProperties: true },
      ),
    );
  });

  it('compat: superset schema, subset false', () => {
    expectCompatible(
      isSchemaSubset(
        { type: 'object', additionalProperties: { type: 'string' } },
        { type: 'object', additionalProperties: false },
      ),
    );
  });

  it('incompat: superset false, subset true (widening)', () => {
    expectIncompatible(
      isSchemaSubset(
        { type: 'object', additionalProperties: false },
        { type: 'object', additionalProperties: true },
      ),
      (v) => v.some((vv) => vv.reason === 'additional-properties-widens'),
    );
  });

  it('incompat: superset false, subset schema (any non-false widens)', () => {
    expectIncompatible(
      isSchemaSubset(
        { type: 'object', additionalProperties: false },
        { type: 'object', additionalProperties: { type: 'string' } },
      ),
      (v) => v.some((vv) => vv.reason === 'additional-properties-widens'),
    );
  });

  it('incompat: superset schema, subset true (unconstrained widens)', () => {
    expectIncompatible(
      isSchemaSubset(
        { type: 'object', additionalProperties: { type: 'string' } },
        { type: 'object', additionalProperties: true },
      ),
      (v) => v.some((vv) => vv.reason === 'additional-properties-widens'),
    );
  });

  it('compat: both constrain additionalProperties, subset fits inside superset', () => {
    expectCompatible(
      isSchemaSubset(
        { type: 'object', additionalProperties: { type: 'object' } },
        {
          type: 'object',
          additionalProperties: { type: 'object', properties: { x: { type: 'string' } } },
        },
      ),
    );
  });

  it('incompat: both constrain additionalProperties, subset type does not match superset', () => {
    expectIncompatible(
      isSchemaSubset(
        { type: 'object', additionalProperties: { type: 'string' } },
        { type: 'object', additionalProperties: { type: 'number' } },
      ),
      (v) =>
        v.some(
          (vv) =>
            vv.reason === 'type-mismatch' &&
            vv.path.includes('additionalProperties'),
        ),
    );
  });

  it('compat: superset explicitly allows additional (schema), subset declares a property matching that schema and rejects other extras', () => {
    // Subset must explicitly constrain its OWN extras — default
    // `additionalProperties: true` on the subset would widen past the
    // superset's schema-constrained extras.
    expectCompatible(
      isSchemaSubset(
        { type: 'object', additionalProperties: { type: 'string' } },
        {
          type: 'object',
          properties: { tag: { type: 'string' } },
          additionalProperties: false,
        },
      ),
    );
  });
});

// ── items recursion (arrays) ──────────────────────────────────────

describe('isSchemaSubset — items', () => {
  it('compat: exact items match', () => {
    expectCompatible(
      isSchemaSubset(
        { type: 'array', items: { type: 'string' } },
        { type: 'array', items: { type: 'string' } },
      ),
    );
  });

  it('compat: subset items is narrower (adds required field)', () => {
    expectCompatible(
      isSchemaSubset(
        { type: 'array', items: { type: 'object' } },
        {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
          },
        },
      ),
    );
  });

  it('incompat: items type mismatch', () => {
    expectIncompatible(
      isSchemaSubset(
        { type: 'array', items: { type: 'string' } },
        { type: 'array', items: { type: 'number' } },
      ),
      (v) =>
        v.some(
          (vv) =>
            vv.reason === 'type-mismatch' &&
            vv.path.endsWith('items'),
        ),
    );
  });

  it('compat (permissive): superset omits items', () => {
    expectCompatible(
      isSchemaSubset(
        { type: 'array' },
        { type: 'array', items: { type: 'string' } },
      ),
    );
  });

  it('compat (permissive): subset omits items', () => {
    expectCompatible(
      isSchemaSubset(
        { type: 'array', items: { type: 'string' } },
        { type: 'array' },
      ),
    );
  });
});

// ── P1/P2 unsupported constructs ──────────────────────────────────

describe('isSchemaSubset — unsupported constructs (P1/P2)', () => {
  it('flags oneOf on either side as unsupported', () => {
    expectIncompatible(
      isSchemaSubset(
        { type: 'string' },
        { oneOf: [{ type: 'string' }, { type: 'number' }] },
      ),
      (v) => v.some((vv) => vv.reason === 'unsupported'),
    );
  });

  it('flags anyOf on superset as unsupported', () => {
    expectIncompatible(
      isSchemaSubset(
        { anyOf: [{ type: 'string' }, { type: 'number' }] },
        { type: 'string' },
      ),
      (v) => v.some((vv) => vv.reason === 'unsupported'),
    );
  });

  it('flags enum as unsupported', () => {
    expectIncompatible(
      isSchemaSubset(
        { type: 'string', enum: ['a', 'b'] },
        { type: 'string', enum: ['a'] },
      ),
      (v) => v.some((vv) => vv.reason === 'unsupported'),
    );
  });

  it('flags const as unsupported when the two sides differ', () => {
    expectIncompatible(
      isSchemaSubset(
        { const: 'x' },
        { const: 'y' },
      ),
      (v) => v.some((vv) => vv.reason === 'unsupported'),
    );
  });

  it('treats IDENTICAL schemas as compatible even with an unsupported construct', () => {
    // A schema is trivially a subset of itself — the deep-equal
    // short-circuit proves compatibility without needing P1/P2 support
    // for the construct. This is the path a source-fed streamSpec
    // channel relies on (channel.schema === tool.outputSchema).
    expectCompatible(isSchemaSubset({ const: 'x' }, { const: 'x' }));
    expectCompatible(
      isSchemaSubset(
        { type: 'string', enum: ['a', 'b', 'c'] },
        { type: 'string', enum: ['a', 'b', 'c'] },
      ),
    );
    expectCompatible(
      isSchemaSubset(
        {
          type: 'array',
          items: {
            type: 'object',
            properties: { status: { type: 'string', enum: ['on', 'off'] } },
          },
        },
        {
          type: 'array',
          items: {
            type: 'object',
            properties: { status: { type: 'string', enum: ['on', 'off'] } },
          },
        },
      ),
    );
  });

  it('flags $ref as unsupported', () => {
    // $ref isn't in the JsonSchema type but may appear in zod-converted
    // output or hand-authored schemas; the algorithm catches it via
    // raw property lookup.
    const supersetWithRef = {
      $ref: '#/definitions/Foo',
    } as unknown as JsonSchema;
    expectIncompatible(
      isSchemaSubset(supersetWithRef, { type: 'string' }),
      (v) => v.some((vv) => vv.reason === 'unsupported'),
    );
  });

  it('flags allOf as unsupported', () => {
    const supersetWithAllOf = {
      allOf: [{ type: 'object' }, { type: 'object' }],
    } as unknown as JsonSchema;
    expectIncompatible(
      isSchemaSubset(supersetWithAllOf, { type: 'object' }),
      (v) => v.some((vv) => vv.reason === 'unsupported'),
    );
  });
});

// ── Error-path contract ───────────────────────────────────────────

describe('isSchemaSubset — error-path contract', () => {
  it('throws on null superset (programmer bug, not a violation)', () => {
    expect(() =>
      isSchemaSubset(null as unknown as JsonSchema, { type: 'string' }),
    ).toThrow(TypeError);
  });

  it('throws on null subset (programmer bug)', () => {
    expect(() =>
      isSchemaSubset({ type: 'string' }, null as unknown as JsonSchema),
    ).toThrow(TypeError);
  });

  it('never throws on legitimate incompatibilities (everything as violations)', () => {
    // A deeply nested, deliberately broken pair should still return
    // `{compatible: false}` without throwing.
    const superset: JsonSchema = {
      type: 'object',
      properties: {
        a: {
          type: 'object',
          properties: {
            b: { type: 'array', items: { type: 'string' } },
          },
          required: ['b'],
        },
      },
      required: ['a'],
      additionalProperties: false,
    };
    const subset: JsonSchema = {
      type: 'object',
      properties: {
        a: {
          type: 'object',
          properties: {
            b: { type: 'array', items: { type: 'number' } },
          },
        },
        extra: { type: 'boolean' },
      },
    };
    const result = isSchemaSubset(superset, subset);
    expect(result.compatible).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Violation payload shape ───────────────────────────────────────

describe('SubsetViolation shape', () => {
  it('carries path + reason + message + both sides on a type mismatch', () => {
    const result = isSchemaSubset(
      { type: 'string' },
      { type: 'number' },
    );
    expect(result.compatible).toBe(false);
    const v = result.violations[0];
    expect(v).toBeDefined();
    expect(v?.reason).toBe('type-mismatch');
    expect(v?.superset).toBe('string');
    expect(v?.subset).toBe('number');
    expect(v?.message).toContain('type mismatch');
  });

  it('uses dotted path for nested violations', () => {
    const result = isSchemaSubset(
      {
        type: 'object',
        properties: { inner: { type: 'string' } },
      },
      {
        type: 'object',
        properties: { inner: { type: 'number' } },
      },
    );
    expect(result.compatible).toBe(false);
    const v = result.violations[0];
    expect(v?.path).toContain('properties.inner');
  });
});
