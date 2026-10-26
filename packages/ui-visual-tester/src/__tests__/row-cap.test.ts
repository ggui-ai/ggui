/**
 * ggui#2010: the kit's row cap read back from a real browser. A quick-reply group (`<Row wrap maxRows={3}>`) of the
 * hello's own chip (`Button variant="outline" size="sm"`, `maxWidth: 100%`, `whiteSpace: normal`) is mounted LIVE
 * (React in Chromium, so the cap's layout effect and ResizeObserver run) under the design's composed CSS, at the
 * judge's xs width and at md, and measured with `getBoundingClientRect`.
 *
 * The rule (#2010, the CDO's end rule at c.6357159392): at most three rows by the group's own width, as a height
 * bound; a chip shows only if every row it takes ends within the cap, and from the first that would end past it,
 * it and every chip after it are hidden, so each chip is whole or absent; a chip wider than the group wraps inside
 * its pill and takes a row per line; the first chip always shows; nothing ellipsizes or clips; a resize re-packs.
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright-core';
import { composeThemeCss } from '@ggui-ai/design/rendering';
import { TRUNCATED_CONTROLS_EXPRESSION } from '../truncated-controls';

/** What the page's bundle installs on `window`, typed once for the test's `page.evaluate` callbacks. */
declare global {
  interface Window {
    __mount?: (labels: readonly string[], maxRows: number | null) => void;
    __errors?: string[];
  }
}

const SCOPE = 'ggui-rcr-1';
const req = createRequire(import.meta.url);

/** The page's mount: one quick-reply group, `labels` in bound order, at the given width. */
const ENTRY = `
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Row, Button } from '@ggui-ai/design/primitives';
const chip = { borderRadius: 'var(--ggui-shape-radius-full)', maxWidth: '100%', whiteSpace: 'normal' };
window.__mount = (labels, maxRows) => {
  const host = document.getElementById('host');
  const root = createRoot(host);
  root.render(h(Row, { gap: 'sm', wrap: true, align: 'center', ...(maxRows === null ? {} : { maxRows }) },
    labels.map((l) => h(Button, { key: l, variant: 'outline', size: 'sm', style: chip }, l))));
};
`;

let browser: Browser;
let bundle: string;
beforeAll(async () => {
  const out = await build({
    stdin: { contents: ENTRY, resolveDir: resolve(__dirname, '..'), loader: 'tsx' },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    // One React for the page (as scripts/build-fixture-bundle.mjs): every react specifier pinned, the jsx runtimes too,
    // because an alias matches by prefix and `react/jsx-runtime` would otherwise resolve under react's index file.
    alias: {
      react: req.resolve('react'),
      'react-dom': req.resolve('react-dom'),
      'react-dom/client': req.resolve('react-dom/client'),
      'react/jsx-runtime': req.resolve('react/jsx-runtime'),
      'react/jsx-dev-runtime': req.resolve('react/jsx-dev-runtime'),
    },
    logLevel: 'silent',
  });
  bundle = out.outputFiles[0]?.text ?? '';
  browser = await chromium.launch({ headless: true });
}, 60_000);
afterAll(async () => {
  await browser.close();
});

function html(width: number): string {
  const tokens = composeThemeCss({ layer: 'page' });
  const tree = composeThemeCss({ layer: 'tree', scopeClass: SCOPE, fit: 'card' });
  return `<!doctype html><html><head><meta charset="utf-8"><style>${tokens}\n${tree}</style></head>
<body style="margin:0"><script>window.__errors = []; window.addEventListener("error", (e) => window.__errors.push(String(e.message)));</script><div class="${SCOPE}" style="width:${width}px"><div id="root"><div id="host"></div></div></div><script>${bundle}</script></body></html>`;
}

interface Chip {
  readonly label: string;
  readonly shown: boolean;
  readonly top: number;
  readonly bottom: number;
  readonly height: number;
  readonly clipped: boolean;
  readonly ellipsis: boolean;
  readonly lineHeight: number;
}

/** Each chip's box and whether it is shown, clipped (content wider or taller than its box) or ellipsized. */
async function readChips(page: Page): Promise<{ chips: Chip[]; groupBottom: number }> {
  return page.evaluate(() => {
    const group = document.querySelector('#host > div');
    if (group === null) throw new Error('no group');
    const gb = group.getBoundingClientRect();
    const chips = Array.from(group.children).map((el) => {
      const b = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        label: el.textContent ?? '',
        shown: cs.display !== 'none',
        top: Math.round(b.top - gb.top),
        bottom: Math.round(b.bottom - gb.top),
        height: Math.round(b.height),
        clipped: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1,
        ellipsis: cs.textOverflow === 'ellipsis',
        lineHeight: Number.parseFloat(cs.lineHeight) || Number.parseFloat(cs.fontSize) * 1.2,
      };
    });
    return { chips, groupBottom: Math.round(gb.bottom - gb.top) };
  });
}

