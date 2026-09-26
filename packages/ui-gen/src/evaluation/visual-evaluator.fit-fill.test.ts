/**
 * Pin (ggui#1100): fit@judge == fit@runtime. The served runtime composes
 * every fullscreen surface with `fit: 'fill'` (the mounted root stretched to
 * the frame) and leaves the inline card at its natural height; the judge
 * composes each canvas the same way — the page for `md` / `lg` / `xl` /
 * `mobile-fullscreen-small` carries the design's `fillFitRule` on the mount
 * element's scope class, the page for `xs-chat-card` does not — and stamps
 * `fit` on the per-canvas record so the row says how the judge composed.
 * Candidate 34's hellos were judged as a short block on an empty 768×1024
 * page after ggui#1098 removed the component's own `100vh`; the served
 * frame never looked like that.
 */
import { describe, expect, it } from 'vitest';
import type { LaunchOptions } from 'puppeteer-core';
import { expandedFramePanelRule, expandedFrameScrimDecls, fillFitRule } from '@ggui-ai/design/rendering';
import { CANVAS_CLASSES, displayModeForCanvas } from '../design-mode.js';
import {
  JUDGE_PANEL_CLASS,
  JUDGE_SCOPE_CLASS,
  buildRenderHTML,
  canvasChrome,
  canvasFit,
  judgeWindow,
  runVisualEvaluationDetailed,
  summarizeVisualResult,
  type ScreenshotBrowser,
  type VisualEvalDeps,
} from './visual-evaluator.js';

const COMPONENT = 'export default function C(){ return null; }';

function deps(score = 85): VisualEvalDeps & { pages: string[] } {
  const pages: string[] = [];
  const launch = async (_o: LaunchOptions): Promise<ScreenshotBrowser> => ({
    newPage: async () => ({
      setContent: async (html: string) => {
        pages.push(html);
      },
      waitForNetworkIdle: async () => {},
      waitForSelector: async () => null,
      evaluate: async () => 500,
      screenshot: async () => new Uint8Array([1, 2, 3]),
    }),
    close: async () => {},
  });
  return {
    pages,
    launch,
    env: { PUPPETEER_EXECUTABLE_PATH: '/fake/chromium' },
    settleMs: 0,
    judge: async () => ({
      text: JSON.stringify({ completeness: score, layout: score, hierarchy: score, aesthetics: score, issues: [], critique: 'fine' }),
      inputTokens: 10,
      outputTokens: 5,
    }),
  };
}

describe('fit@judge == fit@runtime (ggui#1100)', () => {
  it('the inline card is the only content-sized canvas; every other canvas fills', () => {
    expect(displayModeForCanvas('xs-chat-card')).toBe('inline');
    expect(canvasFit('xs-chat-card')).toBeUndefined();
    for (const c of ['mobile-fullscreen-small', 'md', 'lg', 'xl'] as const) {
      expect(displayModeForCanvas(c)).toBe('fullscreen');
      expect(canvasFit(c)).toBe('fill');
    }
  });

  it("the judge page carries the design's fill rule on the mount scope only when composed with fit: 'fill'", () => {
    const filled = buildRenderHTML(COMPONENT, undefined, 'fill');
    expect(filled).toContain(`<div id="root" class="${JUDGE_SCOPE_CLASS}">`);
    expect(filled).toContain(fillFitRule(JUDGE_SCOPE_CLASS));
    const inline = buildRenderHTML(COMPONENT);
    expect(inline).toContain('<div id="root"></div>');
    expect(inline).not.toContain(JUDGE_SCOPE_CLASS);
    expect(inline).not.toContain('min-height: 100vh');
  });

  it('per canvas: md is served the filled page and stamps fit, xs-chat-card is served the plain page and stamps nothing', async () => {
    const d = deps();
    const { result } = await runVisualEvaluationDetailed(
      { compiledCode: COMPONENT, originalPrompt: 'a welcome card' },
      { provider: 'claude', passThreshold: 70, canvases: ['xs-chat-card', 'md'] },
      d,
    );
    expect(result).not.toBeNull();
    expect(d.pages).toHaveLength(2);
    const [xsPage, mdPage] = d.pages;
    expect(xsPage).not.toContain(JUDGE_SCOPE_CLASS);
    expect(mdPage).toContain(`class="${JUDGE_SCOPE_CLASS}"`);
    expect(mdPage).toContain(fillFitRule(JUDGE_SCOPE_CLASS));
    const [xs, md] = result!.canvases!;
    expect(xs.fit).toBeUndefined();
    expect(md.fit).toBe('fill');
    const summary = summarizeVisualResult(result!)!;
    expect(summary.canvases.map((c) => [c.canvas, c.fit])).toEqual([
      ['xs-chat-card', undefined],
      ['md', 'fill'],
    ]);
    expect('fit' in summary.canvases[0]!).toBe(false);
  });
});

