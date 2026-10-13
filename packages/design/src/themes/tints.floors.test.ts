/**
 * ggui#1847 — the categorical tints. Every shipped theme, in both schemes,
 * carries eight tints that clear four floors: the theme's ink on every tint,
 * a visible fill on the container, eight distinct tints, and no tint read as a
 * state container. The floors are re-measured here from the emitted tokens, not
 * read back from the walk's own report.
 */
import { describe, expect, it } from 'vitest';
import { TINT_STEPS } from '../primitives/color-slots';
import {
  TINT_FLOORS,
  TINT_RECIPE,
  TINT_STATE_CONTAINERS,
  completeThemeVariables,
  contrastRatio,
  deriveThemeVariables,
  deltaEOk,
  deriveTints,
  hexToOklch,
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
