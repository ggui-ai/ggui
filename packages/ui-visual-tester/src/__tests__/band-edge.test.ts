/**
 * ggui#1977: where an opening band's ground lands, read back from a real browser.
 *
 * Since ggui#1765 the card keeps ONE content edge in every fit. The runtime insets the root's content by the card's
 * inset (`cardInsetRule`), and only two things take that inset back so their ground meets the card's edge: a
 * `surface="hero"` band that is the root's FIRST child, and any element that declares `bleed`
 * (`EXPANDED_FRAME_BLEEDS`). A band the generator paints itself is neither, so it floats inside the inset with the
 * card's corners around it. That is the hello #1385 found on judge 4680f34, where two independent generations rendered
 * byte-identical inset frames. This file mounts the runtime's DOM shape under the design's composed CSS in Chromium, in
 * both card fits, at the judge's xs-chat-card and md boxes, and measures the band against the card with
 * `getBoundingClientRect`. The shapes that miss are pinned as missing, so a change to the runtime's bleed rule, or to
 * the prompt sentence that teaches it, has to move this file too.
 */
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright-core';
import { Box, Text } from '@ggui-ai/design/primitives';
import { composeThemeCss } from '@ggui-ai/design/rendering';

const SCOPE = 'ggui-rcr-1';
/** The judge's canvas boxes (`CANVAS_VIEWPORTS`): the inline chat card and the md canvas. */
const XS = { width: 400, height: 640 };
const MD = { width: 768, height: 1024 };

type CardFit = 'card' | 'framed-card';

function page(card: string, fit: CardFit): string {
  const tree = composeThemeCss({ layer: 'tree', scopeClass: SCOPE, fit });
  const tokens = composeThemeCss({ layer: 'page' });
  return `<!doctype html><html><head><meta charset="utf-8"><style>${tokens}\n${tree}</style></head>
<body><ul data-ggui-session-root><div class="${SCOPE}">${card}</div></ul></body></html>`;
}

const heading = h(Text, { size: '2xl', weight: 'bold' }, 'Welcome to Harbor Books');
const body = h(Text, { tone: 'muted' }, 'Three titles picked for you this week.');

/** The root the generator returns, with `band` as its children in order. Rendered by the real primitives. */
const card = (...children: ReturnType<typeof h>[]): string => renderToStaticMarkup(h(Box, { padding: 'lg' }, ...children));

/** The four shapes: two keep the ground edge to edge, two are the ways the escape is lost. */
const SHAPES = {
  /** The precheck's shape: a band the generator painted itself (its own colour), opening the card. */
  painted: card(h(Box, { padding: 'lg', style: { background: 'var(--ggui-color-primary-500)' } }, heading), body),
  /** The kit's band, opening the card: the root's first child. */
  heroFirst: card(h(Box, { surface: 'hero', padding: 'lg' }, heading), body),
  /** The kit's band, but not the first child: a line of text opens the card above it. */
  heroSecond: card(body, h(Box, { surface: 'hero', padding: 'lg' }, heading)),
  /** Any other band that declares `bleed`, anywhere in the root. */
  bleedSecond: card(body, h(Box, { surface: 'sunken', padding: 'lg', bleed: true }, heading)),
} as const;

interface Edges {
  readonly left: number;
  readonly right: number;
}

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});

/** The root's box and the band's (the root child that contains the heading), each as its left and right edge. */
async function measure(html: string, viewport: { width: number; height: number }): Promise<{ root: Edges; band: Edges }> {
  const ctx = await browser.newContext({ viewport });
  try {
    const p = await ctx.newPage();
    await p.setContent(html, { waitUntil: 'load' });
    return await p.evaluate(() => {
      const root = document.querySelector('[data-ggui-session-root] > div > *');
      if (root === null) throw new Error('no root');
      const band = [...root.children].find((c) => (c.textContent ?? '').includes('Welcome to Harbor Books'));
      if (band === undefined) throw new Error('no band');
      const edges = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(r.right) };
      };
      return { root: edges(root), band: edges(band) };
    });
  } finally {
    await ctx.close();
  }
}

const CASES = [
  ['card', 'xs-chat-card', XS],
  ['card', 'md', MD],
  ['framed-card', 'xs-chat-card', XS],
  ['framed-card', 'md', MD],
] as const;

describe('an opening band meets the card edge only as the kit band, first, or with bleed (ggui#1977)', () => {
  it.each(CASES)('%s fit at %s: a first-child surface="hero" band runs edge to edge (0 px on both sides)', async (fit, _c, vp) => {
    const { root, band } = await measure(page(SHAPES.heroFirst, fit), vp);
    expect(band.left - root.left).toBe(0);
    expect(root.right - band.right).toBe(0);
  });

  it.each(CASES)('%s fit at %s: a band that declares bleed runs edge to edge wherever it sits', async (fit, _c, vp) => {
    const { root, band } = await measure(page(SHAPES.bleedSecond, fit), vp);
    expect(band.left - root.left).toBe(0);
    expect(root.right - band.right).toBe(0);
  });

  it.each(CASES)('%s fit at %s: a band the generator painted itself floats inside the inset (the #1385 hello)', async (fit, _c, vp) => {
    const { root, band } = await measure(page(SHAPES.painted, fit), vp);
    expect(band.left - root.left).toBeGreaterThan(0);
    expect(root.right - band.right).toBe(band.left - root.left);
  });

  it.each(CASES)('%s fit at %s: a surface="hero" band that is NOT the first child floats inside the inset too', async (fit, _c, vp) => {
    const { root, band } = await measure(page(SHAPES.heroSecond, fit), vp);
    expect(band.left - root.left).toBeGreaterThan(0);
  });
});
