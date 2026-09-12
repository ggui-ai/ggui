/**
 * Pin (ggui#1031 L2 — the hero ground): `surface="hero"` paints the theme's
 * derived hero pair — light host → the primary container pair, dark host →
 * the ink pair — and owns its subtree's inks like `inverted`; the pair reads
 * at ≥ 4.5:1 on every registry theme × mode; `inverted` is byte-identical to
 * before (its scope rule is unchanged by the generalisation).
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Card } from '../Card';
import { Box } from '../Box';
import { HERO_SCOPE_CLASS, HERO_SCOPE_CSS, INVERTED_SCOPE_CLASS, INVERTED_SCOPE_CSS, resolveSurfaceCss, resolveSurfaceOnColorCss } from '../color-slots';
import { getThemeIds, getRawTheme } from '../../themes/registry';
import { contrastRatio, deriveThemeVariables } from '../../themes/derive-theme-variables';

describe('surface="hero" (ggui#1031 L2)', () => {
  it('resolves the hero pair; inverted unchanged', () => {
    expect(resolveSurfaceCss('hero')).toBe('var(--ggui-color-heroGround, #e0f2fe)');
    expect(resolveSurfaceOnColorCss('hero')).toBe('var(--ggui-color-onHeroGround, #0c4a6e)');
    expect(resolveSurfaceCss('inverted')).toBe('var(--ggui-color-onContainer, #18181b)');
    expect(resolveSurfaceOnColorCss('inverted')).toBe('var(--ggui-color-onInverted, var(--ggui-color-container, #ffffff))');
    expect(INVERTED_SCOPE_CSS).toContain(
      `.${INVERTED_SCOPE_CLASS}{--ggui-surface-inverted-bg:var(--ggui-color-onContainer, #18181b);--ggui-surface-inverted-ink:var(--ggui-color-container, #ffffff);--ggui-color-onInverted:var(--ggui-color-container, #ffffff)}`,
    );
    expect(HERO_SCOPE_CSS).toContain(
      `.${HERO_SCOPE_CLASS}{--ggui-surface-hero-bg:var(--ggui-color-heroGround, #e0f2fe);--ggui-surface-hero-ink:var(--ggui-color-onHeroGround, #0c4a6e);--ggui-color-onInverted:var(--ggui-color-onHeroGround, #0c4a6e)}`,
    );
    expect(HERO_SCOPE_CSS).toContain(`.${HERO_SCOPE_CLASS}>*{--ggui-color-container:var(--ggui-surface-hero-bg);--ggui-color-onContainer:var(--ggui-surface-hero-ink);`);
  });
  it('the scopes remap `link` to an accent walked against THEIR ground (ggui#1043)', () => {
    expect(HERO_SCOPE_CSS).toContain('--ggui-color-link:var(--ggui-color-heroLink, var(--ggui-color-onHeroGround, #0c4a6e))}');
    expect(INVERTED_SCOPE_CSS).toContain('--ggui-color-link:var(--ggui-color-inverseLink, var(--ggui-color-container, #ffffff))}');
  });

  it('Card / Box hero roots carry the scope class, the rule and the on-colour', () => {
    for (const html of [renderToStaticMarkup(<Card surface="hero">hi</Card>), renderToStaticMarkup(<Box surface="hero">hi</Box>)]) {
      expect(html).toContain(HERO_SCOPE_CLASS);
      expect(html).toContain(`<style>${HERO_SCOPE_CSS}</style>`);
      expect(html).toContain('var(--ggui-color-heroGround, #e0f2fe)');
      expect(html).toContain('color:var(--ggui-color-onHeroGround, #0c4a6e)');
    }
    expect(renderToStaticMarkup(<Card surface="inverted">x</Card>)).toContain(`<style>${INVERTED_SCOPE_CSS}</style>`);
  });
  for (const id of getThemeIds()) {
    for (const mode of ['light', 'dark'] as const) {
      it(`${id} ${mode}: the derived hero pair reads at ≥ 4.5:1 and follows the host's darkness`, () => {
        const v = deriveThemeVariables(getRawTheme(id, mode)!, mode);
        const bg = v['--ggui-color-heroGround']!;
        const ink = v['--ggui-color-onHeroGround']!;
        expect(contrastRatio(ink, bg)).toBeGreaterThanOrEqual(4.5);
        if (mode === 'light') expect(bg).toBe(v['--ggui-color-primaryContainer']);
        else expect(bg).toBe(v['--ggui-color-onContainer']);
      });
    }
  }
});
