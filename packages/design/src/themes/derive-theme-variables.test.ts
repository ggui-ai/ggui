import { describe, it, expect } from 'vitest';
import { deriveThemeVariables, hexToOklch, oklchToHex } from './derive-theme-variables';
import { consumedTokenManifest } from './consumed-tokens';
import { NON_THEME_DEFINABLE_TOKENS } from './validate-overlay-coverage';
import { lightTheme } from './defaults/light';
import { darkTheme } from './defaults/dark';

const required = () => consumedTokenManifest.filter((t) => !NON_THEME_DEFINABLE_TOKENS.includes(t)).sort();

describe('deriveThemeVariables — the ONE producer (ggui#987 §2.4)', () => {
  it('over the DEFAULT document, both modes, the output is EXACTLY the manifest minus the floor', () => {
    for (const [doc, mode] of [[lightTheme, 'light'], [darkTheme, 'dark']] as const) {
      const out = deriveThemeVariables(doc, mode);
      expect(Object.keys(out).sort()).toEqual(required());
    }
  });

  it('is a pure function: same document + mode → identical map (property over both registry defaults)', () => {
    for (const [doc, mode] of [[lightTheme, 'light'], [darkTheme, 'dark']] as const) {
      expect(deriveThemeVariables(doc, mode)).toEqual(deriveThemeVariables(doc, mode));
    }
  });

  it('every colour is 6-digit lowercase hex; every name is a --ggui-* token', () => {
    const out = deriveThemeVariables(lightTheme, 'light');
    for (const [k, v] of Object.entries(out)) {
      expect(k).toMatch(/^--ggui-[a-zA-Z0-9-]+$/);
      if (k.startsWith('--ggui-color-')) expect(v).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('link: unstated → primary-600; stated → the stated value wins, never an alias appended over it', () => {
    const unstated = deriveThemeVariables(lightTheme, 'light');
    expect(unstated['--ggui-color-link']).toBe(unstated['--ggui-color-primary-600']);
    const stated = deriveThemeVariables({ ...lightTheme, color: { ...lightTheme.color, link: { $type: 'color', $value: '#123456' } } }, 'light');
    expect(stated['--ggui-color-link']).toBe('#123456');
  });

  it('flat error is the error-500 stop', () => {
    const out = deriveThemeVariables(lightTheme, 'light');
    expect(out['--ggui-color-error']).toBe(out['--ggui-color-error-500']);
  });

  it('elevated: light = container; dark = container mixed 8% toward onContainer; onElevated = onContainer', () => {
    const l = deriveThemeVariables(lightTheme, 'light');
    expect(l['--ggui-color-elevated']).toBe(l['--ggui-color-container']);
    expect(l['--ggui-color-onElevated']).toBe(l['--ggui-color-onContainer']);
    const d = deriveThemeVariables(darkTheme, 'dark');
    expect(d['--ggui-color-elevated']).not.toBe(d['--ggui-color-container']);
    expect(hexToOklch(d['--ggui-color-elevated']!).l).toBeGreaterThan(hexToOklch(d['--ggui-color-container']!).l);
  });

  it('a synthesised ramp is monotone in lightness from 50 (lightest) to 900 (darkest) around the stated 500', () => {
    const anchor = '#3b82f6';
    const out = deriveThemeVariables({ ...lightTheme, color: { ...lightTheme.color, primary: { '500': { $type: 'color', $value: anchor } } } }, 'light');
    expect(out['--ggui-color-primary-500']).toBe(anchor);
    const ls = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900'].map((s) => hexToOklch(out[`--ggui-color-primary-${s}`]!).l);
    for (let i = 1; i < ls.length; i++) expect(ls[i]!).toBeLessThan(ls[i - 1]!);
  });

  it('font sizes come from the ramp exponent table when a ramp is stated', () => {
    const out = deriveThemeVariables({ ...lightTheme, font: { ...lightTheme.font, ramp: { base: { $type: 'dimension', $value: '1rem' }, ratio: { $type: 'number', $value: 1.25 } } } }, 'light');
    expect(out['--ggui-font-size-base']).toBe('1rem');
    expect(out['--ggui-font-size-lg']).toBe('1.25rem');
    expect(out['--ggui-font-size-xs']).toBe('0.64rem');
    expect(out['--ggui-font-size-4xl']).toBe('3.052rem');
  });

  it('OKLCH round-trips hex within one step', () => {
    for (const hex of ['#000000', '#ffffff', '#3b82f6', '#b91c1c', '#0f172a']) {
      const back = oklchToHex(hexToOklch(hex));
      const d = (a: string, b: string) => Math.abs(parseInt(a.slice(1, 3), 16) - parseInt(b.slice(1, 3), 16)) + Math.abs(parseInt(a.slice(3, 5), 16) - parseInt(b.slice(3, 5), 16)) + Math.abs(parseInt(a.slice(5, 7), 16) - parseInt(b.slice(5, 7), 16));
      expect(d(hex, back)).toBeLessThanOrEqual(3);
    }
  });
});
