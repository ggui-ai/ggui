/**
 * Pins the formatter that renders a wired-action's `data` payload
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
import { formatWiredActionDataInline } from '../runtime.js';

describe('formatWiredActionDataInline', () => {
  it('renders a string verbatim (unquoted, most legible in consent text)', () => {
    expect(formatWiredActionDataInline('Continue prior work')).toBe(
      'Continue prior work',
    );
  });

  it('renders numbers + booleans stringified', () => {
    expect(formatWiredActionDataInline(42)).toBe('42');
    expect(formatWiredActionDataInline(0)).toBe('0');
    expect(formatWiredActionDataInline(true)).toBe('true');
    expect(formatWiredActionDataInline(false)).toBe('false');
  });

  it('returns empty for null / undefined', () => {
    expect(formatWiredActionDataInline(null)).toBe('');
    expect(formatWiredActionDataInline(undefined)).toBe('');
  });

  it('renders short arrays as JSON', () => {
    expect(formatWiredActionDataInline(['a', 'b', 'c'])).toBe('["a","b","c"]');
  });

  it('truncates long arrays at 60 chars', () => {
    const long = Array.from({ length: 20 }, (_, i) => `item-${i}`);
    const out = formatWiredActionDataInline(long);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith('…')).toBe(true);
  });

  it('renders object entries as `key: value` pairs joined by commas', () => {
    expect(
      formatWiredActionDataInline({ title: 'Team sync', minutes: 30 }),
    ).toBe('title: Team sync, minutes: 30');
  });

  it('returns empty for an empty object (no useful inline content)', () => {
    expect(formatWiredActionDataInline({})).toBe('');
  });

  it('truncates long nested object values to 40 chars per entry', () => {
    const data = {
      payload: { lots: 'of-nested-data-that-goes-on-and-on-and-on-forever' },
    };
    const out = formatWiredActionDataInline(data);
    // The nested JSON's truncated rendering ends in '…'.
    expect(out).toMatch(/payload: .+…/);
  });

  it('handles null values in object entries explicitly', () => {
    expect(formatWiredActionDataInline({ user: null, tag: 'x' })).toBe(
      'user: null, tag: x',
    );
  });
});
