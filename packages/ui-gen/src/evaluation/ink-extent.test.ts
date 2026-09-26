/**
 * ggui#1120 — the ink extent read from a judge capture: the dominant colour is the ground, a pixel is
 * ink past the tolerance, the last inked row over the region's height is the ratio, and only the zero
 * (no ink at all) is the blank. The reader takes exactly the judge's PNG subset and nothing else.
 */
import { describe, expect, it } from 'vitest';
import { encodePng, flatPng } from './__fixtures__/png.js';
import { INK_TOLERANCE, decodePng, readInkExtent } from './ink-extent.js';

const WHITE = [255, 255, 255] as const;
const INK = [20, 30, 40] as const;

function measured(png: Buffer, inset = 0) {
  const r = readInkExtent(png, inset);
  if ('reason' in r) throw new Error(`unreadable: ${r.reason}`);
  return r;
}

describe('decodePng — the judge’s own PNG subset, every scanline filter undone', () => {
  for (const filter of [0, 1, 2, 3, 4] as const) {
    for (const channels of [3, 4] as const) {
      it(`filter ${filter}, ${channels === 3 ? 'RGB' : 'RGBA'}: the pixels come back exactly`, () => {
        const png = encodePng({ width: 7, height: 5, channels, filter, pixel: (x, y) => [x * 30, y * 50, (x + y) * 9] });
        const d = decodePng(png);
        if ('reason' in d) throw new Error(d.reason);
        expect([d.width, d.height, d.channels]).toEqual([7, 5, channels]);
        for (let y = 0; y < 5; y++) {
          for (let x = 0; x < 7; x++) {
            const i = (y * 7 + x) * channels;
            expect([d.pixels[i], d.pixels[i + 1], d.pixels[i + 2]], `(${x},${y})`).toEqual([x * 30, y * 50, (x + y) * 9]);
          }
        }
      });
    }
  }

  it('anything outside the subset is unreadable with a reason — never a blank', () => {
    const reasons = [
      decodePng(new Uint8Array([1, 2, 3])),
      decodePng(encodePng({ width: 2, height: 2, channels: 3, pixel: () => WHITE, colorType: 3 })),
      decodePng(encodePng({ width: 2, height: 2, channels: 3, pixel: () => WHITE, bitDepth: 16 })),
      decodePng(encodePng({ width: 2, height: 2, channels: 3, pixel: () => WHITE, interlace: 1 })),
      decodePng(flatPng(4, 4, WHITE).subarray(0, 48)),
    ].map((d) => ('reason' in d ? d.reason : 'DECODED'));
    expect(reasons).toEqual([
      'not a PNG: 3 bytes',
      'unsupported PNG: colour type 3',
      'unsupported PNG: bit depth 16',
      'unsupported PNG: interlaced',
      'truncated PNG: IDAT chunk runs past the end',
    ]);
  });

  it('a corrupt IDAT stream is unreadable with the inflate error, not a crash', () => {
    const png = flatPng(4, 4, WHITE);
    const idat = png.indexOf('IDAT', 0, 'latin1');
    png[idat + 4] = 0xff;
    png[idat + 5] = 0xff;
    const d = decodePng(png);
    expect('reason' in d && d.reason.startsWith('corrupt IDAT stream:')).toBe(true);
  });
});

describe('readInkExtent — the ground is the dominant colour, ink is what differs past the tolerance', () => {
  it('one flat colour is the blank: no ink row, ratio 0, in every filter and both channel counts', () => {
    for (const filter of [0, 1, 2, 3, 4] as const) {
      for (const channels of [3, 4] as const) {
        const r = measured(flatPng(40, 30, [245, 237, 239], channels, filter));
        expect([r.lastInkRow, r.ratio, r.ground], `filter ${filter} ${channels}ch`).toEqual([null, 0, [245, 237, 239]]);
      }
    }
  });

  it('a line of ink at row 12 of 30 reads lastInkRow 12 and ratio 13/30, whatever sits above it', () => {
    const png = encodePng({ width: 40, height: 30, channels: 3, pixel: (x, y) => (y === 12 && x >= 5 && x < 20) || y === 3 ? INK : WHITE });
    const r = measured(png);
    expect(r).toEqual({ ratio: 0.433, lastInkRow: 12, region: { x: 0, y: 0, width: 40, height: 30 }, ground: WHITE });
  });

  it('a difference at or below the tolerance is the same colour; one past it is ink', () => {
    const same = encodePng({ width: 10, height: 10, channels: 3, pixel: (x, y) => (x === 4 && y === 4 ? [255 - INK_TOLERANCE, 255, 255] : WHITE) });
    expect(measured(same).lastInkRow).toBeNull();
    const inked = encodePng({ width: 10, height: 10, channels: 3, pixel: (x, y) => (x === 4 && y === 4 ? [255 - INK_TOLERANCE - 1, 255, 255] : WHITE) });
    expect(measured(inked).lastInkRow).toBe(4);
  });

  it('the ground is the most common colour, not the corners: a hero band across the top and a lower ground read the band as ink', () => {
    const BAND = [221, 232, 255] as const;
    const png = encodePng({ width: 20, height: 30, channels: 3, pixel: (_x, y) => (y < 8 ? BAND : WHITE) });
    const r = measured(png);
    expect(r.ground).toEqual(WHITE);
    expect(r.lastInkRow).toBe(7);
    expect(r.ratio).toBe(0.267);
  });

  it('the inset skips the edges: ink only inside the band a host panel occupies does not count, and the ratio is over the region', () => {
    // 100×100, ink in a 3-px ring at 5 px from the edge (a hairline), nothing inside.
    const ring = encodePng({ width: 100, height: 100, channels: 3, pixel: (x, y) => (Math.min(x, y, 99 - x, 99 - y) === 5 ? INK : WHITE) });
    expect(measured(ring, 0).lastInkRow).toBe(94);
    const inner = measured(ring, 10);
    expect(inner.region).toEqual({ x: 10, y: 10, width: 80, height: 80 });
    expect(inner.lastInkRow).toBeNull();
    expect(inner.ratio).toBe(0);
    // Ink at image row 50 with the same inset: region row 40 of 80.
    const mid = encodePng({ width: 100, height: 100, channels: 3, pixel: (_x, y) => (y === 50 ? INK : WHITE) });
    expect(measured(mid, 10)).toMatchObject({ lastInkRow: 40, ratio: 0.513 });
  });

  it('an inset that leaves nothing is unreadable with a reason', () => {
    const r = readInkExtent(flatPng(10, 10, WHITE), 5);
    expect('reason' in r ? r.reason : 'READ').toBe('an inset of 5px leaves nothing of a 10×10 image');
  });
});
