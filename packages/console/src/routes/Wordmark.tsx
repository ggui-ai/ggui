/**
 * `Wordmark` — brand-kit v1.0 mirror-variant ggui wordmark.
 *
 * Rendered from a fixed 224 × 50 viewBox. Each `g` is a single ⌐
 * path + 17×17 inner block (two elements, matching the reference
 * SVG); `u` is a full-height open-top/rounded-bottom path; `i` is
 * a 50×50 square. Primitive shapes only — "square is truth" per
 * the brand kit's Premise section. Sized by the caller via `width`.
 * No font dependency, no external asset, < 1 KB inline.
 *
 * Variants:
 *
 *   - `mirror` — chrome g · ink g · ink u · chrome i. The canonical
 *     mark on light surfaces (the default).
 *   - `mono-ink` — all glyphs in ink. Single-color stamps / favicons.
 *   - `reverse` — paper-on-ink for dark surfaces (used in the chat
 *     pane header).
 */
import type { ReactElement } from 'react';

const INK = '#292929';
const CHROME = '#d9d9d9';
const PAPER = '#f4f3ed';

export type WordmarkVariant = 'mirror' | 'mono-ink' | 'reverse';

export interface WordmarkProps {
  readonly width: number;
  readonly variant?: WordmarkVariant;
}

interface Palette {
  readonly g1Outer: string;
  readonly g1Inner: string;
  readonly g2Outer: string;
  readonly g2Inner: string;
  readonly u: string;
  readonly i: string;
}

const PALETTES: Record<WordmarkVariant, Palette> = {
  mirror: {
    g1Outer: CHROME,
    g1Inner: INK,
    g2Outer: INK,
    g2Inner: CHROME,
    u: INK,
    i: CHROME,
  },
  'mono-ink': {
    g1Outer: INK,
    g1Inner: INK,
    g2Outer: INK,
    g2Inner: INK,
    u: INK,
    i: INK,
  },
  reverse: {
    g1Outer: CHROME,
    g1Inner: PAPER,
    g2Outer: PAPER,
    g2Inner: CHROME,
    u: PAPER,
    i: CHROME,
  },
};

export function Wordmark({
  width,
  variant = 'mirror',
}: WordmarkProps): ReactElement {
  const height = Math.round((width * 50) / 224);
  const p = PALETTES[variant];
  return (
    <svg viewBox="0 0 224 50" width={width} height={height} aria-label="ggui">
      {/* g1 — ⌐ (single path: top row + left column) + 17×17 inner */}
      <path d="M 0 0 H 50 V 25 H 25 V 50 H 0 Z" fill={p.g1Outer} />
      <rect x="33" y="33" width="17" height="17" fill={p.g1Inner} />
      {/* g2 — ⌐ + 17×17 inner */}
      <path d="M 58 0 H 108 V 25 H 83 V 50 H 58 Z" fill={p.g2Outer} />
      <rect x="91" y="33" width="17" height="17" fill={p.g2Inner} />
      {/* u — 50×50, open top, rounded bottom half-circle */}
      <path
        d="M 141 50 C 154.807 50 166 38.8071 166 25 V 0 H 116 V 25 C 116 38.8071 127.193 50 141 50 Z"
        fill={p.u}
      />
      {/* i — 50×50 square */}
      <rect x="174" y="0" width="50" height="50" fill={p.i} />
    </svg>
  );
}
