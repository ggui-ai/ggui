// `runVisualFit` — the visual leg's deterministic half, taken without the
// vision judge. The fit verdict is a frame at each canvas's box (the declared
// one when the order carried it, else the class box) and the document's
// scroll height against the box's height, judged by the canvas's fit policy:
// it needs a browser and nothing else, so a lane with no vision judge can
// still be told its chat card is cut off. Same frame, same measure and same
// issue as the judge path — only the score is absent.
//
// RED before `runVisualFit`, GREEN after.

import { describe, expect, it } from 'vitest';
import type { LaunchOptions } from 'puppeteer-core';
import { runVisualEvaluationDetailed, runVisualFit, type ScreenshotBrowser, type VisualEvalDeps } from './visual-evaluator.js';

const COMPONENT = 'export default function C(){ return null; }';
const CONTEXT = { compiledCode: COMPONENT, originalPrompt: 'a welcome card' };
const DECLARED = { width: 384, height: 516 } as const;

interface Capture { readonly width: number; readonly height: number; readonly fullPage: boolean }

function frameDeps(contentHeight: number): VisualEvalDeps & { captures: Capture[]; judged: () => number } {
  const captures: Capture[] = [];
  let judged = 0;
  const launch = async (o: LaunchOptions): Promise<ScreenshotBrowser> => {
    const width = o.defaultViewport?.width ?? 0;
    const height = o.defaultViewport?.height ?? 0;
    return {
      newPage: async () => ({
        setContent: async () => {},
        waitForNetworkIdle: async () => {},
        waitForSelector: async () => null,
        evaluate: async () => contentHeight,
        screenshot: async (opts: { fullPage: boolean }) => {
          captures.push({ width, height, fullPage: opts.fullPage });
          return new Uint8Array([1, 2, 3]);
        },
      }),
      close: async () => {},
    };
  };
  return {
    captures,
    judged: () => judged,
    launch,
    env: { PUPPETEER_EXECUTABLE_PATH: '/fake/chromium' },
    settleMs: 0,
    judge: async () => {
      judged += 1;
      return { text: JSON.stringify({ completeness: 85, layout: 85, hierarchy: 85, aesthetics: 85, issues: [], critique: 'fine' }), inputTokens: 10, outputTokens: 5 };
    },
  };
}

describe('runVisualFit — the fit verdict without the vision judge', () => {
  it('frames the card at the declared box, measures it against that ceiling, and fails it with the judge path’s own issue — no judge call', async () => {
    const deps = frameDeps(535);
    const outcome = await runVisualFit(CONTEXT, { canvases: ['xs-chat-card'], canvasViewports: { 'xs-chat-card': DECLARED } }, deps);

    expect(deps.judged(), 'the fit half never calls the judge').toBe(0);
    expect(deps.captures).toEqual([{ width: 384, height: 516, fullPage: false }]);
    expect(outcome.status).toBe('measured');
    if (outcome.status !== 'measured') return;
    expect(outcome.readings).toEqual([{ canvas: 'xs-chat-card', viewport: DECLARED, contentHeight: 535, overflow: true, inkRatio: null, declared: true }]);
    expect(outcome.issues).toHaveLength(1);
    const issue = outcome.issues[0]!;
    expect(issue).toMatchObject({ tier: 2, result: 'fail', category: 'visual', subcategory: 'canvas-overflow', severity: 'critical' });
    expect(issue.description).toContain('[xs-chat-card]');
    expect(issue.description).toContain('declared 384×516');
    expect(issue.description).toContain('19px is cut off');
  });

  it('the same frame through the judge path yields the SAME fit issue — one verdict, two ways to reach it', async () => {
    const config = { canvases: ['xs-chat-card'] as const, canvasViewports: { 'xs-chat-card': DECLARED } };
    const fit = await runVisualFit(CONTEXT, config, frameDeps(535));
    const judged = await runVisualEvaluationDetailed(CONTEXT, { provider: 'claude', passThreshold: 70, ...config }, frameDeps(535));
    const judgedFit = judged.result!.issues.find((i) => i.dimension === 'canvas-overflow');
    expect(fit.status).toBe('measured');
    if (fit.status !== 'measured') return;
    expect(fit.issues[0]?.description).toBe(judgedFit?.description);
    expect(fit.issues[0]?.fix).toBe(judgedFit?.fix);
  });

  it('a card that fits its box earns no issue', async () => {
    const outcome = await runVisualFit(CONTEXT, { canvases: ['xs-chat-card'], canvasViewports: { 'xs-chat-card': DECLARED } }, frameDeps(516));
    expect(outcome).toEqual({
      status: 'measured',
      issues: [],
      readings: [{ canvas: 'xs-chat-card', viewport: DECLARED, contentHeight: 516, overflow: false, inkRatio: null, declared: true }],
    });
  });

  it('each canvas answers to its own fit policy: the phone warns, a page is measured and never judged', async () => {
    const outcome = await runVisualFit(CONTEXT, { canvases: ['mobile-fullscreen-small', 'lg'] }, frameDeps(1200));
    expect(outcome.status).toBe('measured');
    if (outcome.status !== 'measured') return;
    expect(outcome.issues.map((i) => [i.subcategory, i.result])).toEqual([['canvas-overflow', 'warn']]);
    expect(outcome.readings.map((r) => [r.canvas, r.overflow])).toEqual([
      ['mobile-fullscreen-small', true],
      ['lg', true],
    ]);
  });

  it('without canvases there is no fit verdict: unavailable, with the reason', async () => {
    const deps = frameDeps(535);
    const outcome = await runVisualFit(CONTEXT, {}, deps);
    expect(outcome.status).toBe('unavailable');
    expect(deps.captures).toHaveLength(0);
  });

  it('a frame that cannot be taken is unavailable with the capture’s own reason, never a pass', async () => {
    const outcome = await runVisualFit(CONTEXT, { canvases: ['xs-chat-card'] }, {
      launch: async () => {
        throw new Error('no chromium here');
      },
      env: { PUPPETEER_EXECUTABLE_PATH: '/fake/chromium' },
      settleMs: 0,
    });
    expect(outcome.status).toBe('unavailable');
    if (outcome.status !== 'unavailable') return;
    expect(outcome.reason).toContain('no chromium here');
  });
});
