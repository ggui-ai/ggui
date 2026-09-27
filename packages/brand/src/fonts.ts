import { readFileSync } from 'node:fs';

/**
 * One face in the social card's bundle, in the shape satori (and Next's
 * `ImageResponse`) takes for `fonts`.
 */
export interface SocialCardFont {
  readonly name: 'Inter' | 'Geist Mono';
  readonly data: Buffer;
  readonly weight: 400 | 700;
  readonly style: 'normal';
}

// The faces ship in the package's `fonts/` directory, beside `dist/` and
// `src/`, so the same relative URL resolves from either. One literal URL per
// face: bundlers (Turbopack, webpack, Vite) treat `new URL('<file>',
// import.meta.url)` as an asset reference and emit the file, while a directory
// URL joined at runtime is opaque to them and fails to resolve.
const INTER_REGULAR = new URL('../fonts/Inter-Regular.woff', import.meta.url);
const INTER_BOLD = new URL('../fonts/Inter-Bold.woff', import.meta.url);
const GEIST_MONO_REGULAR = new URL('../fonts/GeistMono-Regular.woff', import.meta.url);

/**
 * The social card's faces: Inter Regular and Bold, and Geist Mono Regular,
 * vendored as WOFF (satori reads TTF, OTF and WOFF, not WOFF2) under the SIL
 * Open Font License, with their licence files in `fonts/`. Reads the files
 * from disk, so it runs in Node, not in an edge runtime.
 */
export function socialCardFonts(): SocialCardFont[] {
  return [
    { name: 'Inter', data: readFileSync(INTER_REGULAR), weight: 400, style: 'normal' },
    { name: 'Inter', data: readFileSync(INTER_BOLD), weight: 700, style: 'normal' },
    { name: 'Geist Mono', data: readFileSync(GEIST_MONO_REGULAR), weight: 400, style: 'normal' },
  ];
}
