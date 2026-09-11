/**
 * Pin (ggui#1027): the judge sees what the user sees. On the inline chat
 * card the capture is the VIEWPORT and an overflow is a critical
 * `canvas-overflow` issue that fails the canvas (the box does not scroll);
 * on a phone's first screen it is reported as major and the score stands;
 * pages are measured, never judged. A failed measurement never breaks
 * the round. Browser + judge are injected.
 */
import { describe, expect, it } from 'vitest';
import type { LaunchOptions } from 'puppeteer-core';
import { CANVAS_VIEWPORTS } from '../design-mode.js';
import {
  CONTENT_HEIGHT_EXPRESSION,
  canvasFitPolicy,
  canvasOverflowIssue,
  runVisualEvaluationDetailed,
  summarizeVisualResult,
  type ScreenshotBrowser,
  type VisualEvalDeps,
} from './visual-evaluator.js';

const COMPONENT = 'export default function C(){ return null; }';

interface Capture { readonly width: number; readonly fullPage: boolean }

function fitDeps(contentHeight: number | (() => Promise<number>), score = 85): VisualEvalDeps & { captures: Capture[]; expressions: string[] } {
  const captures: Capture[] = [];
  const expressions: string[] = [];
  const launch = async (o: LaunchOptions): Promise<ScreenshotBrowser> => {
    const width = o.defaultViewport?.width ?? 0;
    return {
      newPage: async () => ({
        setContent: async () => {},
        waitForNetworkIdle: async () => {},
        waitForSelector: async () => null,
        evaluate: async (expression: string) => {
          expressions.push(expression);
          return typeof contentHeight === 'function' ? contentHeight() : contentHeight;
        },
        screenshot: async (opts: { fullPage: boolean }) => {
          captures.push({ width, fullPage: opts.fullPage });
          return new Uint8Array([1, 2, 3]);
        },
      }),
      close: async () => {},
    };
  };
  return {
    captures,
    expressions,
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

describe('canvasFitPolicy', () => {
  it('inline card: viewport capture + fail; phone: full page + warn; pages: full page, measured only', () => {
    expect(canvasFitPolicy('xs-chat-card')).toEqual({ capture: 'viewport', overflow: 'fail' });
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

describe('the fit measurement in the per-canvas round (ggui#1027)', () => {
  it('a 1289px hello: the inline card is captured at the viewport and FAILS; the phone warns; the page is only measured', async () => {
    const deps = fitDeps(1289);
    const { result } = await runVisualEvaluationDetailed(
      { compiledCode: COMPONENT, originalPrompt: 'a greeting card' },
      { provider: 'claude', passThreshold: 70, canvases: ['xs-chat-card', 'mobile-fullscreen-small', 'lg'] },
      deps,
    );
    expect(result).not.toBeNull();
    expect(deps.expressions.every((e) => e === CONTENT_HEIGHT_EXPRESSION)).toBe(true);
    expect(deps.captures).toEqual([
      { width: 400, fullPage: false },
      { width: 390, fullPage: true },
      { width: 1024, fullPage: true },
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
    expect(deps.captures).toEqual([{ width: 400, fullPage: false }]);
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
