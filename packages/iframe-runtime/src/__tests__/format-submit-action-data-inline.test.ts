/**
 * Pins the formatter that renders a submit-action's `data` payload
 * into the `ui/message` consent prompt's parenthetical phrase.
 *
 * Pre-2026-05-07 the formatter silently returned '' for any
 * non-object data (strings / numbers / booleans / arrays). That
 * vaporised the chip's actual text from the consent line, so a
 * `dispatch('sendPrompt', 'Continue prior work')` arrived at the
 * host LLM as 'Please proceed with **sendPrompt**. [id: ...]' with
 * no payload context. This regression-pins the primitive branches.
 */
import { describe, it, expect } from 'vitest';
import { formatSubmitActionDataInline } from '../runtime.js';

describe('formatSubmitActionDataInline', () => {
  it('renders a string verbatim (unquoted, most legible in consent text)', () => {
    expect(formatSubmitActionDataInline('Continue prior work')).toBe(
      'Continue prior work',
    );
  });

  it('renders numbers + booleans stringified', () => {
    expect(formatSubmitActionDataInline(42)).toBe('42');
    expect(formatSubmitActionDataInline(0)).toBe('0');
    expect(formatSubmitActionDataInline(true)).toBe('true');
    expect(formatSubmitActionDataInline(false)).toBe('false');
  });

  it('returns empty for null / undefined', () => {
    expect(formatSubmitActionDataInline(null)).toBe('');
    expect(formatSubmitActionDataInline(undefined)).toBe('');
  });

  it('renders short arrays as JSON', () => {
    expect(formatSubmitActionDataInline(['a', 'b', 'c'])).toBe('["a","b","c"]');
  });

  it('truncates long arrays at 60 chars', () => {
    const long = Array.from({ length: 20 }, (_, i) => `item-${i}`);
    const out = formatSubmitActionDataInline(long);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith('…')).toBe(true);
  });

  it('renders object entries as `key: value` pairs joined by commas', () => {
    expect(
      formatSubmitActionDataInline({ title: 'Team sync', minutes: 30 }),
    ).toBe('title: Team sync, minutes: 30');
  });

  it('returns empty for an empty object (no useful inline content)', () => {
    expect(formatSubmitActionDataInline({})).toBe('');
  });

  it('truncates long nested object values to 40 chars per entry', () => {
    const data = {
      payload: { lots: 'of-nested-data-that-goes-on-and-on-and-on-forever' },
    };
    const out = formatSubmitActionDataInline(data);
    // The nested JSON's truncated rendering ends in '…'.
    expect(out).toMatch(/payload: .+…/);
  });

  it('handles null values in object entries explicitly', () => {
    expect(formatSubmitActionDataInline({ user: null, tag: 'x' })).toBe(
      'user: null, tag: x',
    );
  });
});
