import { describe, expect, it } from 'vitest';
import { composeThemeCss, fillFitRule, getCssTokens, getScopedCssTokens, toCssDecls } from './css-tokens';

const APP = {
  overlays: { light: { '--ggui-color-onContainer': '#ffffff', '--ggui-color-primary-500': '#006c60' }, dark: { '--ggui-color-onContainer': '#111111' } },
  cssVariables: { '--ggui-shape-radius-md': '4px' },
  keyframes: { light: '@keyframes ggui-pulse{from{opacity:0}to{opacity:1}}' },
};

describe('composeThemeCss — one composition, three callers', () => {
  it("'tree' + fit: 'fill' ends with the fill rule (ggui#1041: the host's canvas is the chrome); chrome / page ignore fit", () => {
    const tree = composeThemeCss({ layer: 'tree', scopeClass: 's9', mode: 'light', appTheme: APP, fit: 'fill' });
    expect(tree.endsWith(fillFitRule('s9'))).toBe(true);
    expect(tree.indexOf(APP.keyframes.light)).toBeLessThan(tree.indexOf(fillFitRule('s9')));
    expect(composeThemeCss({ layer: 'tree', scopeClass: 's9', mode: 'light', appTheme: APP })).not.toContain('border-radius: 0 !important');
    expect(composeThemeCss({ layer: 'page', mode: 'light', appTheme: APP, fit: 'fill' })).not.toContain('border-radius: 0 !important');
  });

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

  it("the DECLARED faces ride the document-level layers only (ggui#1093): page + chrome carry the @font-face rules, the scoped tree does not, absent ⇒ byte-identical", () => {
    const FACES = [
      { family: 'Neue Montreal', src: 'https://fonts.example.com/nm-400.woff2', weight: 400 },
      { family: 'Neue Montreal', src: 'https://fonts.example.com/nm-700.woff2', weight: 700, style: 'normal', display: 'swap' },
    ];
    const themed = { ...APP, fonts: FACES };
    const page = composeThemeCss({ layer: 'page', mode: 'light', appTheme: themed });
    const chrome = composeThemeCss({ layer: 'chrome', mode: 'light', appTheme: themed });
    for (const css of [page, chrome]) {
      expect(css).toContain("@font-face { font-family: 'Neue Montreal'; src: url('https://fonts.example.com/nm-400.woff2') format('woff2'); font-weight: 400; }");
      expect(css).toContain("src: url('https://fonts.example.com/nm-700.woff2') format('woff2'); font-weight: 700; font-style: normal; font-display: swap;");
    }
    // The at-rule is document-level: the SCOPED block never carries it (the runtime injects
    // both blocks into one document — emitting it twice would duplicate every face).
    expect(composeThemeCss({ layer: 'tree', scopeClass: 's7', mode: 'light', appTheme: themed })).not.toContain('@font-face');
    // Absent / empty ⇒ exactly the CSS composed before the member existed (INVARIANT 1).
    expect(composeThemeCss({ layer: 'page', mode: 'light', appTheme: { ...APP, fonts: [] } })).toBe(composeThemeCss({ layer: 'page', mode: 'light', appTheme: APP }));
    expect(chrome.indexOf('@font-face')).toBeGreaterThan(chrome.indexOf('color-scheme:light'));
  });

  it('a face the grammar cannot render costs that FACE, never the composition (ggui#1110 — the door refuses, the composer skips)', () => {
    const themed = {
      ...APP,
      fonts: [
        { family: 'Good Sans', src: 'https://fonts.example.com/good.woff2' },
        { family: 'Insecure', src: 'http://fonts.example.com/bad.woff2' },
        { family: 'No Host', src: 'https://localhost/bad.woff2' },
      ],
    };
    const page = composeThemeCss({ layer: 'page', mode: 'light', appTheme: themed });
    expect(page).toContain("font-family: 'Good Sans'");
    expect(page).not.toContain('Insecure');
    expect(page).not.toContain('No Host');
    // Every face unrenderable ⇒ no @font-face block at all, and still no throw.
    const allBad = composeThemeCss({ layer: 'page', mode: 'light', appTheme: { ...APP, fonts: [{ family: 'x', src: 'data:font/woff2;base64,AA' }] } });
    expect(allBad).not.toContain('@font-face');
  });

  it('no app theme ⇒ chrome is the ladder plus a bare color-scheme block', () => {
    expect(composeThemeCss({ layer: 'chrome', mode: 'light' })).toBe(`${getCssTokens('light')}:root{color-scheme:light;}`);
  });
});

describe('fillFitRule (ggui#1041 / #1073)', () => {
  it('anchors the scope on the frame (100vh, flex column), zeroes the chain above it, strips the root, and reaches an only-child surface through a wrapper', () => {
    const rule = fillFitRule('ggui-rcr-9');
    expect(rule).toContain('.ggui-rcr-9 { min-height: 100vh; display: flex; flex-direction: column; }');
    expect(rule).toContain(':has(> .ggui-rcr-9) { margin: 0; padding: 0; list-style: none; }');
    expect(rule).toContain('html:has(.ggui-rcr-9), html:has(.ggui-rcr-9) body { margin: 0; }');
    expect(rule).toContain('.ggui-rcr-9 > :where(:not(style)) { border: none !important; border-radius: 0 !important; box-shadow: none !important; margin: 0 !important; max-width: none !important; flex: 1 1 auto; }');
    expect(rule).toContain('.ggui-rcr-9 > :where(:not(style)):has(> :only-child) { display: flex; flex-direction: column; padding: 0 !important; }');
    expect(rule).toContain('.ggui-rcr-9 > :where(:not(style)) > :where(:only-child) { border: none !important; border-radius: 0 !important; box-shadow: none !important; min-height: 0 !important; flex: 1 1 auto; }');
    // Never a percentage height anywhere in the chain — that was the 414-of-836 bug.
    expect(rule).not.toContain('min-height: 100%');
    // Under fill the frame decides the height: a cell's own `min-height: 100vh` on the surface is overridden (ggui#1096: 884 in an 836 frame).
    expect(rule).toContain('min-height: 0 !important');
  });
});
