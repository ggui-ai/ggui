/**
 * Pin (ggui#1019): an `inverted` surface OWNS its on-colour. The inverted
 * background is the ink role (`--ggui-color-onContainer`), so a Card or
 * Box with `surface="inverted"` must set the `inverse` ink
 * (`--ggui-color-container`) on its root — otherwise inherited text is
 * ink-on-ink under any theme where the page ink equals that role (rendered
 * rgb(26,26,26) on rgb(26,26,26) in the field; readable under the default
 * tokens, which is why no local check caught it). Every other surface keeps
 * the page ink.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Card } from '../Card';
import { Box } from '../Box';
import { resolveSurfaceOnColorCss } from '../color-slots';

describe('inverted surface owns its on-colour (ggui#1019)', () => {
  it('resolveSurfaceOnColorCss: inverted → the inverse ink; every other surface → undefined', () => {
    expect(resolveSurfaceOnColorCss('inverted')).toBe('var(--ggui-color-container, #ffffff)');
    for (const s of ['default', 'elevated', 'sunken', 'accent', 'transparent'] as const) {
      expect(resolveSurfaceOnColorCss(s)).toBeUndefined();
    }
  });
  it('Card surface="inverted" paints the ink background AND sets the inverse text colour on its root', () => {
    const html = renderToStaticMarkup(<Card surface="inverted">hello</Card>);
    expect(html).toContain('background-color:var(--ggui-color-onContainer, #18181b)');
    expect(html).toContain('color:var(--ggui-color-container, #ffffff)');
  });
  it('a default Card sets no colour (inherits the page ink)', () => {
    const html = renderToStaticMarkup(<Card>hello</Card>);
    expect(html).not.toMatch(/;color:|"color:/);
  });
  it('Box surface="inverted" sets the inverse ink; an asset fill keeps the page ink', () => {
    expect(renderToStaticMarkup(<Box surface="inverted">x</Box>)).toContain('color:var(--ggui-color-container, #ffffff)');
    expect(renderToStaticMarkup(<Box assetColor="#ff0000" assetSemantic="brand">x</Box>)).not.toContain('color:var(--ggui-color-container');
  });
});
