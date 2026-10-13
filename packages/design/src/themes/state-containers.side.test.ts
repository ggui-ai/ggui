/**
 * ggui#1848 — an unstated state container sits on the theme's own side. Every
 * shipped dark scheme writes its status ramps the dark way round (100 dark, 800
 * light), and the derivation used to take "dark → 800", so a dark page got light
 * success / warning / info chips, and a dark-container "light" scheme got inks
 * at 1.7:1. A stated container is the theme's word and is not judged here.
 */
import { describe, expect, it } from 'vitest';
import { completeThemeVariables, contrastRatio, deriveThemeVariables, hexToOklch } from './derive-theme-variables';
import { getRawTheme, getThemeIds } from './registry';

const FAMILIES = ['error', 'warning', 'success', 'info', 'tertiary', 'primary'] as const;
const MODES = ['light', 'dark'] as const;
const cap = (f: string): string => f[0]!.toUpperCase() + f.slice(1);
const isLight = (hex: string): boolean => hexToOklch(hex).l >= 0.5;

describe('unstated state containers sit on the container side (ggui#1848)', () => {
  const cases = getThemeIds().flatMap((id) => MODES.map((mode) => [id, mode] as const));

  it('covers every shipped theme, and the side reading is right on known colours', () => {
    expect(cases.length).toBeGreaterThanOrEqual(16);
    expect(isLight('#ffffff')).toBe(true);
    expect(isLight('#000000')).toBe(false);
  });

  it.each(cases)('%s / %s', (id, mode) => {
    const doc = getRawTheme(id, mode)!;
    const stated = doc.color as Readonly<Record<string, unknown>>;
    const v = deriveThemeVariables(doc, mode);
    const side = isLight(v['--ggui-color-container']!);
    for (const fam of FAMILIES) {
      if (stated[`${fam}Container`] !== undefined) continue;
      const c = v[`--ggui-color-${fam}Container`]!;
      const ink = v[`--ggui-color-on${cap(fam)}Container`]!;
      expect(isLight(c), `${fam}Container ${c} on a ${side ? 'light' : 'dark'} container`).toBe(side);
      expect(contrastRatio(c, ink), `on${cap(fam)}Container ${ink} on ${c}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('ggui dark: the three unauthored chips are the dark ends of its own ramps, inked with the light ends', () => {
    const v = deriveThemeVariables(getRawTheme('ggui', 'dark')!, 'dark');
    expect([v['--ggui-color-successContainer'], v['--ggui-color-onSuccessContainer']]).toEqual(['#174f2a', '#cdead3']);
    expect([v['--ggui-color-warningContainer'], v['--ggui-color-onWarningContainer']]).toEqual(['#5e4612', '#f5deb8']);
    expect([v['--ggui-color-infoContainer'], v['--ggui-color-onInfoContainer']]).toEqual(['#5a5a5a', '#f0f0f0']);
  });

  it('a stated container is the theme\'s word: premium-cyberpunk dark keeps its primaryContainer', () => {
    const v = deriveThemeVariables(getRawTheme('premium-cyberpunk', 'dark')!, 'dark');
    expect(v['--ggui-color-primaryContainer']).toBe('#0e7490');
  });

  it('a stored projection without its container pairs completes to the same pairs', () => {
    for (const [id, mode] of cases) {
      const full = deriveThemeVariables(getRawTheme(id, mode)!, mode);
      const older = Object.fromEntries(Object.entries(full).filter(([k]) => !/Container$/.test(k) || k === '--ggui-color-container' || k === '--ggui-color-onContainer'));
      const done = completeThemeVariables(older, mode);
      for (const fam of ['warning', 'success', 'info'] as const) {
        expect(done[`--ggui-color-${fam}Container`], `${id}/${mode} ${fam}`).toBe(full[`--ggui-color-${fam}Container`]);
        expect(done[`--ggui-color-on${cap(fam)}Container`], `${id}/${mode} on ${fam}`).toBe(full[`--ggui-color-on${cap(fam)}Container`]);
      }
    }
  });
});
