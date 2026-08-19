/**
 * `buildEnforcedPropsSchema` + canonical serialization + grammar-safe
 * profile — Slice B (P1) of the schema-precise render plan
 * (docs/plans/2026-08-19-schema-precise-render.md).
 *
 * The AUTHORITY property under test: the schema this builder emits is
 * the EXACT schema `ggui_render` enforces — compiling the built schema
 * must accept/reject byte-identically to `validatePropsData` over the
 * same PropsSpec. Emission normalization (nullable → type union,
 * metadata keywords stripped) must preserve that equivalence.
 *
 * P3 review pins under test (frozen 2026-08-19, guuey#271):
 *   - pin 3: canonical construction — sorted keys at every depth,
 *     arrays order-preserving; byte-stable across author key order.
 *     Canonical bytes = RFC 8785 (JCS), the SAME standard contractHash
 *     already pins — any external JCS library reproduces them.
 *   - pin 4: profile is purely syntactic keyword membership; the
 *     enumerated core is closed.
 *   - pin 5: `format` is in-core restricted to ten values; out-of-list
 *     formats classify 'full'.
 */
import { describe, expect, it } from 'vitest';
import {
  buildEnforcedPropsSchema,
  canonicalPropsSchemaBytes,
  classifyPropsSchemaProfile,
} from './enforced-props-schema.js';
import { compileForValidation } from './ajv-runtime.js';
import { validatePropsData } from './contract-validator.js';
import type { PropsSpec } from '../types/data-contract.js';

const ENUM_SPEC: PropsSpec = {
  properties: {
    status: {
      schema: { type: 'string', enum: ['open', 'busy', 'tentative'] },
      required: true,
    },
  },
};

/** Assert the built schema and validatePropsData agree on `props`. */
function assertEquivalent(
  spec: PropsSpec,
  props: Record<string, unknown>,
): void {
  const enforced = compileForValidation(buildEnforcedPropsSchema(spec));
  const viaSchema = enforced(props);
  const viaSpec = validatePropsData(props, spec).valid;
  expect(viaSchema).toBe(viaSpec);
}

describe('buildEnforcedPropsSchema — authority equivalence', () => {
  it('agrees with validatePropsData on enum, required, and closed-shape cases', () => {
    assertEquivalent(ENUM_SPEC, { status: 'open' }); // valid
    assertEquivalent(ENUM_SPEC, { status: 'booked' }); // enum violation
    assertEquivalent(ENUM_SPEC, {}); // required violation
    assertEquivalent(ENUM_SPEC, { status: 'open', extra: 1 }); // closed shape
  });

  it('materializes closed shape in the bytes at every object depth', () => {
    const spec: PropsSpec = {
      properties: {
        slot: {
          schema: {
            type: 'object',
            properties: { label: { type: 'string' } },
          },
        },
      },
    };
    const built = buildEnforcedPropsSchema(spec);
    expect(built.additionalProperties).toBe(false);
    const slot = built.properties!.slot;
    expect(slot.additionalProperties).toBe(false);
  });

  it('normalizes nullable:true into the canonical type union and preserves null-acceptance', () => {
    const spec: PropsSpec = {
      properties: {
        note: { schema: { type: 'string', nullable: true } },
      },
    };
    const built = buildEnforcedPropsSchema(spec);
    const note = built.properties!.note;
    expect(note.type).toEqual(['string', 'null']);
    expect(JSON.stringify(built)).not.toContain('nullable');
    // Equivalence holds in both directions.
    assertEquivalent(spec, { note: null });
    assertEquivalent(spec, { note: 'x' });
    const strict: PropsSpec = {
      properties: { note: { schema: { type: 'string' } } },
    };
    assertEquivalent(strict, { note: null });
  });

  it('strips the example metadata keyword from the emitted bytes', () => {
    const spec: PropsSpec = {
      properties: {
        status: {
          schema: {
            type: 'string',
            enum: ['open', 'busy'],
            example: 'open',
          },
        },
      },
    };
    const built = buildEnforcedPropsSchema(spec);
    expect(JSON.stringify(built)).not.toContain('example');
    assertEquivalent(spec, { status: 'busy' });
  });

  it('emits the empty closed wrapper for an empty PropsSpec', () => {
    const built = buildEnforcedPropsSchema({ properties: {} });
    expect(built).toEqual({
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    });
  });

  it('constructs in canonical key order — JSON.stringify equals canonicalPropsSchemaBytes (non-integer keys)', () => {
    const spec: PropsSpec = {
      properties: {
        zebra: { schema: { type: 'string' } },
        alpha: { schema: { type: 'number' }, required: true },
      },
    };
    const built = buildEnforcedPropsSchema(spec);
    expect(JSON.stringify(built)).toBe(canonicalPropsSchemaBytes(built));
  });

  it('is byte-stable across author key insertion order', () => {
    const a: PropsSpec = {
      properties: {
        b: { schema: { type: 'string' } },
        a: { schema: { type: 'number' } },
      },
    };
    const b: PropsSpec = {
      properties: {
        a: { schema: { type: 'number' } },
        b: { schema: { type: 'string' } },
      },
    };
    expect(canonicalPropsSchemaBytes(buildEnforcedPropsSchema(a))).toBe(
      canonicalPropsSchemaBytes(buildEnforcedPropsSchema(b)),
    );
  });
});

