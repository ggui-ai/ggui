/**
 * The finish instruments: four `must` rows of the criteria bank answered from one finish probe (`finish-probe.ts`)
 * instead of by the judge. Pure functions over the probe's typed read; the thresholds are the bank rows' own,
 * registered before any measurement (the criteria bank as re-authored for the hero surface, ggui#1440):
 *
 * - `read.contrast`: every text meets WCAG AA against its effective background — body ≥ 4.5:1, large (≥ 24 px, or
 *   ≥ 19 px bold) ≥ 3.0:1. A text whose background cannot be composited from flat colours is never given a number:
 *   the row reads not evaluated, with the reason.
 * - `hello.field`: the band (the hero surface) paints the card's resolved hero ground and covers ≥ 8 % of the card.
 * - `hello.one-colour`: the band is the only fill; outside it, every populous saturated paint (chroma > 120, weighing
 *   ≥ 2 % of the largest saturated paint outside the band) is within ΔE76 ≤ 5 of the band's ground, and so is every
 *   filled control (a control whose fill differs by ΔE76 > 5 from the surface behind it). The floor is relative so a
 *   chip's one-pixel border is weighed against its peers, never against the whole card. There is no separate rule for
 *   an achromatic band: a saturated paint is far from a grey by ΔE76 and fails on that alone, while a paint within
 *   ΔE76 5 of a muted band is the band's own colour, not an accent. No filled control and no saturated paint is a pass.
 * - `hello.gesture`: the heading is ≥ 1.5× the body text and at most 2 lines, and nothing else reaches the heading's
 *   step (exactly one typographic event).
 *
 * The probe reads the DOM, so these are DOM readings of rows first written against pixels: a colour's "cluster" is
 * the painted area of the elements that declare it (fills by their box, borders by length × width). Text colours are
 * not weighed here: a text run's box overstates its ink.
 */
import type { CriteriaNotEvaluatedReason, CriteriaVerdict } from '../types-public.js';
import type { FinishProbe, FinishText, Rgba } from './finish-probe.js';

export interface FinishRead {
  readonly verdict: CriteriaVerdict;
  readonly evidence: string;
  readonly notEvaluated?: { readonly reason: CriteriaNotEvaluatedReason };
}

/** The registered thresholds, by row (see the module docblock). */
export const FINISH_THRESHOLDS = {
  contrastBody: 4.5,
  contrastLarge: 3.0,
  largePx: 24,
  largeBoldPx: 19,
  largeBoldWeight: 700,
  fieldShare: 0.08,
  saturatedChroma: 120,
  populousOfLargest: 0.02,
  oneColourDeltaE76: 5,
  gestureRatio: 1.5,
  gestureMaxLines: 2,
} as const;

const WHITE: Rgba = [255, 255, 255, 1];

/**
 * `top` composited over the opaque `under` (straight alpha), rounded to 8 bits per channel as the browser paints it.
 * The rounding is what the frame shows, and it is what reproduces the criteria bank's recorded figures (4.38:1 at .92 and
 * 4.04:1 at .85 on primary-500, where the unrounded blend reads 4.39 and 4.04).
 */
export function over(top: Rgba, under: Rgba): Rgba {
  const a = top[3];
  const mix = (i: 0 | 1 | 2): number => Math.round(top[i] * a + under[i] * (1 - a));
  return [mix(0), mix(1), mix(2), 1];
}

/** The effective background: the nearest-first list composited bottom-up, over white when none is opaque. */
export function effectiveBackground(backgrounds: readonly Rgba[]): Rgba {
  let acc: Rgba = WHITE;
  for (let i = backgrounds.length - 1; i >= 0; i--) acc = over(backgrounds[i]!, acc);
  return acc;
}

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2 relative luminance of an opaque colour. */
export function luminance(c: Rgba): number {
  return 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
}

