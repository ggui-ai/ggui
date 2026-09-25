import { describe, expect, it } from 'vitest';
import { socialCardFonts } from './fonts.js';

describe('socialCardFonts', () => {
  it('bundles Inter Regular and Bold and Geist Mono Regular', () => {
    expect(socialCardFonts().map((f) => [f.name, f.weight, f.style])).toEqual([
      ['Inter', 400, 'normal'],
      ['Inter', 700, 'normal'],
      ['Geist Mono', 400, 'normal'],
    ]);
  });

  it('ships every face as WOFF, which satori reads (never WOFF2)', () => {
    for (const face of socialCardFonts()) {
      expect(face.data.subarray(0, 4).toString('latin1')).toBe('wOFF');
      expect(face.data.byteLength).toBeGreaterThan(10_000);
    }
  });
});
