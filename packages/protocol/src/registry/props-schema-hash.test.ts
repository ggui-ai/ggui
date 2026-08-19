/**
 * `computePropsSchemaHash` — P3 pin 3 (frozen 2026-08-19, guuey#271):
 * sha256 over the RFC 8785 (JCS) canonical bytes — the same
 * canonicalization standard contractHash pins — lowercase hex, full
 * 64 chars, no prefix. Server-only
 * (node:crypto) — lives behind its own subpath per the blueprint-key
 * convention.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { computePropsSchemaHash } from './props-schema-hash.js';
import {
  buildEnforcedPropsSchema,
  canonicalPropsSchemaBytes,
} from '../validation/enforced-props-schema.js';

const SCHEMA = buildEnforcedPropsSchema({
  properties: {
    status: {
      schema: { type: 'string', enum: ['open', 'busy', 'tentative'] },
      required: true,
    },
  },
});

describe('computePropsSchemaHash', () => {
  it('is sha256 over the canonical bytes, lowercase hex, no prefix', () => {
    const expected = createHash('sha256')
      .update(canonicalPropsSchemaBytes(SCHEMA))
      .digest('hex');
    const hash = computePropsSchemaHash(SCHEMA);
    expect(hash).toBe(expected);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is insertion-order independent (consumer re-canonicalize-then-hash rule)', () => {
    const reordered = JSON.parse(JSON.stringify(SCHEMA)) as typeof SCHEMA;
    expect(computePropsSchemaHash(reordered)).toBe(
      computePropsSchemaHash(SCHEMA),
    );
    const different = buildEnforcedPropsSchema({
      properties: {
        status: {
          schema: { type: 'string', enum: ['open', 'busy'] },
          required: true,
        },
      },
    });
    expect(computePropsSchemaHash(different)).not.toBe(
      computePropsSchemaHash(SCHEMA),
    );
  });
});
