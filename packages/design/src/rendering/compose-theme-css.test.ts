import { describe, expect, it } from 'vitest';
import { composeThemeCss, getCssTokens, getScopedCssTokens, toCssDecls } from './css-tokens';

const APP = {
  overlays: { light: { '--ggui-color-onContainer': '#ffffff', '--ggui-color-primary-500': '#006c60' }, dark: { '--ggui-color-onContainer': '#111111' } },
  cssVariables: { '--ggui-shape-radius-md': '4px' },
  keyframes: { light: '@keyframes ggui-pulse{from{opacity:0}to{opacity:1}}' },
};

describe('composeThemeCss — one composition, three callers', () => {
  it("'tree' = scoped ladder < hostPalette < overlays[mode] < cssVariables < overrides, then keyframes (+ frameless)", () => {
    const css = composeThemeCss({ layer: 'tree', scopeClass: 's1', mode: 'light', hostPalette: { '--ggui-color-ground': '#fafafa' }, appTheme: { ...APP, frameless: true }, cssOverrides: '.s1 h1{margin:0}' });
    const base = getScopedCssTokens('s1', 'light');
    expect(css.startsWith(base)).toBe(true);
    const rest = css.slice(base.length);
    const order = [
      '.s1{--ggui-color-ground: #fafafa;}',
      '.s1{--ggui-color-onContainer: #ffffff;--ggui-color-primary-500: #006c60;}',
      '.s1{--ggui-shape-radius-md: 4px;}',
      '.s1 h1{margin:0}',
      APP.keyframes.light,
    ];
    let cursor = 0;
    for (const part of order) {
      const at = rest.indexOf(part, cursor);
      expect(at).toBeGreaterThanOrEqual(cursor);
      cursor = at + part.length;
    }
    expect(rest.slice(cursor)).toContain('s1');
    expect(() => composeThemeCss({ layer: 'tree', appTheme: APP })).toThrow(/scopeClass/);
  });

  it("'chrome' = the :root ladder + color-scheme + the variable layers, no keyframes; 'page' = chrome + the mode's keyframes", () => {
    const chrome = composeThemeCss({ layer: 'chrome', mode: 'light', appTheme: APP });
    expect(chrome.startsWith(getCssTokens('light'))).toBe(true);
    expect(chrome.endsWith(`:root{color-scheme:light;${toCssDecls(APP.overlays.light)}${toCssDecls(APP.cssVariables)}}`)).toBe(true);
    expect(chrome).not.toContain(APP.keyframes.light);
    const page = composeThemeCss({ layer: 'page', mode: 'light', appTheme: APP });
    expect(page).toBe(chrome + APP.keyframes.light);
    const dark = composeThemeCss({ layer: 'page', mode: 'dark', appTheme: APP });
    expect(dark).toContain('color-scheme:dark;--ggui-color-onContainer: #111111;');
    expect(dark.endsWith('}')).toBe(true);
  });

  it("the declarations the tree paints and the page paints are the SAME map for a fixture theme (the judge sees the visitor's tokens)", () => {
    const decls = (css: string): Map<string, string> => {
      const m = new Map<string, string>();
      for (const match of css.matchAll(/(--ggui-[a-zA-Z0-9-]+):\s*([^;}]+);/g)) m.set(match[1]!, match[2]!.trim());
      return m;
    };
    const tree = decls(composeThemeCss({ layer: 'tree', scopeClass: 's1', mode: 'light', appTheme: APP }));
    const page = decls(composeThemeCss({ layer: 'page', mode: 'light', appTheme: APP }));
    expect(tree.get('--ggui-color-onContainer')).toBe('#ffffff');
    expect(page.get('--ggui-color-onContainer')).toBe('#ffffff');
    // Every declaration the page paints, the tree paints with the same value (the scoped ladder adds
    // its scope scaffolding on top — the page never lacks a token the tree has a value for).
    for (const [k, v] of page) expect(tree.get(k)).toBe(v);
    for (const k of Object.keys(APP.overlays.light)) expect(tree.get(k)).toBe(page.get(k));
  });

  it('no app theme ⇒ chrome is the ladder plus a bare color-scheme block', () => {
    expect(composeThemeCss({ layer: 'chrome', mode: 'light' })).toBe(`${getCssTokens('light')}:root{color-scheme:light;}`);
  });
});
