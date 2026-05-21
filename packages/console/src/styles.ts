/**
 * Raw token exports for the few call sites that need computed values at
 * runtime (e.g. inline SVG fills on the Wordmark, dynamic state colors
 * on badges). All visual / layout styling lives in `./index.css` —
 * consumers should reach for the corresponding className first.
 *
 * Palette and type stack track the ggui brand kit. Light-touch
 * duplication with the stylesheet; if you add a token here add a
 * matching `--ggui-*` var in `index.css` (or vice versa).
 */

const INK = '#292929';
const INK_2 = '#3d3d3d';
const INK_3 = '#5a5a5a';
const INK_4 = '#8c8c93';
const CHROME = '#d9d9d9';
const PAPER = '#f4f3ed';
const PAPER_2 = '#ebe9e1';
const LINE_2 = '#d6d4cb';

const SANS =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const MONO =
  'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

export const tokens = {
  ink: INK,
  ink2: INK_2,
  ink3: INK_3,
  ink4: INK_4,
  chrome: CHROME,
  paper: PAPER,
  paper2: PAPER_2,
  line2: LINE_2,
  signal: '#d93822',
  live: '#1b7a37',
  draft: '#a87b0e',
  fontSans: SANS,
  fontMono: MONO,
} as const;