/** WCAG 2 contrast ratio of two opaque colours. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** CIE L*a*b* (D65) of an opaque sRGB colour. */
export function lab(c: Rgba): readonly [number, number, number] {
  const lin = (v: number): number => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [lin(c[0]), lin(c[1]), lin(c[2])];
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [fx, fy, fz] = [f(X), f(Y), f(Z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 ΔE: the Euclidean distance in L*a*b*. */
export function deltaE76(a: Rgba, b: Rgba): number {
  const [A, B] = [lab(a), lab(b)];
  return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
}

/** Chroma as the bank rows use it: the RGB channel spread, 0–255. */
export function chroma(c: Rgba): number {
  return Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
}

const hexOf = (c: Rgba): string => `#${[c[0], c[1], c[2]].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
const isLarge = (t: FinishText): boolean => t.fontSize >= FINISH_THRESHOLDS.largePx || (t.fontSize >= FINISH_THRESHOLDS.largeBoldPx && t.fontWeight >= FINISH_THRESHOLDS.largeBoldWeight);

/** `read.contrast`. */
export function readContrast(p: FinishProbe): FinishRead {
  if (p.texts.length === 0) return { verdict: 'n/a', evidence: 'no text on the card' };
  const uncertain = p.texts.filter((t) => !t.composite);
  let worst: { t: FinishText; ratio: number; floor: number } | null = null;
  for (const t of p.texts.filter((x) => x.composite)) {
    const bg = effectiveBackground(t.backgrounds);
    const ratio = contrastRatio(over(t.color, bg), bg);
    const floor = isLarge(t) ? FINISH_THRESHOLDS.contrastLarge : FINISH_THRESHOLDS.contrastBody;
    if (worst === null || ratio / floor < worst.ratio / worst.floor) worst = { t, ratio, floor };
  }
  const named = (w: NonNullable<typeof worst>): string =>
    `${w.t.tag} "${w.t.sample}" ${w.ratio.toFixed(2)}:1 against ${w.floor}:1 (${hexOf(over(w.t.color, effectiveBackground(w.t.backgrounds)))} on ${hexOf(effectiveBackground(w.t.backgrounds))})`;
  if (worst !== null && worst.ratio < worst.floor) return { verdict: 'fail', evidence: named(worst) };
  if (uncertain.length > 0) {
    return {
      verdict: 'n/a',
      evidence: `${uncertain.length} of ${p.texts.length} texts sit on a background that is not flat colour (an image or gradient, an opacity, a blend or an overlap): no ratio given${worst !== null ? `; the rest meet AA, worst ${named(worst)}` : ''}`,
      notEvaluated: { reason: 'not-flat' },
    };
  }
  return { verdict: 'pass', evidence: `every text meets AA; worst ${named(worst!)}` };
}

/** `hello.field`. */
export function readField(p: FinishProbe): FinishRead {
  if (p.hero === null) return { verdict: 'fail', evidence: 'no hero surface on the card: the band is not a field' };
  if (p.hero.background === null || !p.hero.flat) {
    return { verdict: 'n/a', evidence: 'the band is not a flat colour (an image, gradient, opacity or blend)', notEvaluated: { reason: 'not-flat' } };
  }
  if (p.heroGround === null) return { verdict: 'n/a', evidence: 'the card has no resolvable --ggui-color-heroGround', notEvaluated: { reason: 'unresolved-token' } };
  const band = over(p.hero.background, WHITE);
  const ground = over(p.heroGround, WHITE);
  const cardArea = p.card.width * p.card.height;
  const share = cardArea > 0 ? (p.hero.width * p.hero.height) / cardArea : 0;
  const same = Math.max(...[0, 1, 2].map((i) => Math.abs(band[i]! - ground[i]!))) <= 1;
  const evidence = `band ${hexOf(band)} vs hero ground ${hexOf(ground)}, covering ${(share * 100).toFixed(1)} % of the card`;
  return { verdict: same && share >= FINISH_THRESHOLDS.fieldShare ? 'pass' : 'fail', evidence };
}

/** `hello.one-colour`. */
export function readOneColour(p: FinishProbe): FinishRead {
  // A band painted by an image or gradient has no single ground: its background colour is transparent and would read as
  // whatever lies behind it, so the row is not evaluated rather than compared against white (found on a real page).
  if (p.hero === null || p.hero.background === null || !p.hero.flat) {
    return { verdict: 'n/a', evidence: 'no flat band to compare against', notEvaluated: { reason: 'not-flat' } };
  }
  const band = over(p.hero.background, WHITE);
  const outside = p.paints.filter((x) => !x.inHero);
  // A filled control: one whose fill stands off the surface behind it (an outline control's fill is that surface).
  const filled = outside
    .filter((x) => x.kind === 'fill' && x.control)
    .map((x) => {
      const behind = effectiveBackground(x.behind);
      return { fill: over(x.color, behind), behind };
    })
    .filter((x) => deltaE76(x.fill, x.behind) > FINISH_THRESHOLDS.oneColourDeltaE76)
    .map((x) => x.fill);
  const offControl = filled.find((c) => deltaE76(c, band) > FINISH_THRESHOLDS.oneColourDeltaE76);
  if (offControl !== undefined) {
    return { verdict: 'fail', evidence: `a filled control in ${hexOf(offControl)} is ΔE76 ${deltaE76(offControl, band).toFixed(1)} from the band's ${hexOf(band)}: the band is not the only fill` };
  }
  const byColour = new Map<string, { color: Rgba; area: number }>();
  for (const x of outside) {
    const c = over(x.color, WHITE);
    if (chroma(c) <= FINISH_THRESHOLDS.saturatedChroma) continue;
    const k = hexOf(c);
    const prev = byColour.get(k);
    byColour.set(k, { color: c, area: (prev?.area ?? 0) + x.area });
  }
  const saturated = [...byColour.values()];
  // Whether the band has hue shapes only the evidence sentence; the verdict is the ΔE76 test alone.
  const achromatic = chroma(band) <= FINISH_THRESHOLDS.saturatedChroma;
  const largest = Math.max(0, ...saturated.map((v) => v.area));
  const populous = saturated.filter((v) => v.area >= FINISH_THRESHOLDS.populousOfLargest * largest);
  const off = populous.filter((v) => deltaE76(v.color, band) > FINISH_THRESHOLDS.oneColourDeltaE76);
  if (off.length > 0) {
    const w = off.sort((a, b) => b.area - a.area)[0]!;
    return {
      verdict: 'fail',
      evidence: achromatic
        ? `an achromatic band (${hexOf(band)}) with a saturated ${hexOf(w.color)} outside it: an invented accent`
        : `${hexOf(w.color)} outside the band is ΔE76 ${deltaE76(w.color, band).toFixed(1)} from the band's ${hexOf(band)}`,
    };
  }
  return {
    verdict: 'pass',
    evidence:
      populous.length === 0 && filled.length === 0
        ? `the band (${hexOf(band)}) is the only fill; no filled control and no saturated paint outside it`
        : `every filled control and populous saturated paint outside the band is within ΔE76 ${FINISH_THRESHOLDS.oneColourDeltaE76} of ${hexOf(band)}`,
  };
}

/** `hello.gesture`. */
export function readGesture(p: FinishProbe): FinishRead {
  const headings = p.texts.filter((t) => t.heading);
  const body = p.texts.filter((t) => !t.heading && !t.control);
  if (headings.length === 0) return { verdict: 'fail', evidence: 'no heading: no typographic event' };
  if (body.length === 0) return { verdict: 'n/a', evidence: 'no body text to measure the heading against' };
  const heading = headings.reduce((a, b) => (b.fontSize > a.fontSize ? b : a));
  const bodyPx = Math.max(...body.map((t) => t.fontSize));
  const ratio = heading.fontSize / bodyPx;
  const loud = p.texts.filter((t) => t !== heading && t.fontSize / bodyPx >= FINISH_THRESHOLDS.gestureRatio);
  const bodyRun = body.find((t) => t.fontSize === bodyPx)!;
  const evidence = `heading ${heading.fontSize}px over body ${bodyPx}px (${bodyRun.tag} "${bodyRun.sample}") = ${ratio.toFixed(2)}×, ${heading.lines} line${heading.lines === 1 ? '' : 's'}`;
  if (ratio < FINISH_THRESHOLDS.gestureRatio) return { verdict: 'fail', evidence: `${evidence}: below ${FINISH_THRESHOLDS.gestureRatio}×` };
  if (heading.lines > FINISH_THRESHOLDS.gestureMaxLines) return { verdict: 'fail', evidence: `${evidence}: more than ${FINISH_THRESHOLDS.gestureMaxLines} lines` };
  if (loud.length > 0) return { verdict: 'fail', evidence: `${evidence}; but ${loud[0]!.tag} "${loud[0]!.sample}" also reaches the heading's step: not exactly one typographic event` };
  return { verdict: 'pass', evidence };
}

/** The finish instruments by the bank ids they answer. */
export const FINISH_READS = {
  'read.contrast': readContrast,
  'hello.field': readField,
  'hello.one-colour': readOneColour,
  'hello.gesture': readGesture,
} as const satisfies Record<string, (p: FinishProbe) => FinishRead>;
