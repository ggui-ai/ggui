/**
 * Pin (ggui#1027, ggui#1475): the judge sees what the user sees. The inline
 * chat card is captured at its NATURAL height — the card's own extent on the
 * host's ground, capped at the box, measured from the mount, never the
 * document — and an overflow past the box is a critical `canvas-overflow`
 * issue that fails the canvas (the box is the ceiling);
 * on a phone's first screen it is reported as major and the score stands;
 * pages are measured, never judged. A failed measurement never breaks
 * the round. Browser + judge are injected.
 */
import { describe, expect, it } from 'vitest';
import type { LaunchOptions } from 'puppeteer-core';
import { EXPANDED_FRAME } from '@ggui-ai/design/rendering';
import { CANVAS_VIEWPORTS } from '../design-mode.js';
import {
  CARD_HEIGHT_EXPRESSION,
  CONTENT_HEIGHT_EXPRESSION,
  JUDGE_GROUND_CLASS,
  JUDGE_GROUND_MARGIN_PX,
  JUDGE_PANEL_CLASS,
  canvasChrome,
  canvasFitPolicy,
  judgeWindow,
  naturalClip,
  canvasOverflowIssue,
  runVisualEvaluationDetailed,
  summarizeVisualResult,
  type ScreenshotBrowser,
  type VisualEvalDeps,
} from './visual-evaluator.js';

const COMPONENT = 'export default function C(){ return null; }';

interface Capture { readonly width: number; readonly fullPage: boolean; readonly clip?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } }

function fitDeps(contentHeight: number | (() => Promise<number>), score = 85): VisualEvalDeps & { captures: Capture[]; expressions: string[]; pages: string[] } {
  const captures: Capture[] = [];
  const expressions: string[] = [];
  const pages: string[] = [];
  const launch = async (o: LaunchOptions): Promise<ScreenshotBrowser> => {
    const width = o.defaultViewport?.width ?? 0;
    // A real page's document is the card plus the panel's gap when the judge drew the panel (ggui#1083 cut 3).
    let panelled = false;
    return {
      newPage: async () => ({
        setContent: async (html: string) => {
          pages.push(html);
          panelled = html.includes(JUDGE_PANEL_CLASS);
        },
        waitForNetworkIdle: async () => {},
        waitForSelector: async () => null,
        evaluate: async (expression: string) => {
          expressions.push(expression);
          const card = typeof contentHeight === 'function' ? await contentHeight() : contentHeight;
          return card + (panelled ? 2 * EXPANDED_FRAME.insetPx : 0);
        },
        screenshot: async (opts: { fullPage: boolean; clip?: Capture['clip'] }) => {
          captures.push({ width, fullPage: opts.fullPage, ...(opts.clip !== undefined ? { clip: opts.clip } : {}) });
          return new Uint8Array([1, 2, 3]);
        },
      }),
      close: async () => {},
    };
  };
  return {
    captures,
    expressions,
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

const M = JUDGE_GROUND_MARGIN_PX;

describe('canvasFitPolicy', () => {
  it('inline card: natural capture + fail; phone: full page + warn; pages: full page, measured only', () => {
    expect(canvasFitPolicy('xs-chat-card')).toEqual({ capture: 'natural', overflow: 'fail' });
    expect(canvasFitPolicy('mobile-fullscreen-small')).toEqual({ capture: 'full-page', overflow: 'warn' });
    for (const c of ['md', 'lg', 'xl'] as const) expect(canvasFitPolicy(c)).toEqual({ capture: 'full-page', overflow: 'none' });
  });
  it('the overflow issue names the numbers and rides the judge issue channel (critical → fail, major → warn)', () => {
    const issue = canvasOverflowIssue('xs-chat-card', CANVAS_VIEWPORTS['xs-chat-card'], 1289, 'fail');
    expect(issue.dimension).toBe('canvas-overflow');
    expect(issue.severity).toBe('critical');
    expect(issue.description).toContain('1289px');
    expect(issue.description).toContain('400×640');
    expect(issue.description).toContain('649px is cut off');
    expect(canvasOverflowIssue('mobile-fullscreen-small', CANVAS_VIEWPORTS['mobile-fullscreen-small'], 1289, 'warn').severity).toBe('major');
  });
});

describe('ggui#1475 — the inline card is captured as a size-honouring host shows it: its natural height, on the host ground', () => {
  it('xs carries the ground chrome (the design gap on every side); every other canvas keeps its own', () => {
    expect(M).toBe(EXPANDED_FRAME.insetPx);
    expect(canvasChrome('xs-chat-card')).toBe('ground');
    expect(canvasChrome('mobile-fullscreen-small')).toBeUndefined();
    for (const c of ['md', 'lg', 'xl'] as const) expect(canvasChrome(c)).toBe('panel');
    expect(judgeWindow({ width: 384, height: 516 }, 'ground')).toEqual({ width: 384 + 2 * M, height: 516 + 2 * M });
  });
  it("the card is measured as the MCP Apps SDK measures it for the host's size report: the document at max-content, the ground margin removed, the style restored", () => {
    // The SDK's size-changed notification reads `documentElement` at `height: max-content` (so content outside the
    // mount — a portal into body — counts for the host), not the mount's rect.
    expect(CARD_HEIGHT_EXPRESSION).toContain("style.height = 'max-content'");
    expect(CARD_HEIGHT_EXPRESSION).toContain('Math.ceil(el.getBoundingClientRect().height)');
    expect(CARD_HEIGHT_EXPRESSION).toContain(`- ${2 * M}`);
    expect(CARD_HEIGHT_EXPRESSION).toContain('el.style.height = prev');
    expect(CARD_HEIGHT_EXPRESSION).not.toContain("getElementById('root')");
  });
  it('the clip is the card plus the ground margin, capped at the box; a card that painted nothing keeps one row (read as a blank, never unreadable)', () => {
    const window = { width: 400 + 2 * M, height: 640 + 2 * M };
    expect(naturalClip(window, 280)).toEqual({ x: 0, y: 0, width: 400 + 2 * M, height: 280 + 2 * M });
    expect(naturalClip(window, 279.2)).toEqual({ x: 0, y: 0, width: 400 + 2 * M, height: 280 + 2 * M });
    expect(naturalClip(window, 1289)).toEqual({ x: 0, y: 0, width: 400 + 2 * M, height: 640 + 2 * M });
    expect(naturalClip(window, 0)).toEqual({ x: 0, y: 0, width: 400 + 2 * M, height: 1 + 2 * M });
  });
  it('a 280px hello on the 640px card: captured at 280 + the margin, measured from the mount, no overflow, no void under it', async () => {
    const deps = fitDeps(280);
    const { result } = await runVisualEvaluationDetailed(
      { compiledCode: COMPONENT, originalPrompt: 'a greeting card' },
      { provider: 'claude', passThreshold: 70, canvases: ['xs-chat-card'] },
      deps,
    );
    expect(deps.expressions).toEqual([CARD_HEIGHT_EXPRESSION]);
    expect(deps.captures).toEqual([{ width: 400 + 2 * M, fullPage: false, clip: { x: 0, y: 0, width: 400 + 2 * M, height: 280 + 2 * M } }]);
    expect(deps.pages[0]).toContain(`class="${JUDGE_GROUND_CLASS}"`);
    expect(result!.canvases![0]).toMatchObject({ canvas: 'xs-chat-card', contentHeight: 280, overflow: false, passed: true, viewport: { width: 400, height: 640 } });
  });
  it('a declared box (#1195) mounts the card at the declared width, on the ground', async () => {
    const deps = fitDeps(300);
    const { result } = await runVisualEvaluationDetailed(
      { compiledCode: COMPONENT, originalPrompt: 'a greeting card' },
      { provider: 'claude', passThreshold: 70, canvases: ['xs-chat-card'], canvasViewports: { 'xs-chat-card': { width: 384, height: 516 } } },
      deps,
    );
    expect(deps.captures).toEqual([{ width: 384 + 2 * M, fullPage: false, clip: { x: 0, y: 0, width: 384 + 2 * M, height: 300 + 2 * M } }]);
    expect(result!.canvases![0]).toMatchObject({ contentHeight: 300, overflow: false, viewport: { width: 384, height: 516 } });
  });
  it('only the inline card is framed on the ground: the phone and the pages build no ground', async () => {
    const deps = fitDeps(600);
    await runVisualEvaluationDetailed(
      { compiledCode: COMPONENT, originalPrompt: 'a greeting card' },
      { provider: 'claude', passThreshold: 70, canvases: ['mobile-fullscreen-small', 'md'] },
      deps,
    );
    expect(deps.pages.some((h) => h.includes(`class="${JUDGE_GROUND_CLASS}"`))).toBe(false);
  });
});

describe('the fit measurement in the per-canvas round (ggui#1027)', () => {
  it('a 1289px hello: the inline card is captured capped at its box and FAILS; the phone warns; the page is only measured', async () => {
    const deps = fitDeps(1289);
    const { result } = await runVisualEvaluationDetailed(
      { compiledCode: COMPONENT, originalPrompt: 'a greeting card' },
      { provider: 'claude', passThreshold: 70, canvases: ['xs-chat-card', 'mobile-fullscreen-small', 'lg'] },
      deps,
    );
    expect(result).not.toBeNull();
    // The inline card is measured from its mount (ggui#1475); every other canvas from the document, as before.
    expect(deps.expressions).toEqual([CARD_HEIGHT_EXPRESSION, CONTENT_HEIGHT_EXPRESSION, CONTENT_HEIGHT_EXPRESSION]);
    expect(deps.captures).toEqual([
      // xs on the host ground, clipped to the card and capped at its box (ggui#1475).
      { width: 400 + 2 * M, fullPage: false, clip: { x: 0, y: 0, width: 400 + 2 * M, height: 640 + 2 * M } },
      { width: 390, fullPage: true },
      // lg is captured at its window: the class box plus the host panel's gap (ggui#1083 cut 3).
      { width: 1056, fullPage: true },
    ]);
    const [xs, mfs, lg] = result!.canvases!;
    expect(xs).toMatchObject({ canvas: 'xs-chat-card', contentHeight: 1289, overflow: true, score: 85, passed: false });
    expect(mfs).toMatchObject({ canvas: 'mobile-fullscreen-small', contentHeight: 1289, overflow: true, score: 85, passed: true });
    expect(lg).toMatchObject({ canvas: 'lg', contentHeight: 1289, overflow: true, score: 85, passed: true });
    // one issue per judged overflow, prefixed with its canvas; none for the page
    const overflowIssues = result!.issues.filter((i) => i.dimension === 'canvas-overflow');
    expect(overflowIssues.map((i) => [i.severity, i.description.slice(0, 26)])).toEqual([
      ['critical', '[xs-chat-card] Rendered co'],
      ['major', '[mobile-fullscreen-small] '],
    ]);
    expect(result!.passed).toBe(false);
    expect(result!.finalScore).toBe(85); // the score is the judge's; the verdict is the policy's
    expect(summarizeVisualResult(result!)!.canvases.map((c) => [c.canvas, c.contentHeight, c.overflow, c.passed])).toEqual([
      ['xs-chat-card', 1289, true, false],
      ['mobile-fullscreen-small', 1289, true, true],
      ['lg', 1289, true, true],
    ]);
  });

  it("the judge's end of the sentence: per canvas, passed === (score >= passThreshold) && !(overflow && fit policy 'fail'); the score is never touched by the fit", async () => {
    // The pin both ends of the wire now state (ggui#1027): a reader of `passed` on a
    // cell must be able to say WHY from the canvas's own numbers — score vs threshold,
    // overflow vs the canvas's fit policy. A future change to the policy or the
    // threshold reds this test instead of reading as a smell on a served cell.
    const passThreshold = 70;
    const canvases = ['xs-chat-card', 'mobile-fullscreen-small', 'md'] as const;
    for (const score of [passThreshold - 1, passThreshold]) {
      for (const contentHeight of [600, 1289]) {
        const deps = fitDeps(contentHeight, score);
        const { result } = await runVisualEvaluationDetailed(
          { compiledCode: COMPONENT, originalPrompt: 'a greeting card' },
          { provider: 'claude', passThreshold, canvases: [...canvases] },
          deps,
        );
        expect(result).not.toBeNull();
        for (const c of result!.canvases!) {
          const overflow = contentHeight > CANVAS_VIEWPORTS[c.canvas].height;
          const expected = score >= passThreshold && !(overflow && canvasFitPolicy(c.canvas).overflow === 'fail');
          expect([c.canvas, score, contentHeight, c.score, c.overflow, c.passed]).toEqual([c.canvas, score, contentHeight, score, overflow, expected]);
        }
        expect(result!.finalScore).toBe(score);
        expect(result!.passed).toBe(result!.canvases!.every((c) => c.passed));
      }
    }
  });

  it('a 600px card fits everywhere: no overflow, no issue, passed by the score', async () => {
    const deps = fitDeps(600);
    const { result } = await runVisualEvaluationDetailed(
      { compiledCode: COMPONENT, originalPrompt: 'a greeting card' },
      { provider: 'claude', passThreshold: 70, canvases: ['xs-chat-card', 'mobile-fullscreen-small'] },
      deps,
    );
    expect(result!.canvases!.every((c) => c.contentHeight === 600 && !c.overflow && c.passed)).toBe(true);
    expect(result!.issues.some((i) => i.dimension === 'canvas-overflow')).toBe(false);
    expect(result!.passed).toBe(true);
  });

  it('a failed measurement is reported as null and never breaks the round', async () => {
    const deps = fitDeps(async () => { throw new Error('evaluate unavailable'); });
    const { result, unavailableReason } = await runVisualEvaluationDetailed(
      { compiledCode: COMPONENT, originalPrompt: 'a greeting card' },
      { provider: 'claude', passThreshold: 70, canvases: ['xs-chat-card'] },
      deps,
    );
    expect(unavailableReason).toBeUndefined();
    expect(result!.canvases![0]).toMatchObject({ contentHeight: null, overflow: false, passed: true });
    // An unmeasured card is captured at its whole box — never a zero-height frame.
    expect(deps.captures).toEqual([{ width: 400 + 2 * M, fullPage: false, clip: { x: 0, y: 0, width: 400 + 2 * M, height: 640 + 2 * M } }]);
  });

  it("single-shot mode (no canvases) keeps today's full-page capture", async () => {
    const deps = fitDeps(1289);
    const { result } = await runVisualEvaluationDetailed(
      { compiledCode: COMPONENT, originalPrompt: 'a greeting card' },
      { provider: 'claude', passThreshold: 70, viewport: { width: 400, height: 640 } },
      deps,
    );
    expect(result!.canvases).toBeUndefined();
    expect(deps.captures).toEqual([{ width: 400, fullPage: true }]);
    expect(result!.issues.some((i) => i.dimension === 'canvas-overflow')).toBe(false);
  });
});