describe('canonicalPropsSchemaBytes', () => {
  it('sorts object keys at every depth and preserves array order', () => {
    expect(
      canonicalPropsSchemaBytes({ b: { d: 1, c: 2 }, a: [3, 1, 2] }),
    ).toBe('{"a":[3,1,2],"b":{"c":2,"d":1}}');
  });

  it('handles integer-like keys deterministically regardless of JS enumeration order', () => {
    // JS enumerates integer-like keys numerically first; the canonical
    // form sorts lexicographically — the consumer's re-canonicalize-
    // then-hash rule (P3 pin 3) depends on this being insertion-order-
    // independent.
    expect(canonicalPropsSchemaBytes({ '10': 'a', '9': 'b', x: 'c' })).toBe(
      canonicalPropsSchemaBytes({ x: 'c', '9': 'b', '10': 'a' }),
    );
  });
});

describe('classifyPropsSchemaProfile — P3 pins 4+5', () => {
  it('classifies the enumerated core as grammar-safe, including restricted formats', () => {
    const built = buildEnforcedPropsSchema({
      properties: {
        status: {
          schema: {
            type: 'string',
            enum: ['open', 'busy'],
            description: 'slot state',
          },
          required: true,
        },
        when: { schema: { type: 'string', format: 'date-time' } },
        days: {
          schema: {
            type: 'array',
            items: {
              anyOf: [{ type: 'string' }, { type: 'number' }],
            },
          },
        },
        mode: { schema: { const: 'week', title: 'Mode' } },
      },
    });
    expect(classifyPropsSchemaProfile(built)).toBe('grammar-safe');
  });

  it('classifies the empty closed wrapper as grammar-safe', () => {
    expect(
      classifyPropsSchemaProfile(
        buildEnforcedPropsSchema({ properties: {} }),
      ),
    ).toBe('grammar-safe');
  });

  it('classifies out-of-core keywords as full', () => {
    for (const schema of [
      { type: 'string', pattern: '^a' },
      { type: 'string', minLength: 2 },
      { type: 'number', minimum: 0 },
      { type: 'array', items: { type: 'string' }, uniqueItems: true },
    ] as const) {
      const built = buildEnforcedPropsSchema({
        properties: { x: { schema: { ...schema } } },
      });
      expect(classifyPropsSchemaProfile(built)).toBe('full');
    }
  });

  it('classifies an out-of-list format as full (pin 5)', () => {
    const built = buildEnforcedPropsSchema({
      properties: { link: { schema: { type: 'string', format: 'iri' } } },
    });
    expect(classifyPropsSchemaProfile(built)).toBe('full');
  });

  it('classifies non-false additionalProperties as full', () => {
    const built = buildEnforcedPropsSchema({
      properties: {
        bag: {
          schema: {
            type: 'object',
            properties: {},
            additionalProperties: true,
          },
        },
      },
    });
    expect(classifyPropsSchemaProfile(built)).toBe('full');
  });
});
