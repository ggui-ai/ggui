/**
 * Pin: array elements synthesized by the schema-first fill are DISTINCT —
 * every string inside an element carries the element's ordinal, so two
 * quick replies never share an `id` or a visible label. Without it the
 * runtime probe's selection-identity rule read a correctly keyed hello
 * ("clicking EACH fired 'chooseReply' with the same id ('Sample Id')") as
 * broken on 2026-09-10 — the rule is undecidable on identical items.
 */
import { describe, expect, it } from 'vitest';
import { prepareMockupProps } from './prepare-mockup.js';

describe('schema-first fill — array elements are distinguishable', () => {
  it('gives each element its own id and label', () => {
    const result = prepareMockupProps({
      contract: {
        propsSpec: {
          properties: {
            quickReplies: {
              schema: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { id: { type: 'string' }, label: { type: 'string' } },
                  required: ['id', 'label'],
                },
              },
              required: true,
            },
          },
        },
      },
    });
    const replies = result.props['quickReplies'];
    expect(Array.isArray(replies)).toBe(true);
    if (!Array.isArray(replies)) return;
    const items = replies.map((r) => (r !== null && typeof r === 'object' && !Array.isArray(r) ? r : {}));
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(new Set(items.map((r) => r['id'])).size).toBe(items.length);
    expect(new Set(items.map((r) => r['label'])).size).toBe(items.length);
    expect(items[0]?.['id']).toBe('Sample Id 1');
    expect(items[1]?.['label']).toBe('Sample Label 2');
  });
  it("top-level strings keep today's placeholder (no ordinal outside arrays)", () => {
    const result = prepareMockupProps({
      contract: { propsSpec: { properties: { heading: { schema: { type: 'string' }, required: true } } } },
    });
    expect(result.props['heading']).toBe('Sample Heading');
  });
});
