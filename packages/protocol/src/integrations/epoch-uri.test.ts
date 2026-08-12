/**
 * Epoch-pinned resource URIs (#483) — the ONE encoding seam.
 *
 * Bare URI = live head; `#N` = pinned immutable history record. The
 * encoding (fragment today) may flip to a path segment after the
 * host-transport probe — these tests pin the seam's CONTRACT, not the
 * separator character, except where the wire shape itself is asserted.
 */
import { describe, expect, it } from 'vitest';
import { composeEpochUri, parseEpochUri } from './epoch-uri.js';

const BASE = 'ui://ggui/render/render_abc-123/k9f2';

describe('composeEpochUri', () => {
  it('appends the epoch to the base URI', () => {
    expect(composeEpochUri(BASE, 2)).toBe(`${BASE}#2`);
  });

  it('epoch 0 is a valid pin (the initial render record)', () => {
    expect(composeEpochUri(BASE, 0)).toBe(`${BASE}#0`);
  });

  it('rejects negative and non-integer epochs (producer bug, loud)', () => {
    expect(() => composeEpochUri(BASE, -1)).toThrow();
    expect(() => composeEpochUri(BASE, 1.5)).toThrow();
    expect(() => composeEpochUri(BASE, Number.NaN)).toThrow();
  });
});

describe('parseEpochUri', () => {
  it('parses a pinned URI into base + epoch', () => {
    expect(parseEpochUri(`${BASE}#2`)).toEqual({ baseUri: BASE, epoch: 2 });
  });

  it('a bare URI is the live head — epoch undefined, base untouched', () => {
    expect(parseEpochUri(BASE)).toEqual({ baseUri: BASE });
  });

  it('epoch 0 round-trips', () => {
    expect(parseEpochUri(composeEpochUri(BASE, 0))).toEqual({
      baseUri: BASE,
      epoch: 0,
    });
  });

  it('tolerant read: malformed suffixes are NOT epochs — URI passes through whole', () => {
    for (const bad of [`${BASE}#x`, `${BASE}#-1`, `${BASE}#1.5`, `${BASE}#01`, `${BASE}#`]) {
      expect(parseEpochUri(bad)).toEqual({ baseUri: bad });
    }
  });

  it('never throws on arbitrary input', () => {
    expect(() => parseEpochUri('')).not.toThrow();
    expect(parseEpochUri('')).toEqual({ baseUri: '' });
  });

  it('round-trips across a range', () => {
    for (let epoch = 0; epoch <= 1000; epoch += 37) {
      expect(parseEpochUri(composeEpochUri(BASE, epoch))).toEqual({
        baseUri: BASE,
        epoch,
      });
    }
  });
});
