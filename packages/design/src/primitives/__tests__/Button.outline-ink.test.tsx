/**
 * Pin (ggui#1034, the #1019 / #1024 family): a control with a TRANSPARENT
 * background paints text on whatever ground it sits, so its label must be
 * the ground's own on-colour — never a brand-ladder stop. `outline` painted
 * `primary-600` as its label; on a near-monochrome dark theme that stop is
 * mid-grey on the theme's own ground: the RED fixture is guuey-QA's served
 * read (candidate 13, 2026-09-12 00:39Z) — Loops chips rgb(98,99,103) on
 * rgb(44,41,39) = 2.41:1 ×4, LvlUp chips rgb(99,99,99) on rgb(0,0,0) = 3.5:1
 * ×4 — while the eyebrow/body on the same card (onSunken / onContainer)
 * read at 4.6–16:1. The brand stop stays on the border, where contrast is
 * decorative.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button } from '../Button';

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

describe('Button outline label ink (ggui#1034)', () => {
  it('the RED fixture: a brand-ladder stop as label ink fails AA on a monochrome dark ground', () => {
    expect(contrast([99, 99, 99], [0, 0, 0])).toBeLessThan(4.5); // LvlUp, 3.5:1
    expect(contrast([98, 99, 103], [44, 41, 39])).toBeLessThan(4.5); // Loops, 2.41:1
  });

  it('outline: label = the surface on-colour, border = the brand stop, background transparent', () => {
    const html = renderToStaticMarkup(<Button variant="outline">Find funding options</Button>);
    expect(html).toContain('color:var(--ggui-color-onContainer, #18181b)');
    expect(html).not.toMatch(/;color:var\(--ggui-color-primary-/);
    expect(html).toContain('border:1px solid var(--ggui-color-primary-600, #0284c7)');
    expect(html).toContain('background-color:transparent');
  });

  it('the filled variants keep their on-pairs; ghost keeps the sunken ink', () => {
    expect(renderToStaticMarkup(<Button variant="primary">x</Button>)).toContain('color:var(--ggui-color-onPrimary, #ffffff)');
    expect(renderToStaticMarkup(<Button variant="danger">x</Button>)).toContain('color:var(--ggui-color-onError, #ffffff)');
    expect(renderToStaticMarkup(<Button variant="ghost">x</Button>)).toContain('color:var(--ggui-color-onSunken, #52525b)');
    expect(renderToStaticMarkup(<Button variant="secondary">x</Button>)).toContain('color:var(--ggui-color-onSunken, #52525b)');
  });
});
