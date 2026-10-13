/**
 * ggui#1847 — the categorical tints. Every shipped theme, in both schemes,
 * carries eight tints that clear four floors: the theme's ink on every tint,
 * a visible fill on the container, eight distinct tints, and no tint read as a
 * state container. The floors are re-measured here from the emitted tokens, not
 * read back from the walk's own report.
 */
import { describe, expect, it } from 'vitest';
import { TINT_STEPS, resolveTintCss } from '../primitives/color-slots';
import {
  TINT_FLOORS,
  TINT_RECIPE,
  TINT_SCREEN_MARGIN,
  TINT_SEARCH,
  TINT_STATE_CONTAINERS,
  completeThemeVariables,
  tintPointInGamut,
  contrastRatio,
  deriveThemeVariables,
  deltaEOk,
  deriveTints,
  hexToOklch,
  oklchToHex,
} from './derive-theme-variables';
import { getRawTheme, getThemeIds } from './registry';

/** OKLab ΔE × 100, computed here from the OKLCH reading rather than through the walk's helper. */
function dE(a: string, b: string): number {
  const p = hexToOklch(a);
  const q = hexToOklch(b);
  const ra = (p.h * Math.PI) / 180;
  const rb = (q.h * Math.PI) / 180;
  return 100 * Math.hypot(p.l - q.l, p.c * Math.cos(ra) - q.c * Math.cos(rb), p.c * Math.sin(ra) - q.c * Math.sin(rb));
}

const MODES = ['light', 'dark'] as const;
const tintsOf = (v: Readonly<Record<string, string>>): string[] => TINT_STEPS.map((s) => v[`--ggui-color-${s}`]!);

describe('the instruments, on pairs whose answer is known', () => {
  it('contrast: white on black is 21:1; ΔE: black to white is 100, a colour to itself is 0', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 6);
    expect(dE('#000000', '#ffffff')).toBeCloseTo(100, 3);
    expect(dE('#4a90d9', '#4a90d9')).toBe(0);
    expect(deltaEOk('#000000', '#ffffff')).toBeCloseTo(100, 3);
  });
});

describe('categorical tints: every shipped theme clears the floors in both schemes (ggui#1847)', () => {
  const cases = getThemeIds().flatMap((id) => MODES.map((mode) => [id, mode] as const));

  it('covers every shipped theme (control: the list is not empty)', () => {
    expect(cases.length).toBeGreaterThanOrEqual(16);
  });

  it.each(cases)('%s / %s', (id, mode) => {
    const v = deriveThemeVariables(getRawTheme(id, mode)!, mode);
    const tints = tintsOf(v);
    for (const t of tints) expect(t, 'a tint is a 6-digit hex').toMatch(/^#[0-9a-f]{6}$/);
    for (const t of tints) expect(contrastRatio(v['--ggui-color-onContainer']!, t), `ink on ${t}`).toBeGreaterThanOrEqual(TINT_FLOORS.ink);
    for (const t of tints) expect(dE(t, v['--ggui-color-container']!), `${t} vs container`).toBeGreaterThanOrEqual(TINT_FLOORS.container);
    for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) expect(dE(tints[i]!, tints[j]!), `tint-${i + 1} vs tint-${j + 1}`).toBeGreaterThanOrEqual(TINT_FLOORS.pairwise);
    const states = TINT_STATE_CONTAINERS.filter((n) => v[`--ggui-color-${n}`] !== undefined);
    expect(states.length, 'the theme defines its state containers').toBe(TINT_STATE_CONTAINERS.length);
    for (const n of states) for (const t of tints) expect(dE(t, v[`--ggui-color-${n}`]!), `${t} vs ${n}`).toBeGreaterThanOrEqual(TINT_FLOORS.state);
  });

  it('the ring holds one lightness and one chroma: no category reads as ranked above another', () => {
    for (const [id, mode] of cases) {
      const ls = tintsOf(deriveThemeVariables(getRawTheme(id, mode)!, mode)).map((t) => hexToOklch(t).l);
      expect(Math.max(...ls) - Math.min(...ls), `${id}/${mode}`).toBeLessThan(0.01);
    }
  });
});

