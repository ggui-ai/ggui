/**
 * Pin (ggui#1043): an app theme's per-mode overlay is COMPLETED from its own
 * colours before it is layered — roles it does not state are derived from what
 * it states, never left to the base ladder. RED fixture: a rep app's overlay
 * as another surface derived it (its stated keys, verbatim) carried no
 * `primaryContainer`, no hero pair and no tone-container pairs; the composer
 * laid it over the default theme, so the app's hero card painted the DEFAULT
 * theme's hero pair and the app's `link` (walked against its own container)
 * read 4.40:1 on a hero ground it never saw.
 */
import { describe, expect, it } from 'vitest';
import { composeThemeCss } from './css-tokens';
import { completeThemeVariables, contrastRatio } from '../themes/derive-theme-variables';

const PRIMARY = {
  '--ggui-color-primary-50': '#fff2ee', '--ggui-color-primary-100': '#ffe0d6', '--ggui-color-primary-200': '#ffc0ab',
  '--ggui-color-primary-300': '#fd8f69', '--ggui-color-primary-400': '#e66537', '--ggui-color-primary-500': '#e45417',
  '--ggui-color-primary-600': '#a93700', '--ggui-color-primary-700': '#862a00', '--ggui-color-primary-800': '#631d00',
  '--ggui-color-primary-900': '#431100',
};
const LIGHT = {
  ...PRIMARY,
  '--ggui-color-ground': '#f4efe6', '--ggui-color-onGround': '#141914',
  '--ggui-color-container': '#f4efe6', '--ggui-color-onContainer': '#141914',
  '--ggui-color-sunken': '#e8e1d5', '--ggui-color-onSunken': '#5b5e59',
  '--ggui-color-elevated': '#f4efe6', '--ggui-color-onElevated': '#141914',
  '--ggui-color-outline': '#aeaca3', '--ggui-color-outlineVariant': '#cbc8bf',
  '--ggui-color-link': '#b83e12', '--ggui-color-onPrimary': '#141914',
};
const DARK = {
  ...PRIMARY,
  '--ggui-color-ground': '#141914', '--ggui-color-onGround': '#f4efe6',
  '--ggui-color-container': '#141914', '--ggui-color-onContainer': '#f4efe6',
  '--ggui-color-sunken': '#2a302a', '--ggui-color-onSunken': '#b7b3aa',
  '--ggui-color-elevated': '#222721', '--ggui-color-onElevated': '#f4efe6',
  '--ggui-color-outline': '#4a4d46', '--ggui-color-outlineVariant': '#32362f',
  '--ggui-color-link': '#f08a5d', '--ggui-color-onPrimary': '#141914',
};

/** The LAST declaration of a variable in the composed CSS — the one that paints. */
function painted(css: string, name: string): string | undefined {
  const all = [...css.matchAll(new RegExp(`--ggui-color-${name}:\\s*([^;}]+)`, 'g'))];
  return all.length > 0 ? all[all.length - 1]![1]!.trim() : undefined;
}

describe('an app overlay is completed from its own colours (ggui#1043)', () => {
  it('light: the hero pair is the overlay\'s primary container pair, not the base theme\'s; the accent on it clears 4.5:1', () => {
    const css = composeThemeCss({ layer: 'page', mode: 'light', appTheme: { overlays: { light: LIGHT } } });
    expect(painted(css, 'primaryContainer')).toBe('#ffe0d6');
    expect(painted(css, 'onPrimaryContainer')).toBe('#431100');
    expect(painted(css, 'heroGround')).toBe('#ffe0d6');
    expect(painted(css, 'heroGround')).not.toBe('#ebe9e1'); // the default theme's — what painted before
    expect(painted(css, 'onHeroGround')).toBe('#431100');
    expect(contrastRatio(painted(css, 'heroLink')!, painted(css, 'heroGround')!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(painted(css, 'inverseLink')!, '#141914')).toBeGreaterThanOrEqual(4.5);
    expect(painted(css, 'link')).toBe('#b83e12'); // stated, never overridden
  });

  it('dark: the hero ground is the overlay\'s ink pair; the accent walked against that LIGHT ground clears 4.5:1 (the 4.40:1 RED)', () => {
    const css = composeThemeCss({ layer: 'page', mode: 'dark', appTheme: { overlays: { dark: DARK } } });
    expect(painted(css, 'heroGround')).toBe('#f4efe6');
    expect(painted(css, 'heroGround')).not.toBe('#3d3d3d'); // the default theme's — what painted before
    expect(painted(css, 'onHeroGround')).toBe('#141914');
    expect(painted(css, 'primaryContainer')).toBe('#631d00');
    const heroLink = painted(css, 'heroLink')!;
    expect(contrastRatio(heroLink, '#f4efe6')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#f08a5d', '#f4efe6')).toBeLessThan(4.5); // the stated link alone would not
    expect(painted(css, 'link')).toBe('#f08a5d');
  });

  it('the tree layer completes the same way; an overlay without surfaces is left to the ladder', () => {
    const tree = composeThemeCss({ layer: 'tree', scopeClass: 's', mode: 'light', appTheme: { overlays: { light: LIGHT } } });
    expect(painted(tree, 'heroGround')).toBe('#ffe0d6');
    const bare = completeThemeVariables({ '--ggui-color-primary-500': '#e45417' }, 'light');
    expect(bare).toEqual({ '--ggui-color-primary-500': '#e45417' });
    const stated = completeThemeVariables({ ...LIGHT, '--ggui-color-heroGround': '#123456', '--ggui-color-onHeroGround': '#ffffff' }, 'light');
    expect(stated['--ggui-color-heroGround']).toBe('#123456');
  });
});
