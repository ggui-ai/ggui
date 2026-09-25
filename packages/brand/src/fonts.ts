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
// `src/`, so the same relative URL resolves from either.
const FONT_DIR = new URL('../fonts/', import.meta.url);

function face(file: string): Buffer {
  return readFileSync(new URL(file, FONT_DIR));
}

/**
 * The social card's faces: Inter Regular and Bold, and Geist Mono Regular,
 * vendored as WOFF (satori reads TTF, OTF and WOFF, not WOFF2) under the SIL
 * Open Font License, with their licence files in `fonts/`. Reads the files
 * from disk, so it runs in Node, not in an edge runtime.
 */
export function socialCardFonts(): SocialCardFont[] {
  return [
    { name: 'Inter', data: face('Inter-Regular.woff'), weight: 400, style: 'normal' },
    { name: 'Inter', data: face('Inter-Bold.woff'), weight: 700, style: 'normal' },
    { name: 'Geist Mono', data: face('GeistMono-Regular.woff'), weight: 400, style: 'normal' },
  ];
}