describe('the walk is a repair, not an optimiser (ggui#1847)', () => {
  it('a theme that holds the recipe gets it exactly: ggui dark', () => {
    const v = deriveThemeVariables(getRawTheme('ggui', 'dark')!, 'dark');
    expect(tintsOf(v)).toEqual(['#522d1e', '#45360d', '#2c3e1c', '#064237', '#053f4e', '#2a3757', '#422e4e', '#502a38']);
    const states = TINT_STATE_CONTAINERS.map((n) => v[`--ggui-color-${n}`]!);
    const walk = deriveTints(v['--ggui-color-container']!, v['--ggui-color-onContainer']!, states);
    expect({ l: walk.l, c: walk.c, hueBase: walk.hueBase, clears: walk.clears }).toEqual({ l: TINT_RECIPE.darkL, c: TINT_RECIPE.chroma, hueBase: TINT_RECIPE.hueBase, clears: true });
  });

  it('a theme that cannot moves by the least that clears: ggui light, L 0.86 (success container at 3.3 from tint-3 at 0.87)', () => {
    const v = deriveThemeVariables(getRawTheme('ggui', 'light')!, 'light');
    expect(tintsOf(v)).toEqual(['#f4c5b3', '#e2cfa5', '#c3dab1', '#a7ded0', '#a6dbed', '#bfd1f9', '#dec6ee', '#f3c1d1']);
    const states = TINT_STATE_CONTAINERS.map((n) => v[`--ggui-color-${n}`]!);
    const walk = deriveTints(v['--ggui-color-container']!, v['--ggui-color-onContainer']!, states);
    expect({ l: walk.l, c: walk.c, hueBase: walk.hueBase, clears: walk.clears }).toEqual({ l: 0.86, c: 0.06, hueBase: 42, clears: true });
  });

  it('the side follows the container, not the mode: a "light" theme on a dark container takes the dark lightness', () => {
    const v = deriveThemeVariables(getRawTheme('premium-cyberpunk', 'light')!, 'light');
    expect(hexToOklch(v['--ggui-color-container']!).l).toBeLessThan(0.5);
    expect(hexToOklch(tintsOf(v)[0]!).l).toBeLessThan(0.5);
  });

  it('a theme the walk cannot clear still gets eight tints, never a refusal', () => {
    // An ink equal to its own container reads on no tint, so no point on the grid clears.
    const walk = deriveTints('#ffffff', '#ffffff', []);
    expect(walk.tints).toHaveLength(8);
    expect(walk.clears).toBe(false);
    expect({ l: walk.l, c: walk.c, hueBase: walk.hueBase }).toEqual({ l: TINT_RECIPE.lightL, c: TINT_RECIPE.chroma, hueBase: TINT_RECIPE.hueBase });
  });
});

describe('N−1: a stored projection without tints completes to the same eight (ggui#1847)', () => {
  it.each(['ggui', 'claudic', 'premium-zen'])('%s, both schemes', (id) => {
    for (const mode of MODES) {
      const full = deriveThemeVariables(getRawTheme(id, mode)!, mode);
      const older = Object.fromEntries(Object.entries(full).filter(([k]) => !k.startsWith('--ggui-color-tint-')));
      expect(tintsOf(completeThemeVariables(older, mode)), `${id}/${mode}`).toEqual(tintsOf(full));
    }
  });
});

describe('the un-themed fallbacks are the ggui light set (ggui#1847)', () => {
  it('each step\'s fallback hex is the derived ggui light tint', () => {
    const v = deriveThemeVariables(getRawTheme('ggui', 'light')!, 'light');
    for (const step of TINT_STEPS) expect(resolveTintCss(step), step).toBe(`var(--ggui-color-${step}, ${v[`--ggui-color-${step}`]})`);
  });
});

/**
 * The walk screens candidates in OKLab before it builds any hex, and only rejects
 * a point the margin cannot save. Two receipts that the screen never changes the
 * answer: every grid point's emitted hexes sit within the margin of their OKLCH
 * coordinates, and the walk equals a plain walk with no screen and no memo.
 */
