/**
 * ggui#1139 — the founder's ruling, as a layout assertion: **at `md` the card FILLS the frame.**
 *
 * The RULE is pinned elsewhere — the runtime composes `fillFitRule` for a `fit: 'fill'` mount
 * (`iframe-runtime` `render-item-fit.test.ts`) and design pins the rule's text (`compose-theme-css.test.ts`,
 * `expanded-frame.test.tsx`). What those cannot see is what a browser RESOLVES the rule to: ggui#1073's
 * 414-px root in an 836-px frame passed every rule pin. This file mounts the runtime's DOM shape — the
 * session-root list, the scope div, the card — under the design's composed CSS in real Chromium, at the
 * canvas boxes the judge uses, and reads the boxes back. It runs in the same Tier-1 job as the behaviour
 * validation (Playwright's chromium is installed there), so a card that stops filling the frame at `md`
 * fails CI, not a memory.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser } from 'playwright-core';
import { composeThemeCss } from '@ggui-ai/design/rendering';

const SCOPE = 'ggui-rcr-1';
/** The judge's canvas boxes (`CANVAS_VIEWPORTS`): the inline chat card, the md and lg fill canvases. */
const XS = { width: 400, height: 640 };
const MD = { width: 768, height: 1024 };
const LG = { width: 1024, height: 768 };

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The runtime's mount as served: `<ul data-ggui-session-root>` → the scope div → the card root. The
 * tree CSS is the design's composition for this scope, with the fill rule when `fit` is `'fill'`.
 */
function page(card: string, fit: 'fill' | undefined): string {
  const tree = composeThemeCss({ layer: 'tree', scopeClass: SCOPE, ...(fit !== undefined ? { fit } : {}) });
  const tokens = composeThemeCss({ layer: 'page' });
  return `<!doctype html><html><head><meta charset="utf-8"><style>${tokens}\n${tree}</style></head>
<body><ul data-ggui-session-root><div class="${SCOPE}">${card}</div></ul></body></html>`;
}

/** A card of several content-sized children — the common root shape. */
const MANY_CHILD_CARD = `<div id="card" style="border: 1px solid #999; border-radius: 12px; max-width: 480px">
  <h1>Harbor Books</h1><p>Three short rows.</p><button type="button">Confirm</button></div>`;
/** A wrapper root around ONE surface that sizes itself to the viewport inline — ggui#1073 / #1096's shape. */
const WRAPPER_CARD = `<div id="card" style="display: flex; justify-content: center; padding: 24px">
  <section id="surface" style="min-height: 100vh; width: 100%; max-width: 640px; border: 1px solid #999"><h1>Hero</h1></section></div>`;

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});

async function boxes(html: string, viewport: { width: number; height: number }, ids: readonly string[]): Promise<Record<string, Box>> {
  const ctx = await browser.newContext({ viewport });
  try {
    const p = await ctx.newPage();
    await p.setContent(html, { waitUntil: 'load' });
    return await p.evaluate((wanted: readonly string[]) => {
      const out: Record<string, { x: number; y: number; width: number; height: number }> = {};
      for (const id of wanted) {
        const el = id === 'scope' ? document.querySelector('[data-ggui-session-root] > div') : document.getElementById(id);
        if (el === null) throw new Error(`no element ${id}`);
        const r = el.getBoundingClientRect();
        out[id] = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
      }
      return out;
    }, ids);
  } finally {
    await ctx.close();
  }
}

describe('at md the card FILLS the frame (ggui#1139, the founder’s ruling) — resolved by a real browser', () => {
  it('a many-child root fills the md frame: the scope and the root are the frame’s box, edge to edge', async () => {
    const b = await boxes(page(MANY_CHILD_CARD, 'fill'), MD, ['scope', 'card']);
    expect(b.scope).toEqual({ x: 0, y: 0, ...MD });
    expect(b.card).toEqual({ x: 0, y: 0, ...MD });
  });

  it('a wrapper root hands the fill to its one surface (ggui#1073 / #1096): the surface is the frame, not 884 in 836', async () => {
    const b = await boxes(page(WRAPPER_CARD, 'fill'), MD, ['scope', 'card', 'surface']);
    expect(b.scope).toEqual({ x: 0, y: 0, ...MD });
    expect(b.card).toEqual({ x: 0, y: 0, ...MD });
    expect(b.surface).toEqual({ x: 0, y: 0, ...MD });
  });

  it('the same at lg', async () => {
    const b = await boxes(page(MANY_CHILD_CARD, 'fill'), LG, ['card']);
    expect(b.card).toEqual({ x: 0, y: 0, ...LG });
  });

  it('the inline chat card (no fill) keeps its natural height and its own cap — the contrast the fill rule is scoped against', async () => {
    const b = await boxes(page(MANY_CHILD_CARD, undefined), XS, ['card']);
    expect(b.card.width).toBeLessThanOrEqual(XS.width);
    expect(b.card.height).toBeLessThan(XS.height);
    expect(b.card.height).toBeGreaterThan(0);
  });
});
