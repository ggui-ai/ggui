import { describe, expect, it } from 'vitest';
import { getCssTokens } from '@ggui-ai/design/rendering';
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
    expect(css).toContain(':root{color-scheme:light;--ggui-color-onContainer: #ffffff;--ggui-color-ground: #ffffff;--ggui-shape-radius-md: 6px;}');
  });
  it("the theme's own mode wins over the caller's", () => {
    const dark = cssTokensForAppTheme(DARK, 'light');
    expect(dark).toContain('color-scheme:dark;--ggui-color-onContainer: #0a0a0a;');
  });
});
