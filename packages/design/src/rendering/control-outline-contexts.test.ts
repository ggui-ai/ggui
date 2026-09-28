/**
 * Pin (ggui#1494): every producer that writes the `--ggui-*` block a card renders under declares
 * the control edges, resolved to a colour that clears 3:1 on the container that same block
 * declares. Each render context reads one of these producers — the host iframe and the `/r/` shell
 * through the iframe runtime's `composeThemeCss`, the visual judge through `composeThemeCss` /
 * `getCssTokens`, the in-host renderer (the dev-stack preview) through `getScopedThemeCss` /
 * `getScopedCssTokens`. A stored app theme predates the keys, so its overlay is written here
 * WITHOUT them: the page and tree layers must complete them from the overlay's own container pair.
 */
import { describe, expect, it } from 'vitest';
import { composeThemeCss, getCssTokens, getScopedCssTokens, getScopedThemeCss, getThemeCss } from './css-tokens';
import { getThemeIds, getRawTheme } from '../themes/registry';
import { contrastRatio, deriveThemeVariables } from '../themes/derive-theme-variables';

const MODES = ['light', 'dark'] as const;

/** The LAST declaration of a colour role in the composed CSS — the one that paints. */
function painted(css: string, name: string): string | undefined {
  const all = [...css.matchAll(new RegExp(`--ggui-color-${name}:\\s*([^;}]+)`, 'g'))];
  return all.length > 0 ? all[all.length - 1]![1]!.trim() : undefined;
}

function expectResolvedEdges(css: string, label: string): void {
  const container = painted(css, 'container');
  expect(container, `${label}: container`).toMatch(/^#[0-9a-f]{6}$/i);
  for (const key of ['controlOutline', 'controlAccentOutline'] as const) {
    const value = painted(css, key);
    expect(value, `${label}: ${key} declared as a colour`).toMatch(/^#[0-9a-f]{6}$/i);
    expect(contrastRatio(value!, container!), `${label}: ${key} on the container`).toBeGreaterThanOrEqual(3);
  }
}

const STORED_THEME = 'guuey-brand-v1';

/** A stored overlay as a projector before ggui#1494 wrote it: every derived key but the control edges. */
function storedOverlay(mode: 'light' | 'dark'): Record<string, string> {
  const full: Record<string, string> = { ...deriveThemeVariables(getRawTheme(STORED_THEME, mode)!, mode) };
  delete full['--ggui-color-controlOutline'];
  delete full['--ggui-color-controlAccentOutline'];
  return full;
}

/**
 * Completion, not the ladder beneath it: the default theme's own edges also clear 3:1 on this
 * overlay's container, so a floor check alone passes with completion removed (the control run
 * that bought this line). The painted edges must be the overlay's OWN derivation.
 */
function expectCompletedFromOverlay(css: string, mode: 'light' | 'dark', label: string): void {
  expectResolvedEdges(css, label);
  const own = deriveThemeVariables(getRawTheme(STORED_THEME, mode)!, mode);
  const ladder = deriveThemeVariables(getRawTheme('ggui', mode)!, mode);
  for (const key of ['controlOutline', 'controlAccentOutline'] as const) {
    expect(own[`--ggui-color-${key}`], `${label}: ${key} discriminates overlay from ladder`).not.toBe(ladder[`--ggui-color-${key}`]);
    expect(painted(css, key), `${label}: ${key} is the overlay's own`).toBe(own[`--ggui-color-${key}`]);
  }
}

describe('every token producer declares resolved control edges (ggui#1494)', () => {
  for (const mode of MODES) {
    it(`${mode}: the default ladder (getCssTokens / getScopedCssTokens)`, () => {
      expectResolvedEdges(getCssTokens(mode), `getCssTokens ${mode}`);
      expectResolvedEdges(getScopedCssTokens('s', mode), `getScopedCssTokens ${mode}`);
    });

    it(`${mode}: every registered theme (getThemeCss / getScopedThemeCss)`, () => {
      for (const id of getThemeIds()) {
        expectResolvedEdges(getThemeCss(id, mode), `getThemeCss ${id} ${mode}`);
        expectResolvedEdges(getScopedThemeCss(id, 's', mode), `getScopedThemeCss ${id} ${mode}`);
      }
    });

    it(`${mode}: a stored app overlay without the keys completes them (composeThemeCss, page and tree layers)`, () => {
      const overlays = { [mode]: storedOverlay(mode) };
      expectCompletedFromOverlay(composeThemeCss({ layer: 'page', mode, appTheme: { overlays } }), mode, `composeThemeCss page ${mode}`);
      expectCompletedFromOverlay(composeThemeCss({ layer: 'tree', scopeClass: 's', mode, appTheme: { overlays } }), mode, `composeThemeCss tree ${mode}`);
    });
  }
});
