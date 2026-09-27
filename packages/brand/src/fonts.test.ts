import { readFileSync } from 'node:fs';
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

  // Bundlers (Turbopack, webpack, Vite) resolve new URL('<file>', import.meta.url)
  // as an asset only when the argument is a literal FILE path. A directory URL
  // joined at runtime breaks a Next consumer's build ("Can't resolve
  // '../fonts/'"), and only a consumer's build would notice, so the source
  // property is pinned here.
  it('names each face by its own literal file URL, never a joined directory URL', () => {
    const source = readFileSync(new URL('./fonts.ts', import.meta.url), 'utf8');
    expect(source).not.toContain("new URL('../fonts/', import.meta.url)");
    for (const file of ['Inter-Regular.woff', 'Inter-Bold.woff', 'GeistMono-Regular.woff']) {
      expect(source).toContain(`new URL('../fonts/${file}', import.meta.url)`);
    }
  });
});
