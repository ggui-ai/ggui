/**
 * Pin (ggui#1765): the decorative hairlines are visible, and keep their order.
 *
 * `outlineVariant` is the faint hairline (Card, Divider, Accordion, DataTable, Modal). At 1.09–1.22:1 /
 * ΔE76 3.0–7.9 against its own surface, and 0.0 against `sunken` in five dark modes, the eye formed the
 * box on some cards and not others. Its floor is ΔE76 ≥ 8 AND ratio ≥ 1.2, against both surfaces a
 * hairline is drawn on (`container` and `sunken`): a 1 px line is resolved by luminance, so ΔE alone
 * does not make it a boundary.
 *
 * `outline` is the stronger hairline, so it sits at least one perceptible step above the variant on both
 * measures (ratio +0.08 AND ΔE76 +3), against both surfaces.
 *
 * ΔE76 is CIELAB (D65) on the colour as painted: an rgba hairline is composited over the surface first,
 * the way a browser paints it.
 */
import { describe, expect, it } from 'vitest';
import { getThemeIds, getRawTheme } from './registry';
import { deriveThemeVariables } from './derive-theme-variables';

const MODES = ['light', 'dark'] as const;
const SURFACES = ['container', 'sunken'] as const;
const HAIRLINE_FLOOR = { deltaE76: 8, ratio: 1.2 } as const;
const OUTLINE_STEP = { deltaE76: 3, ratio: 0.08 } as const;

type Rgba = readonly [number, number, number, number];

function parseColour(css: string): Rgba {
  const s = css.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const h = hex[1]!;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
  }
  const fn = /^rgba?\(([^)]*)\)$/i.exec(s);
  if (!fn) throw new Error(`hairline pin: unreadable colour ${css}`);
  const [r, g, b, a] = fn[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
  return [r!, g!, b!, a ?? 1];
}

/** `fg` painted over an opaque `bg`: the colour the eye reads. */
function paint(fg: string, bg: string): readonly [number, number, number] {
  const f = parseColour(fg);
  const b = parseColour(bg);
  const mix = (i: 0 | 1 | 2): number => f[i] * f[3] + b[i] * (1 - f[3]);
  return [mix(0), mix(1), mix(2)];
}

const linear = (c: number): number => {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};
const luminance = (c: readonly number[]): number => 0.2126 * linear(c[0]!) + 0.7152 * linear(c[1]!) + 0.0722 * linear(c[2]!);
const ratio = (a: readonly number[], b: readonly number[]): number => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
function lab(c: readonly number[]): readonly [number, number, number] {
  const [r, g, b] = c.map(linear) as [number, number, number];
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}
const deltaE76 = (a: readonly number[], b: readonly number[]): number => {
  const [p, q] = [lab(a), lab(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
};

/** A hairline's reading against one surface: [ratio, ΔE76]. */
function reading(v: Readonly<Record<string, string>>, key: 'outline' | 'outlineVariant', surface: (typeof SURFACES)[number]): readonly [number, number] {
  const ground = v[`--ggui-color-${surface}`]!;
  const line = paint(v[`--ggui-color-${key}`]!, ground);
  const g = paint(ground, '#ffffff');
  return [ratio(line, g), deltaE76(line, g)];
}

describe('the decorative hairlines are visible and keep their order (ggui#1765)', () => {
  for (const id of getThemeIds()) {
    for (const mode of MODES) {
      const v = deriveThemeVariables(getRawTheme(id, mode)!, mode, { onDiagnostic: () => {} });
      for (const surface of SURFACES) {
        it(`${id} ${mode}: outlineVariant clears ΔE76 ${HAIRLINE_FLOOR.deltaE76} and ${HAIRLINE_FLOOR.ratio}:1 on ${surface}`, () => {
          const [r, e] = reading(v, 'outlineVariant', surface);
          expect(e, `${id} ${mode} outlineVariant ΔE76 on ${surface}`).toBeGreaterThanOrEqual(HAIRLINE_FLOOR.deltaE76);
          expect(r, `${id} ${mode} outlineVariant ratio on ${surface}`).toBeGreaterThanOrEqual(HAIRLINE_FLOOR.ratio);
        });
        it(`${id} ${mode}: outline sits a step above outlineVariant on ${surface}`, () => {
          const [ro, eo] = reading(v, 'outline', surface);
          const [rv, ev] = reading(v, 'outlineVariant', surface);
          expect(eo - ev, `${id} ${mode} outline − outlineVariant ΔE76 on ${surface}`).toBeGreaterThanOrEqual(OUTLINE_STEP.deltaE76);
          expect(ro - rv, `${id} ${mode} outline − outlineVariant ratio on ${surface}`).toBeGreaterThanOrEqual(OUTLINE_STEP.ratio);
        });
      }
    }
  }

  it('control: the measure is the one the edge probe reads — ggui light\'s pre-lift hairline reads 1.145:1 / ΔE76 5.6', () => {
    // #e4e4e2 on #f4f3ed: the value the probe read on the stored frames of the draw that found the defect.
    const g = paint('#f4f3ed', '#ffffff');
    expect(ratio(paint('#e4e4e2', '#f4f3ed'), g)).toBeCloseTo(1.145, 3);
    expect(deltaE76(paint('#e4e4e2', '#f4f3ed'), g)).toBeCloseTo(5.6, 1);
  });
});
