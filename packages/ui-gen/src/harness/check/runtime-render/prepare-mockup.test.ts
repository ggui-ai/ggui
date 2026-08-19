/**
 * `prepareMockupProps` — deterministic mockup synthesis from
 * `contract.propsSpec`. Draft-07 type arrays (`['string','null']`, the
 * canonical nullable form since draft-2026-08-19) must synthesize from
 * the first non-null member — the pre-fix switch returned an
 * unsupported-type failure, so every contract with a nullable prop
 * warned (required) or silently dropped the prop (optional) on every
 * render-check.
 */
import { describe, expect, it } from 'vitest';
import { prepareMockupProps } from './prepare-mockup.js';

describe('prepareMockupProps — draft-07 type arrays', () => {
  it('synthesizes a nullable string prop from its non-null member with no warnings', () => {
    const result = prepareMockupProps({
      contract: {
        propsSpec: {
          properties: {
            note: { schema: { type: ['string', 'null'] }, required: true },
          },
        },
      },
    });
    expect(result.warnings).toEqual([]);
    expect(typeof result.props['note']).toBe('string');
  });

  it('synthesizes null for a pure null-typed member set', () => {
    const result = prepareMockupProps({
      contract: {
        propsSpec: {
          properties: {
            gap: { schema: { type: ['null'] }, required: true },
          },
        },
      },
    });
    expect(result.warnings).toEqual([]);
    expect(result.props['gap']).toBeNull();
  });
});