/** The fake browser, recording the WINDOW each launch asked for and answering every height read with `documentHeight`. */
function chromeDeps(documentHeight: number): VisualEvalDeps & { pages: string[]; windows: Array<{ width: number; height: number }> } {
  const pages: string[] = [];
  const windows: Array<{ width: number; height: number }> = [];
  const launch = async (o: LaunchOptions): Promise<ScreenshotBrowser> => {
    if (o.defaultViewport === null || o.defaultViewport === undefined) throw new Error('the judge always sets a window');
    windows.push({ width: o.defaultViewport.width, height: o.defaultViewport.height });
    return {
      newPage: async () => ({
        setContent: async (html: string) => {
          pages.push(html);
        },
        waitForNetworkIdle: async () => {},
        waitForSelector: async () => null,
        evaluate: async () => documentHeight,
        screenshot: async () => new Uint8Array([1, 2, 3]),
      }),
      close: async () => {},
    };
  };
  return {
    pages,
    windows,
    launch,
    env: { PUPPETEER_EXECUTABLE_PATH: '/fake/chromium' },
    settleMs: 0,
    judge: async () => ({
      text: JSON.stringify({ completeness: 85, layout: 85, hierarchy: 85, aesthetics: 85, issues: [], critique: 'fine' }),
      inputTokens: 10,
      outputTokens: 5,
    }),
  };
}

describe("the judge draws the host stand-in's panel round a fill canvas (ggui#1083 cut 3)", () => {
  it('the panel canvases are the fill canvases from md up; the phone canvas and the inline card carry no chrome', () => {
    expect(CANVAS_CLASSES.map((c) => [c, canvasChrome(c)])).toEqual([
      ['xs-chat-card', undefined],
      ['mobile-fullscreen-small', undefined],
      ['md', 'panel'],
      ['lg', 'panel'],
      ['xl', 'panel'],
    ]);
  });

  it("the panelled page carries the design's panel rule and mounts the scope inside the panel; a fill page without chrome does not; a panel without fill is refused", () => {
    const panelled = buildRenderHTML(COMPONENT, undefined, 'fill', 'panel');
    expect(panelled).toContain(expandedFramePanelRule(JUDGE_PANEL_CLASS, JUDGE_SCOPE_CLASS));
    expect(panelled).toContain(fillFitRule(JUDGE_SCOPE_CLASS));
    expect(panelled).toContain(`<div class="${JUDGE_PANEL_CLASS}"><div id="root" class="${JUDGE_SCOPE_CLASS}"></div></div>`);
    expect(panelled).toContain(expandedFrameScrimDecls());
    const filled = buildRenderHTML(COMPONENT, undefined, 'fill');
    expect(filled).not.toContain(JUDGE_PANEL_CLASS);
    expect(filled).toContain(expandedFrameScrimDecls());
    expect(() => buildRenderHTML(COMPONENT, undefined, undefined, 'panel')).toThrow(/fill canvas only/);
  });

  it("the window is the canvas box plus the panel's gap on every side; without chrome it is the canvas box", () => {
    expect(judgeWindow({ width: 768, height: 1024 }, 'panel')).toEqual({ width: 800, height: 1056 });
    expect(judgeWindow({ width: 390, height: 844 }, undefined)).toEqual({ width: 390, height: 844 });
  });

  it("per canvas: md is captured at the padded window, reported at the canvas box, and its content height is the CARD's; the phone canvas is unchanged", async () => {
    const d = chromeDeps(1056);
    const { result } = await runVisualEvaluationDetailed(
      { compiledCode: COMPONENT, originalPrompt: 'a welcome card' },
      { provider: 'claude', passThreshold: 70, canvases: ['mobile-fullscreen-small', 'md'] },
      d,
    );
    expect(result).not.toBeNull();
    expect(d.windows).toEqual([
      { width: 390, height: 844 },
      { width: 800, height: 1056 },
    ]);
    const [phonePage, mdPage] = d.pages;
    expect(phonePage).not.toContain(JUDGE_PANEL_CLASS);
    expect(mdPage).toContain(expandedFramePanelRule(JUDGE_PANEL_CLASS, JUDGE_SCOPE_CLASS));
    const [phone, md] = result!.canvases!;
    // The phone page IS the document: 1056 px of content on an 844 px canvas overflows.
    expect(phone.viewport).toEqual({ width: 390, height: 844 });
    expect(phone.contentHeight).toBe(1056);
    expect(phone.overflow).toBe(true);
    // The md document is the panel plus its gap: a 1056 px document is a 1024 px card, which fills the canvas exactly.
    expect(md.viewport).toEqual({ width: 768, height: 1024 });
    expect(md.contentHeight).toBe(1024);
    expect(md.overflow).toBe(false);
  });

  it('a document shorter than the gap laid out no panel: the card height is unmeasurable, never negative', async () => {
    const d = chromeDeps(0);
    const { result } = await runVisualEvaluationDetailed(
      { compiledCode: COMPONENT, originalPrompt: 'a welcome card' },
      { provider: 'claude', passThreshold: 70, canvases: ['xs-chat-card', 'md'] },
      d,
    );
    const [xs, md] = result!.canvases!;
    expect(xs.contentHeight).toBe(0);
    expect(md.contentHeight).toBeNull();
    expect(md.overflow).toBe(false);
  });
});
