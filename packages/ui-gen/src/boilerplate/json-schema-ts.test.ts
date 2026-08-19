/**
 * `jsonSchemaTypeToTs` — the LLM-visible `interface Props` field-type
 * generator. Draft-07 type arrays (`['string','null']`, the canonical
 * nullable form since draft-2026-08-19) must map to the members' TS
 * union — the pre-fix switch fell through to `unknown`, silently
 * erasing type info from the boilerplate the coding model reads.
 */
import { describe, expect, it } from 'vitest';
import { jsonSchemaTypeToTs } from './json-schema-ts.js';

describe('jsonSchemaTypeToTs — draft-07 type arrays', () => {
  it('maps a nullable primitive to the TS union', () => {
    expect(jsonSchemaTypeToTs({ type: ['string', 'null'] })).toBe(
      'string | null',
    );
    expect(jsonSchemaTypeToTs({ type: ['number', 'null'] })).toBe(
      'number | null',
    );
  });

  it('maps a nullable object with properties to the object union', () => {
    expect(
      jsonSchemaTypeToTs({
        type: ['object', 'null'],
        properties: { id: { type: 'string' } },
        required: ['id'],
      }),
    ).toBe('{ id: string } | null');
  });

  it('does not double-append null when nullable rides alongside a type array', () => {
    expect(
      jsonSchemaTypeToTs({ type: ['string', 'null'], nullable: true }),
    ).toBe('string | null');
  });

  it('single-string types and OpenAPI nullable stay as before', () => {
    expect(jsonSchemaTypeToTs({ type: 'string' })).toBe('string');
    expect(jsonSchemaTypeToTs({ type: 'string', nullable: true })).toBe(
      'string | null',
    );
  });

  it('array items with a type-array element map to a parenthesized union array', () => {
    expect(
      jsonSchemaTypeToTs({
        type: 'array',
        items: { type: ['string', 'null'] },
      }),
    ).toBe('(string | null)[]');
  });
});
