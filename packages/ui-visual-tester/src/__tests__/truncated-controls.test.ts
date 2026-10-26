/**
 * ggui#2010: the no-truncate pin's in-page expression, read back from a real browser. The visual evaluator runs
 * `TRUNCATED_CONTROLS_EXPRESSION` on every capture and fails the canvas on any label it returns, so each shape here
 * has a known answer: a control cut by an ellipsis or by its own overflow is named; a whole, wrapped or hidden one
 * is not.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright-core';
import { TRUNCATED_CONTROLS_EXPRESSION } from '../truncated-controls';

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});

async function read(body: string, rootWidth = 240): Promise<unknown> {
  const ctx = await browser.newContext({ viewport: { width: 400, height: 640 } });
  try {
    const page = await ctx.newPage();
    await page.setContent(`<!doctype html><html><body><div id="root" style="width:${rootWidth}px">${body}</div></body></html>`, { waitUntil: 'load' });
    return await page.evaluate(TRUNCATED_CONTROLS_EXPRESSION);
  } finally {
    await ctx.close();
  }
}

const LONG = 'Walk me through every single setting in this notebook app';

describe('TRUNCATED_CONTROLS_EXPRESSION names every shown control a visitor cannot read whole (ggui#2010)', () => {
  it('a chip that ellipsizes its label is named', async () => {
    expect(await read(`<button style="max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${LONG}</button>`)).toEqual([LONG]);
  });

  it('a label cut by an ellipsis on an element INSIDE the control is named too', async () => {
    expect(
      await read(`<button style="max-width:100%"><span style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${LONG}</span></button>`),
    ).toEqual([LONG]);
  });

  it("a control whose own overflow clips its label (no ellipsis) is named", async () => {
    expect(await read(`<div role="button" style="width:120px;height:20px;overflow:hidden;white-space:nowrap">${LONG}</div>`)).toEqual([LONG]);
  });

  it("the kit's chip shape — max-width: 100%, white-space: normal — wraps a long label inside the pill and is NOT named", async () => {
    expect(await read(`<button style="max-width:100%;white-space:normal">${LONG}</button><button>Short</button>`)).toEqual([]);
  });

  it('a control hidden by the row cap (display: none) is not a truncated control', async () => {
    expect(
      await read(`<button>Shown</button><button data-ggui-row-dropped="" style="display:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:20px">${LONG}</button>`),
    ).toEqual([]);
  });

  // The third clause (#2010, the CDO at c.6357159392; the CTO's fixture c.6357141606): a group clipped by its own
  // height crops the chips that cross its bottom edge — guuey#1487's "crops every chip" — while each chip's own box
  // and text are whole, so only the ancestor test sees it.
  const EIGHT_CHIPS = ['Start a new notebook for this week', 'Import my notes from another app', 'Show me what I wrote yesterday',
    'Find everything tagged with travel', 'Turn my last note into a checklist', 'Share a notebook with my team',
    'Set a reminder for tomorrow morning', 'Explain how tags and folders work'];
  const group = (style: string) =>
    `<div style="display:flex;flex-wrap:wrap;gap:8px;${style}">${EIGHT_CHIPS.map((l) => `<button style="max-width:100%;white-space:normal">${l}</button>`).join('')}</div>`;

  it('chips cut by a group that clips its own height (max-height + overflow: hidden) are named, every one that crosses its bottom', async () => {
    const read8 = await read(group('max-height:76px;overflow:hidden'), 384);
    const named = Array.isArray(read8) ? read8.filter((l): l is string => typeof l === 'string') : [];
    expect(Array.isArray(read8)).toBe(true);
    expect(named.length).toBeGreaterThan(0);
    expect(EIGHT_CHIPS.slice(0, 2).some((l) => named.includes(l))).toBe(false);
    expect(named.every((l) => EIGHT_CHIPS.includes(l))).toBe(true);
  });

  it('the same group in a SCROLLING container is not named: a visitor scrolls to what it holds', async () => {
    expect(await read(group('max-height:76px;overflow:auto'), 384)).toEqual([]);
  });

  it('the same group with no clipping container is not named (control)', async () => {
    expect(await read(group(''), 384)).toEqual([]);
  });

  it('controls outside #root (the judge page chrome) are not read', async () => {
    const ctx = await browser.newContext({ viewport: { width: 400, height: 640 } });
    try {
      const page = await ctx.newPage();
      await page.setContent(
        `<!doctype html><html><body><button style="width:20px;overflow:hidden;white-space:nowrap">${LONG}</button><div id="root"></div></body></html>`,
        { waitUntil: 'load' },
      );
      expect(await page.evaluate(TRUNCATED_CONTROLS_EXPRESSION)).toEqual([]);
    } finally {
      await ctx.close();
    }
  });
});
