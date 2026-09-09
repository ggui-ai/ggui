import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { resolveSurfaceCss, resolveToneCss } from '../color-slots';
import { Heading } from '../Heading';
import { Badge } from '../Badge';
import { Markdown } from '../../components/Markdown';

// ggui#987 §2.1 — surface-layering roles: one kind of AREA per role.
describe('surface slots read the layering roles (ggui#987 §2.1)', () => {
  it('default fill is the container role', () => {
    expect(resolveSurfaceCss('default')).toMatch(/^var\(--ggui-color-container,/);
  });
  it('elevated fill is its own role — the pair enters the manifest', () => {
    expect(resolveSurfaceCss('elevated')).toMatch(/^var\(--ggui-color-elevated,/);
  });
  it('sunken fill is the sunken role', () => {
    expect(resolveSurfaceCss('sunken')).toMatch(/^var\(--ggui-color-sunken,/);
  });
  it('inverted fill is the container pair inverted', () => {
    expect(resolveSurfaceCss('inverted')).toMatch(/^var\(--ggui-color-onContainer,/);
  });
});

describe('tone slots read the on-roles (ggui#987 §2.1)', () => {
  it('default text is onContainer, muted text is onSunken, inverse text is container', () => {
    expect(resolveToneCss('default')).toMatch(/^var\(--ggui-color-onContainer,/);
    expect(resolveToneCss('muted')).toMatch(/^var\(--ggui-color-onSunken,/);
    expect(resolveToneCss('inverse')).toMatch(/^var\(--ggui-color-container,/);
  });
});

describe('Heading reads the ramp stops and the heading family/weight (ggui#987 §2.2)', () => {
  it.each([
    [1, '4xl'],
    [2, '3xl'],
    [3, '2xl'],
    [4, 'xl'],
    [5, 'lg'],
    [6, 'base'],
  ] as const)('h%i → --ggui-font-size-%s', (level, stop) => {
    const html = renderToStaticMarkup(<Heading level={level}>t</Heading>);
    expect(html).toContain(`font-size:var(--ggui-font-size-${stop},`);
    expect(html).toContain('font-weight:var(--ggui-font-weight-heading,');
    expect(html).toContain('font-family:var(--ggui-font-family-heading,');
  });
});

describe('Markdown code surfaces (ggui#987 §2.1 — sunken fill, shape radii)', () => {
  it('inline code and fences read --ggui-color-sunken and the shape radius family', () => {
    const html = renderToStaticMarkup(<Markdown markdown={'a `b` c\n\n```\nx\n```'} />);
    expect(html).toContain('var(--ggui-color-sunken,');
    expect(html).toContain('var(--ggui-shape-radius-sm,');
    expect(html).toContain('var(--ggui-shape-radius-md,');
    expect(html).not.toContain('--ggui-radius-sm');
    expect(html).not.toContain('--ggui-color-surface');
  });
});

describe('Badge tertiary tone — the second accent gets a consumer (ggui#987 §2.1)', () => {
  it('variant="tertiary" reads the tertiary container pair', () => {
    const html = renderToStaticMarkup(<Badge variant="tertiary">t</Badge>);
    expect(html).toContain('var(--ggui-color-tertiaryContainer,');
    expect(html).toContain('var(--ggui-color-onTertiaryContainer,');
  });
});