/** A chip's text lines, from a one-line chip's height and its own line height. */
function chipLines(c: Chip, oneLine: number): number {
  return c.height <= oneLine + 1 ? 1 : 1 + Math.round((c.height - oneLine) / c.lineHeight);
}

/** The rows the given chips take, each flex line counted as its tallest chip's text lines (an independent oracle). */
function lines(chips: readonly Chip[], oneLine: number): number {
  let n = 0;
  let bottom = -Infinity;
  let rowLines = 0;
  for (const c of chips) {
    if (c.top >= bottom - 1) {
      n += rowLines;
      rowLines = chipLines(c, oneLine);
      bottom = c.bottom;
    } else {
      rowLines = Math.max(rowLines, chipLines(c, oneLine));
      bottom = Math.max(bottom, c.bottom);
    }
  }
  return n + rowLines;
}

/** The end rule, read off an UNCAPPED layout: how many chips show under a cap of `maxRows` (at least one). */
function expectedShown(uncapped: readonly Chip[], maxRows: number, oneLine: number): number {
  for (let k = 1; k <= uncapped.length; k++) {
    if (lines(uncapped.slice(0, k), oneLine) > maxRows) {
      // the cap starts at the first chip of the row that would end past it
      const row = uncapped[k - 1];
      let first = k - 1;
      while (first > 0 && (uncapped[first - 1]?.bottom ?? 0) > (row?.top ?? 0) + 1) first--;
      return Math.max(1, first);
    }
  }
  return uncapped.length;
}

/** The one-line chip height at a width: a group holding one short chip. */
async function oneLineHeight(width: number): Promise<number> {
  const page = await mount(width, ['Short'], null);
  try {
    return (await readChips(page)).chips[0]?.height ?? 0;
  } finally {
    await page.context().close();
  }
}

async function mount(width: number, labels: readonly string[], maxRows: number | null): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: Math.max(width, 400), height: 900 } });
  const page = await ctx.newPage();
  await page.setContent(html(width), { waitUntil: 'load' });
  await page.evaluate(([l, m]) => {
    if (window.__mount === undefined) throw new Error('the page bundle did not install __mount');
    window.__mount(l, m);
  }, [labels, maxRows] as const);
  await page.waitForTimeout(50);
  return page;
}

/** Eight long suggestions, in bound order (the acceptance frame). */
const EIGHT = [
  'Start a new notebook for this week',
  'Import my notes from another app',
  'Show me what I wrote yesterday',
  'Find everything tagged with travel',
  'Turn my last note into a checklist',
  'Share a notebook with my team',
  'Set a reminder for tomorrow morning',
  'Explain how tags and folders work',
];

