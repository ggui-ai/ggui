// ggui#1195 — the chat card at the DECLARED viewport. An order that says
// `shell: 'chat'` and declares a viewport composes at that box (the seam,
// `876d34007`) and must be JUDGED at it: the judge captures the inline card
// at the declared viewport, measures overflow against ITS ceiling, and the
// deterministic fit issue names both boxes so a refusal reads as "cut off at
// the order's 384×516, not at the class's 400×640". Absent a declared box,
// nothing changes — the class viewport stays the target (N−1).
//
// RED before `VisualEvalConfig.canvasViewports`, GREEN after.

import { describe, expect, it } from 'vitest';
import type { LaunchOptions } from 'puppeteer-core';
import { CANVAS_VIEWPORTS } from '../design-mode.js';
import {
  canvasOverflowIssue,
  runVisualEvaluationDetailed,
  summarizeVisualResult,
  type ScreenshotBrowser,
  type VisualEvalDeps,
} from './visual-evaluator.js';

const COMPONENT = 'export default function C(){ return null; }';
const CONTEXT = { compiledCode: COMPONENT, originalPrompt: 'a welcome card' };
/** The live-pixel chat column pinned on #1195 (2026-09-18): narrower AND shorter than the class box. */
const DECLARED = { width: 384, height: 516 } as const;

interface Capture { readonly width: number; readonly height: number; readonly fullPage: boolean }

function fitDeps(contentHeight: number, score = 85): VisualEvalDeps & { captures: Capture[] } {
  const captures: Capture[] = [];
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

describe('ggui#1195 — the inline card is captured and judged at the DECLARED viewport', () => {
  it('captures at the declared box, measures overflow against ITS ceiling, and the issue names both boxes', async () => {
    const deps = fitDeps(600);
    const { result } = await runVisualEvaluationDetailed(
      CONTEXT,
      { provider: 'claude', passThreshold: 70, canvases: ['xs-chat-card'], canvasViewports: { 'xs-chat-card': DECLARED } },
      deps,
    );
    expect(result).not.toBeNull();
    expect(deps.captures).toEqual([{ width: 384, height: 516, fullPage: false }]);
    const card = result!.canvases![0]!;
    expect(card.viewport).toEqual(DECLARED);
    expect(card.contentHeight).toBe(600);
    expect(card.overflow, '600px does not fit a 516px ceiling').toBe(true);
    expect(card.passed, 'the inline card fails on overflow').toBe(false);
    const issue = result!.issues.find((i) => i.dimension === 'canvas-overflow');
    expect(issue?.severity).toBe('critical');
    expect(issue?.description).toContain('declared 384×516');
    expect(issue?.description).toContain('400×640');
    expect(issue?.description).toContain('84px');
  });

  it('control — the same 600px content FITS the class box when no viewport is declared (N−1: today’s target)', async () => {
    const deps = fitDeps(600);
    const { result } = await runVisualEvaluationDetailed(CONTEXT, { provider: 'claude', passThreshold: 70, canvases: ['xs-chat-card'] }, deps);
    expect(deps.captures).toEqual([{ width: 400, height: 640, fullPage: false }]);
    const card = result!.canvases![0]!;
    expect(card.viewport).toEqual(CANVAS_VIEWPORTS['xs-chat-card']);
    expect(card.overflow).toBe(false);
    expect(card.passed).toBe(true);
    expect(result!.issues.some((i) => i.dimension === 'canvas-overflow')).toBe(false);
  });

  it('the summary carries the fit stamp — canvas, ceiling, declared, overflowPx — so the bar and the ledger read the same numbers', async () => {
    const declared = await runVisualEvaluationDetailed(
      CONTEXT,
      { provider: 'claude', passThreshold: 70, canvases: ['xs-chat-card', 'lg'], canvasViewports: { 'xs-chat-card': DECLARED } },
      fitDeps(600),
    );
    expect(summarizeVisualResult(declared.result!)?.fit).toEqual({ canvas: 'xs-chat-card', ceiling: DECLARED, declared: true, overflowPx: 84 });
    const classBox = await runVisualEvaluationDetailed(CONTEXT, { provider: 'claude', passThreshold: 70, canvases: ['xs-chat-card'] }, fitDeps(600));
    expect(summarizeVisualResult(classBox.result!)?.fit).toEqual({ canvas: 'xs-chat-card', ceiling: { width: 400, height: 640 }, declared: false, overflowPx: 0 });
    const pageOnly = await runVisualEvaluationDetailed(CONTEXT, { provider: 'claude', passThreshold: 70, canvases: ['lg'] }, fitDeps(600));
    expect(summarizeVisualResult(pageOnly.result!)?.fit, 'no fail-policy canvas judged ⇒ no stamp').toBeUndefined();
    // Declared means CARRIED — an order that declares exactly the class box is still a declaration.
    const declaredClassBox = await runVisualEvaluationDetailed(
      CONTEXT,
      { provider: 'claude', passThreshold: 70, canvases: ['xs-chat-card'], canvasViewports: { 'xs-chat-card': { width: 400, height: 640 } } },
      fitDeps(600),
    );
    expect(summarizeVisualResult(declaredClassBox.result!)?.fit).toEqual({ canvas: 'xs-chat-card', ceiling: { width: 400, height: 640 }, declared: true, overflowPx: 0 });
  });

  it('canvasOverflowIssue names the declared box beside the class box only when they differ', () => {
    const declared = canvasOverflowIssue('xs-chat-card', DECLARED, 600, 'fail');
    expect(declared.description).toContain('declared 384×516');
    expect(declared.description).toContain('class box 400×640');
    expect(declared.description).toContain('84px is cut off');
    const classBox = canvasOverflowIssue('xs-chat-card', CANVAS_VIEWPORTS['xs-chat-card'], 1289, 'fail');
    expect(classBox.description).toContain('400×640');
    expect(classBox.description).not.toContain('declared');
    expect(classBox.description).toContain('649px is cut off');
  });
});
