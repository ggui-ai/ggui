import { BRAND_COLORS } from './tokens.js';

/**
 * The wordmark's letters on their 224 × 50 grid (ggui brand kit v1.0): four
 * glyphs, chrome-g · ink-g · ink-u · chrome-i. This is the canonical
 * construction; every other copy of the mark must match it byte for byte.
 */
export const WORDMARK_VIEWBOX = { width: 224, height: 50 } as const;

/** Which of the two brand colours a shape is filled with. */
export type WordmarkTone = 'chrome' | 'ink';

export type WordmarkShape =
  | { readonly kind: 'path'; readonly d: string; readonly tone: WordmarkTone }
  | {
      readonly kind: 'rect';
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly tone: WordmarkTone;
    };

export const WORDMARK_SHAPES: readonly WordmarkShape[] = [
  // g: a chrome ⌐ with an ink inner block.
  { kind: 'path', d: 'M 0 0 H 50 V 25 H 25 V 50 H 0 Z', tone: 'chrome' },
  { kind: 'rect', x: 33, y: 33, width: 17, height: 17, tone: 'ink' },
  // g: an ink ⌐ with a chrome inner block.
  { kind: 'path', d: 'M 58 0 H 108 V 25 H 83 V 50 H 58 Z', tone: 'ink' },
  { kind: 'rect', x: 91, y: 33, width: 17, height: 17, tone: 'chrome' },
  // u: ink, open at the top, rounded at the bottom.
  {
    kind: 'path',
    d: 'M 141 50 C 154.807 50 166 38.8071 166 25 V 0 H 116 V 25 C 116 38.8071 127.193 50 141 50 Z',
    tone: 'ink',
  },
  // i: a chrome square.
  { kind: 'rect', x: 174, y: 0, width: 50, height: 50, tone: 'chrome' },
];

/** The fill for a shape's tone. */
export function wordmarkFill(tone: WordmarkTone): string {
  return tone === 'chrome' ? BRAND_COLORS.chrome : BRAND_COLORS.ink;
}

/** The letters as a standalone SVG document, `width` wide, height to scale. */
export function wordmarkSvg(opts: { readonly width: number }): string {
  const height = (opts.width / WORDMARK_VIEWBOX.width) * WORDMARK_VIEWBOX.height;
  const shapes = WORDMARK_SHAPES.map((s) =>
    s.kind === 'path'
      ? `<path d="${s.d}" fill="${wordmarkFill(s.tone)}"/>`
      : `<rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" fill="${wordmarkFill(s.tone)}"/>`,
  ).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WORDMARK_VIEWBOX.width} ${WORDMARK_VIEWBOX.height}" width="${opts.width}" height="${height}" role="img" aria-label="ggui — generative graphical user interface">${shapes}</svg>`;
}
