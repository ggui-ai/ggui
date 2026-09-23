/**
 * Pin (ggui#1083 cut 2, `rnd/gen-ui/beauty/expanded-frame-direction.md` v1.2): inside a host's
 * fullscreen canvas the panel carries the one chrome and the card fills it — on ONE rhythm.
 *
 * - The panel's OUTER radius is the theme's `xl` radius stop. The guuey widget pins its own panel
 *   table to the same rule (guuey `33afd73d0`, `panel-radius-sync.test.ts`); the ladders below are
 *   guuey's forwarded `RADIUS_LADDERS` and its `PANEL_RADIUS_PX`, verbatim, so this file is the
 *   ggui-side mirror of that guard.
 * - The frame's INSET is guuey's `panelGap` default, 16 px — a cross-fleet constant.
 * - The fill rule gives the fill surface that inset, makes a first-level surface concentric with
 *   the panel's corner, and lets a `bleed` element take the inset back. Only under `fit: 'fill'`.
 * - Card and Box mark themselves (`data-ggui-surface`, `data-ggui-bleed`) so the rule can see them.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Box } from '../primitives/Box';
import { Card } from '../primitives/Card';
import { deriveThemeVariables } from '../themes/derive-theme-variables';
import type { DtcgTheme } from '../themes/types';
import { composeThemeCss, EXPANDED_FRAME, EXPANDED_FRAME_INNER_RADIUS, fillFitRule } from './css-tokens';

const HERE = dirname(fileURLToPath(import.meta.url));
const stored: DtcgTheme = JSON.parse(
  readFileSync(join(HERE, '..', 'themes', '__fixtures__', 'r1', 'stored-dtcg-light.json'), 'utf8'),
) as DtcgTheme;

/** guuey `RADIUS_LADDERS` (forwarded into the AppTheme) and `PANEL_RADIUS_PX` (the widget's panel), at guuey `33afd73d0`. */
const GUUEY = [
  { bucket: 'none', ladder: { sm: '0px', md: '0px', lg: '0px', xl: '0px' }, panelPx: 0 },
  { bucket: 'soft', ladder: { sm: '4px', md: '8px', lg: '12px', xl: '16px' }, panelPx: 16 },
  { bucket: 'round', ladder: { sm: '8px', md: '12px', lg: '18px', xl: '24px' }, panelPx: 24 },
] as const;

function withLadder(ladder: Readonly<Record<'sm' | 'md' | 'lg' | 'xl', string>>): DtcgTheme {
  const template = stored.shape.radius.md!;
  const radius = { ...stored.shape.radius };
  for (const [stop, value] of Object.entries(ladder)) radius[stop] = { ...template, $value: value };
  return { ...stored, shape: { ...stored.shape, radius } };
}

describe('the expanded frame — one definition (ggui#1083 cut 2)', () => {
  it("the panel's outer radius is the theme's xl stop: for guuey's three forwarded ladders the projected xl IS the widget's panel radius", () => {
    expect(EXPANDED_FRAME.outerRadiusVar).toBe('--ggui-shape-radius-xl');
    for (const g of GUUEY) {
      const v = deriveThemeVariables(withLadder(g.ladder), 'light');
      expect(Number.parseFloat(v[EXPANDED_FRAME.outerRadiusVar] ?? 'NaN'), g.bucket).toBe(g.panelPx);
    }
  });

  it("the inset is guuey's panelGap default, 16 px, and a first-level surface is concentric: max(0, xl − 16)", () => {
    expect(EXPANDED_FRAME.insetPx).toBe(16);
    expect(EXPANDED_FRAME_INNER_RADIUS).toBe('max(0px, calc(var(--ggui-shape-radius-xl) - 16px))');
  });
});

describe("the fill rule carries the frame's rhythm — and only the fill rule", () => {
  const rule = fillFitRule('s1');

  it('both fill surfaces (a many-child root, or the one child a wrapper hands the fill to) keep the 16 px inset', () => {
    expect(rule).toContain('.s1 > :where(:not(style)):not(:has(> :only-child)) { padding: 16px !important; }');
    expect(rule).toContain('.s1 > :where(:not(style)) > :where(:only-child) { padding: 16px !important; }');
  });

  it('a first-level surface takes the concentric radius; a bleed element takes the inset back and squares off', () => {
    expect(rule).toContain(
      `> [data-ggui-surface]:not([data-ggui-bleed]) { border-radius: ${EXPANDED_FRAME_INNER_RADIUS} !important; }`,
    );
    expect(rule).toContain(
      '> [data-ggui-bleed] { margin-left: -16px !important; margin-right: -16px !important; border-radius: 0 !important; }',
    );
    expect(rule).toContain('> [data-ggui-bleed]:first-child { margin-top: -16px !important; }');
    expect(rule).toContain('> [data-ggui-bleed]:last-child { margin-bottom: -16px !important; }');
  });

  it('an inline (non-fill) composition carries none of it', () => {
    const inline = composeThemeCss({ layer: 'tree', scopeClass: 's1' });
    expect(inline).not.toContain('data-ggui-bleed');
    expect(inline).not.toContain('data-ggui-surface');
    expect(composeThemeCss({ layer: 'tree', scopeClass: 's1', fit: 'fill' })).toContain('data-ggui-bleed');
  });
});

describe('Card and Box mark themselves for the frame', () => {
  it('a painted Card is a surface; a transparent one is not', () => {
    expect(renderToStaticMarkup(<Card>x</Card>)).toContain('data-ggui-surface="default"');
    expect(renderToStaticMarkup(<Card surface="hero">x</Card>)).toContain('data-ggui-surface="hero"');
    expect(renderToStaticMarkup(<Card surface="transparent">x</Card>)).not.toContain('data-ggui-surface');
  });

  it('a Box is a surface only when it paints one; bleed rides any Box and is absent by default', () => {
    const band = renderToStaticMarkup(
      <Box surface="hero" bleed>
        x
      </Box>,
    );
    expect(band).toContain('data-ggui-surface="hero"');
    expect(band).toContain('data-ggui-bleed=""');
    expect(renderToStaticMarkup(<Box bleed>x</Box>)).toContain('data-ggui-bleed=""');
    const plain = renderToStaticMarkup(<Box>x</Box>);
    expect(plain).not.toContain('data-ggui-surface');
    expect(plain).not.toContain('data-ggui-bleed');
    expect(renderToStaticMarkup(<Box surface="transparent">x</Box>)).not.toContain('data-ggui-surface');
  });
});