describe('the walk\'s speed-ups do not change its answer (ggui#1847)', () => {
  const lab = (l: number, c: number, hDeg: number): [number, number, number] => {
    const h = (hDeg * Math.PI) / 180;
    return [l, c * Math.cos(h), c * Math.sin(h)];
  };

  it('every in-gamut grid point: its emitted hex is within TINT_SCREEN_MARGIN of its coordinates (clamped points are never screened)', () => {
    let worst = 0;
    let clamped = 0;
    let worstClamped = 0;
    const step = (lo: number, hi: number, d: number): number[] => Array.from({ length: Math.round((hi - lo) / d) + 1 }, (_, i) => Math.round((lo + i * d) * 100) / 100);
    const ls = [...step(TINT_SEARCH.lightL[0], TINT_SEARCH.lightL[1], TINT_SEARCH.lStep), ...step(TINT_SEARCH.darkL[0], TINT_SEARCH.darkL[1], TINT_SEARCH.lStep)];
    const cs = step(TINT_SEARCH.chroma[0], TINT_SEARCH.chroma[1], TINT_SEARCH.cStep);
    for (const l of ls) for (const c of cs) for (let dh = -TINT_SEARCH.hueSpread; dh <= TINT_SEARCH.hueSpread; dh += TINT_SEARCH.hueStepDeg) {
      for (let k = 0; k < 8; k++) {
        const h = TINT_RECIPE.hueBase + dh + TINT_RECIPE.hueStep * k;
        const o = hexToOklch(oklchToHex({ l, c, h }));
        const a = lab(l, c, h);
        const b = lab(o.l, o.c, o.h);
        const d = 100 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        if (tintPointInGamut(l, c, h)) worst = Math.max(worst, d);
        else {
          clamped++;
          worstClamped = Math.max(worstClamped, d);
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(TINT_SCREEN_MARGIN);
    // Control: the grid does reach outside sRGB, which is why clamped points are not screened.
    expect(clamped).toBeGreaterThan(0);
    expect(worstClamped).toBeGreaterThan(TINT_SCREEN_MARGIN);
  });

  /** The walk as specified, with nothing skipped and nothing remembered. */
  function plainWalk(container: string, onContainer: string, states: readonly string[]): { l: number; c: number; hueBase: number } {
    const labs = new Map<string, [number, number, number]>();
    const labOf = (hex: string): [number, number, number] => {
      let v = labs.get(hex);
      if (v === undefined) {
        const o = hexToOklch(hex);
        v = lab(o.l, o.c, o.h);
        labs.set(hex, v);
      }
      return v;
    };
    const dE = (a: string, b: string): number => {
      const x = labOf(a);
      const y = labOf(b);
      return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
    };
    const lightSide = hexToOklch(container).l >= 0.5;
    const l0 = lightSide ? TINT_RECIPE.lightL : TINT_RECIPE.darkL;
    const [lMin, lMax] = lightSide ? TINT_SEARCH.lightL : TINT_SEARCH.darkL;
    const cands: { l: number; c: number; k: number; d: number }[] = [];
    for (let i = 0; i <= Math.round((lMax - lMin) / TINT_SEARCH.lStep); i++)
      for (let j = 0; j <= Math.round((TINT_SEARCH.chroma[1] - TINT_SEARCH.chroma[0]) / TINT_SEARCH.cStep); j++)
        for (let k = -11; k <= 11; k++) {
          const l = Math.round((lMin + i * TINT_SEARCH.lStep) * 100) / 100;
          const c = Math.round((TINT_SEARCH.chroma[0] + j * TINT_SEARCH.cStep) * 100) / 100;
          cands.push({ l, c, k, d: Math.round(Math.abs(l - l0) / 0.01) + Math.round(Math.abs(c - 0.06) / 0.01) + Math.abs(k) });
        }
    cands.sort((a, b) => a.d - b.d);
    let best: { l: number; c: number; hueBase: number; state: number } | undefined;
    for (const cand of cands) {
      const hueBase = TINT_RECIPE.hueBase + cand.k * 2;
      const tints = TINT_STEPS.map((_, k) => oklchToHex({ l: cand.l, c: cand.c, h: hueBase + 45 * k }));
      if (Math.min(...tints.map((t) => contrastRatio(onContainer, t))) < TINT_FLOORS.ink) continue;
      if (Math.min(...tints.map((t) => dE(t, container))) < TINT_FLOORS.container) continue;
      let pair = Infinity;
      for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) pair = Math.min(pair, dE(tints[i]!, tints[j]!));
      if (pair < TINT_FLOORS.pairwise) continue;
      const state = Math.min(Infinity, ...states.flatMap((s) => tints.map((t) => dE(t, s))));
      if (state >= TINT_FLOORS.state) return { l: cand.l, c: cand.c, hueBase };
      if (best === undefined || state > best.state) best = { l: cand.l, c: cand.c, hueBase, state };
    }
    return best !== undefined ? { l: best.l, c: best.c, hueBase: best.hueBase } : { l: l0, c: TINT_RECIPE.chroma, hueBase: TINT_RECIPE.hueBase };
  }

  it.each(['ggui', 'claudic', 'premium-zen', 'guuey-brand-v1'])('%s: the walk equals the plain walk, both schemes', (id) => {
    for (const mode of MODES) {
      const v = deriveThemeVariables(getRawTheme(id, mode)!, mode);
      const states = TINT_STATE_CONTAINERS.map((n) => v[`--ggui-color-${n}`]!);
      const w = deriveTints(v['--ggui-color-container']!, v['--ggui-color-onContainer']!, states);
      expect({ l: w.l, c: w.c, hueBase: w.hueBase }, `${id}/${mode}`).toEqual(plainWalk(v['--ggui-color-container']!, v['--ggui-color-onContainer']!, states));
    }
  });

  it('a crowded ring the walk cannot clear: the best partial point equals the plain walk\'s', () => {
    // State containers every 0.06 of lightness and every 20° of hue across the whole dark range.
    const states = Array.from({ length: 5 * 18 }, (_, i) => oklchToHex({ l: 0.26 + Math.floor(i / 18) * 0.06, c: 0.06, h: 20 * (i % 18) }));
    const w = deriveTints('#1f1f1f', '#f4f3ed', states);
    expect(w.clears).toBe(false);
    expect({ l: w.l, c: w.c, hueBase: w.hueBase }).toEqual(plainWalk('#1f1f1f', '#f4f3ed', states));
  });

  it('a surface set walked twice is read back, not walked again', () => {
    const v = deriveThemeVariables(getRawTheme('ggui', 'dark')!, 'dark');
    const states = TINT_STATE_CONTAINERS.map((n) => v[`--ggui-color-${n}`]!);
    expect(deriveTints(v['--ggui-color-container']!, v['--ggui-color-onContainer']!, states)).toBe(deriveTints(v['--ggui-color-container']!, v['--ggui-color-onContainer']!, [...states]));
  });
});
