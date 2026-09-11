/**
 * Pin (ggui#1019 + ggui#1024): an `inverted` surface OWNS its on-colours.
 *
 * ggui#1019 — the inverted background is the ink role
 * (`--ggui-color-onContainer`), so a Card or Box with `surface="inverted"`
 * sets the `inverse` ink (`--ggui-color-container`) on its root — otherwise
 * inherited text is ink-on-ink under any theme where the page ink equals
 * that role (rendered rgb(26,26,26) on rgb(26,26,26) in the field).
 *
 * ggui#1024 — one step further: `tone="muted"` labels, `neutral-500` hints,
 * chips and outlines inside the surface still resolved the light-surface
 * tokens (grey-on-black at 2.4–3.5:1 on served greeting cards). The root now
 * carries `INVERTED_SCOPE_CLASS` and co-renders `INVERTED_SCOPE_CSS`, which
 * re-maps the surface-layering vocabulary for its subtree by cascade.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Card } from '../Card';
import { Box } from '../Box';
import { Text } from '../Text';
import { Badge } from '../Badge';
import {
  INVERTED_SCOPE_CLASS,
  INVERTED_SCOPE_CSS,
  INVERTED_SCOPE_MIX,
  resolveSurfaceOnColorCss,
} from '../color-slots';

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

describe('inverted surface owns its SECONDARY ink too (ggui#1024)', () => {
  it('the scope rule records the inverted pair on the root and swaps it for the direct children', () => {
    expect(INVERTED_SCOPE_CSS).toContain(
      `.${INVERTED_SCOPE_CLASS}{--ggui-surface-inverted-bg:var(--ggui-color-onContainer, #18181b);--ggui-surface-inverted-ink:var(--ggui-color-container, #ffffff)}`,
    );
    expect(INVERTED_SCOPE_CSS).toContain(
      `.${INVERTED_SCOPE_CLASS}>*{--ggui-color-container:var(--ggui-surface-inverted-bg);--ggui-color-onContainer:var(--ggui-surface-inverted-ink);`,
    );
    // static tier: the muted / subtle inks fall back to the primary ink …
    expect(INVERTED_SCOPE_CSS).toContain('--ggui-color-onSunken:var(--ggui-surface-inverted-ink);');
    expect(INVERTED_SCOPE_CSS).toContain('--ggui-color-neutral-500:var(--ggui-surface-inverted-ink)}');
    // … and the mixed values sit inside the package's color-mix @supports tier.
    const supports = INVERTED_SCOPE_CSS.indexOf('@supports (color: color-mix(in srgb, red, blue))');
    expect(supports).toBeGreaterThan(0);
    const tier2 = INVERTED_SCOPE_CSS.slice(supports);
    expect(tier2).toContain(`--ggui-color-onSunken:color-mix(in srgb, var(--ggui-surface-inverted-ink) ${INVERTED_SCOPE_MIX.onSunkenInk}%, var(--ggui-surface-inverted-bg))`);
    expect(tier2).toContain(`--ggui-color-outlineVariant:color-mix(in srgb, var(--ggui-surface-inverted-ink) ${INVERTED_SCOPE_MIX.outlineVariantInk}%, var(--ggui-surface-inverted-bg))`);
    // the aliases are the package's own namespace, never a theme family
    expect(INVERTED_SCOPE_CSS).not.toMatch(/--ggui-color-inverted/);
  });

  it('Card surface="inverted" carries the scope class and co-renders the rule before its children', () => {
    const html = renderToStaticMarkup(
      <Card surface="inverted" className="hero">
        <Text tone="muted">label</Text>
      </Card>,
    );
    expect(html).toMatch(new RegExp(`class="hero ${INVERTED_SCOPE_CLASS}"`));
    expect(html).toContain(`<style>${INVERTED_SCOPE_CSS}</style>`);
    // The child keeps its token reference — the cascade re-maps the token, not the child.
    expect(html).toContain('color:var(--ggui-color-onSunken, #52525b)');
    expect(html.indexOf('<style>')).toBeLessThan(html.indexOf('label'));
  });

  it('a default Card and an asset-filled Box render no scope class and no rule', () => {
    for (const html of [
      renderToStaticMarkup(<Card><Text tone="muted">x</Text></Card>),
      renderToStaticMarkup(<Box surface="sunken">x</Box>),
      renderToStaticMarkup(<Box assetColor="#ff0000" assetSemantic="brand">x</Box>),
    ]) {
      expect(html).not.toContain(INVERTED_SCOPE_CLASS);
      expect(html).not.toContain('<style>');
    }
  });

  it('Box surface="inverted" behaves like Card; a Badge inside keeps its sunken/onSunken pair (re-mapped by cascade)', () => {
    const html = renderToStaticMarkup(
      <Box surface="inverted">
        <Badge>chip</Badge>
      </Box>,
    );
    expect(html).toContain(`class="${INVERTED_SCOPE_CLASS}"`);
    expect(html).toContain(`<style>${INVERTED_SCOPE_CSS}</style>`);
    expect(html).toContain('background-color:var(--ggui-color-sunken, #f4f4f5)');
    expect(html).toContain('color:var(--ggui-color-onSunken, #52525b)');
  });

  // The mix percentages are a contrast decision — pin the arithmetic on the
  // default pair (#ffffff ink over #18181b ground), as color-mix(in srgb)
  // interpolates the gamma-encoded channels.
  it('the chosen mixes clear WCAG on the default inverted pair', () => {
    const hex = (h: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
    const mix = (a: [number, number, number], b: [number, number, number], pctA: number): [number, number, number] =>
      a.map((c, i) => c * (pctA / 100) + b[i]! * (1 - pctA / 100)) as [number, number, number];
    const lum = ([r, g, b]: [number, number, number]): number => {
      const ch = (c: number): number => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
    };
    const contrast = (x: [number, number, number], y: [number, number, number]): number => {
      const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };
    const ink = hex('#ffffff');
    const bg = hex('#18181b');
    const onSunken = mix(ink, bg, INVERTED_SCOPE_MIX.onSunkenInk);
    const neutral500 = mix(ink, bg, INVERTED_SCOPE_MIX.neutral500Ink);
    const sunken = mix(bg, ink, INVERTED_SCOPE_MIX.sunkenBg);
    const elevated = mix(bg, ink, INVERTED_SCOPE_MIX.elevatedBg);
    expect(contrast(onSunken, bg)).toBeGreaterThanOrEqual(7); // muted label on the inverted ground: AAA
    expect(contrast(neutral500, bg)).toBeGreaterThanOrEqual(4.5); // subtle hint: AA
    expect(contrast(onSunken, sunken)).toBeGreaterThanOrEqual(4.5); // default Badge chip: AA
    expect(contrast(ink, elevated)).toBeGreaterThanOrEqual(7); // primary ink on an elevated float
    // the field failures this pins against: 3.5:1 (rgb 99 on black) and 2.41:1
    expect(contrast([99, 99, 99], [0, 0, 0])).toBeLessThan(4.5);
  });
});
