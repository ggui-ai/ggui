/**
 * Pin (ggui#1847): `tint` on Box and Card paints the categorical tint and
 * reads the theme's ink; it replaces `surface`'s fill, ink and scope, and an
 * asset colour still wins over it on Box.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Box } from '../Box';
import { Card } from '../Card';
import { INVERTED_SCOPE_CLASS, TINT_STEPS, resolveTintCss } from '../color-slots';
import * as entry from '../../index';

describe('categorical tint on Box and Card (ggui#1847)', () => {
  it('the eight names are exported from the package entry, in order', () => {
    expect(entry.TINT_STEPS).toEqual(['tint-1', 'tint-2', 'tint-3', 'tint-4', 'tint-5', 'tint-6', 'tint-7', 'tint-8']);
  });

  it('each step resolves to its own token', () => {
    for (const step of TINT_STEPS) expect(resolveTintCss(step)).toMatch(new RegExp(`^var\\(--ggui-color-${step}, #[0-9a-f]{6}\\)$`));
  });

  it('a tinted Box and Card paint the tint and set the theme ink, marked as a painted surface', () => {
    for (const html of [renderToStaticMarkup(<Box tint="tint-3">Fe</Box>), renderToStaticMarkup(<Card tint="tint-3">Fe</Card>)]) {
      expect(html).toContain('var(--ggui-color-tint-3, ');
      expect(html).toContain('color:var(--ggui-color-onContainer, #18181b)');
      expect(html).toContain('data-ggui-surface="tint-3"');
    }
  });

  it('a tint replaces the surface: no inverted scope, no inverted fill', () => {
    for (const html of [renderToStaticMarkup(<Box surface="inverted" tint="tint-5">Fe</Box>), renderToStaticMarkup(<Card surface="inverted" tint="tint-5">Fe</Card>)]) {
      expect(html).toContain('var(--ggui-color-tint-5, ');
      expect(html).not.toContain(INVERTED_SCOPE_CLASS);
      expect(html).not.toContain('<style>');
    }
  });

  it('on Box, a paired asset colour still wins over a tint', () => {
    const html = renderToStaticMarkup(
      <Box tint="tint-2" assetColor="#635bff" assetSemantic="partner-brand">
        x
      </Box>,
    );
    expect(html).toContain('#635bff');
    expect(html).not.toContain('--ggui-color-tint-2');
  });
});
