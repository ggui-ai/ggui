import { describe, expect, it } from 'vitest';
import { getCssTokens, getThemeCss } from '@ggui-ai/design/rendering';
import { getDefaultThemeId, getThemeIds } from '@ggui-ai/design/themes';
import type { AppTheme } from '@ggui-ai/protocol';
import { cssTokensForAppTheme } from './theme-css.js';

// A VALID `AppTheme` (the schema's required `overlayHash` + both mode projections) — the composer never recomputes the hash.
const THEME: AppTheme = {
  overlayHash: 'ab'.repeat(32),
  overlays: { light: { '--ggui-color-onContainer': '#ffffff', '--ggui-color-ground': '#ffffff' }, dark: { '--ggui-color-onContainer': '#0a0a0a' } },
  cssVariables: { '--ggui-shape-radius-md': '6px' },
};
const DARK: AppTheme = { ...THEME, mode: 'dark' };

describe('cssTokensForAppTheme — the judge paints the app\'s tokens', () => {
  it('absent theme ⇒ the default tokens, byte-for-byte what the judge used before', () => {
    expect(cssTokensForAppTheme(undefined)).toBe(getCssTokens('light'));
    expect(cssTokensForAppTheme(undefined, 'dark')).toBe(getCssTokens('dark'));
  });
  it("a theme whose ink role equals its ground reaches the shell's CSS (the case a default-token judge could not see)", () => {
    const css = cssTokensForAppTheme(THEME);
    expect(css.startsWith(getCssTokens('light'))).toBe(true);
    // ggui#1083: the composer completes the overlay before painting — a ground it carries
    // completes the scrim's tint (the ground the judge's page sits the card on).
    expect(css).toContain(':root{color-scheme:light;--ggui-color-onContainer: #ffffff;--ggui-color-ground: #ffffff;--ggui-scrim-tint: #ffffff;--ggui-shape-radius-md: 6px;}');
  });
  it("the theme's own mode wins over the caller's", () => {
    const dark = cssTokensForAppTheme(DARK, 'light');
    expect(dark).toContain('color-scheme:dark;--ggui-color-onContainer: #0a0a0a;');
  });

  // #1023 — a preset-themed app paints its overlay ON its registered ladder; the judge composes the same base.
  const PRESET = getThemeIds().find((id) => id !== getDefaultThemeId());
  it('a preset ladder alone composes that ladder, not the default tokens', () => {
    if (PRESET === undefined) throw new Error('the theme registry names no non-default theme');
    const css = cssTokensForAppTheme(undefined, 'light', PRESET);
    expect(css.startsWith(getThemeCss(PRESET, 'light'))).toBe(true);
    expect(css).not.toBe(getCssTokens('light'));
  });
  it('the overlay composes on the preset ladder, with the same overlay layer as before', () => {
    if (PRESET === undefined) throw new Error('the theme registry names no non-default theme');
    const css = cssTokensForAppTheme(THEME, 'light', PRESET);
    expect(css.startsWith(getThemeCss(PRESET, 'light'))).toBe(true);
    expect(css).toContain(':root{color-scheme:light;--ggui-color-onContainer: #ffffff;--ggui-color-ground: #ffffff;');
  });
  it('an unknown ladder id composes the default ladder and never throws', () => {
    expect(cssTokensForAppTheme(undefined, 'light', 'no-such-theme').startsWith(getThemeCss(getDefaultThemeId(), 'light'))).toBe(true);
  });
});