describe('a quick-reply group shows at most three rows, whole chips only, in bound order (ggui#2010, the end rule)', () => {
  it('xs (the 400 px chat card): eight long chips → a prefix in order, exactly what the end rule allows, at most three rows, nothing cut', async () => {
    const one = await oneLineHeight(384);
    const free = await mount(384, EIGHT, null);
    const page = await mount(384, EIGHT, 3);
    try {
      const uncapped = (await readChips(free)).chips;
      const { chips } = await readChips(page);
      const shown = chips.filter((c) => c.shown);
      expect(shown.length).toBeLessThan(EIGHT.length);
      expect(shown.length).toBe(expectedShown(uncapped, 3, one));
      expect(shown.map((c) => c.label)).toEqual(EIGHT.slice(0, shown.length));
      expect(lines(shown, one)).toBeLessThanOrEqual(3);
      expect(shown.filter((c) => c.clipped || c.ellipsis)).toEqual([]);
      // the evaluator's no-truncate pin reads this capped group clean: the cap hides, it never cuts
      expect(await page.evaluate(TRUNCATED_CONTROLS_EXPRESSION)).toEqual([]);
    } finally {
      await free.context().close();
      await page.context().close();
    }
  });

  it('md (768 px): the same chips in fewer rows, more of them shown, still exactly the end rule and at most three rows', async () => {
    const one = await oneLineHeight(768);
    const xs = await mount(384, EIGHT, 3);
    const free = await mount(768, EIGHT, null);
    const md = await mount(768, EIGHT, 3);
    try {
      const xsShown = (await readChips(xs)).chips.filter((c) => c.shown).length;
      const mdShown = (await readChips(md)).chips.filter((c) => c.shown);
      expect(mdShown.length).toBeGreaterThan(xsShown);
      expect(mdShown.length).toBe(expectedShown((await readChips(free)).chips, 3, one));
      expect(mdShown.map((c) => c.label)).toEqual(EIGHT.slice(0, mdShown.length));
      expect(lines(mdShown, one)).toBeLessThanOrEqual(3);
    } finally {
      await xs.context().close();
      await free.context().close();
      await md.context().close();
    }
  });

  it('wide enough for all: nothing drops', async () => {
    const page = await mount(1400, EIGHT.slice(0, 4), 3);
    try {
      expect((await readChips(page)).chips.every((c) => c.shown)).toBe(true);
    } finally {
      await page.context().close();
    }
  });

  // The CTO's case (#2010 c.6357141606): a chip that wraps inside itself and BEGINS the last allowed row would end
  // past the cap, so it hides (the end rule), where the start rule let the group run a fourth row.
  it.each([
    [384, ['Browse', 'Track', 'Orders', 'Help', 'Walk me through every single setting in this notebook app please', 'Last']],
    [384, ['A', 'B', 'C', 'D', 'E', 'F', 'Explain how sharing a notebook with my whole team works', 'G']],
    [240, ['Short one', 'Short two', 'A longer suggestion that has to wrap inside its pill here', 'Tail']],
  ] as const)('at %i px, a chip that wraps inside itself shows only if its rows end within the cap', async (width, labels) => {
    const one = await oneLineHeight(width);
    const free = await mount(width, labels, null);
    const page = await mount(width, labels, 3);
    try {
      const uncapped = (await readChips(free)).chips;
      const shown = (await readChips(page)).chips.filter((c) => c.shown);
      expect(shown.length).toBe(expectedShown(uncapped, 3, one));
      expect(lines(shown, one)).toBeLessThanOrEqual(3);
      expect(shown.filter((c) => c.clipped || c.ellipsis)).toEqual([]);
    } finally {
      await free.context().close();
      await page.context().close();
    }
  });

  it('the first chip always shows, whole, even when it alone runs past the cap', async () => {
    const huge = 'Walk me through every single setting in this notebook app, one at a time, slowly, and then once more from the top';
    const one = await oneLineHeight(160);
    const page = await mount(160, [huge, 'Second'], 3);
    try {
      const { chips } = await readChips(page);
      expect(chips[0]?.shown).toBe(true);
      expect(chips[0]?.clipped).toBe(false);
      expect(chipLines(chips[0]!, one)).toBeGreaterThan(3);
      expect(chips[1]?.shown).toBe(false);
      expect(await page.evaluate(TRUNCATED_CONTROLS_EXPRESSION)).toEqual([]);
    } finally {
      await page.context().close();
    }
  });

  it('a resize re-packs: narrowing hides more, widening shows them again, no chip past the group, no ResizeObserver loop error', async () => {
    const one = await oneLineHeight(384);
    const page = await mount(768, EIGHT, 3);
    const setWidth = (w: number) =>
      page.evaluate((px) => {
        const scope = document.querySelector<HTMLElement>('[class^="ggui-rcr"]');
        if (scope === null) throw new Error('no scope');
        scope.style.width = `${px}px`;
      }, w);
    try {
      const wide = (await readChips(page)).chips.filter((c) => c.shown).length;
      await setWidth(384);
      await page.waitForTimeout(100);
      const narrow = await readChips(page);
      const narrowShown = narrow.chips.filter((c) => c.shown);
      expect(narrowShown.length).toBeLessThan(wide);
      expect(lines(narrowShown, one)).toBeLessThanOrEqual(3);
      expect(narrowShown.every((c) => c.bottom <= narrow.groupBottom)).toBe(true);
      await setWidth(768);
      await page.waitForTimeout(100);
      expect((await readChips(page)).chips.filter((c) => c.shown).length).toBe(wide);
      expect(await page.evaluate(() => window.__errors ?? null)).toEqual([]);
    } finally {
      await page.context().close();
    }
  });

  it('unset (the default): no cap, every chip shows, the group runs as many rows as it needs', async () => {
    const one = await oneLineHeight(384);
    const page = await mount(384, EIGHT, null);
    try {
      const { chips } = await readChips(page);
      expect(chips.every((c) => c.shown)).toBe(true);
      expect(lines(chips, one)).toBeGreaterThan(3);
    } finally {
      await page.context().close();
    }
  });
});
