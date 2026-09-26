/**
 * Per-canvas visual judging — ARM-NEUTRAL (the same judge either design
 * mode). With `config.canvases` set, `runVisualEvaluation` renders the
 * SAME html shell once per class at `CANVAS_VIEWPORTS[class]` (in a window
 * padded by the host panel's gap on md/lg/xl — ggui#1083 cut 3), judges
 * each screenshot, returns one `{canvas, viewport, score, passed,
 * screenshotPng}` per class, and folds them into the single-shot fields
 * (score = mean, passed = every canvas passed). Unset = today's single
 * screenshot and NO `canvases` field. Browser + judge are injected.
 */
import { describe, expect, it } from 'vitest';
import type { LaunchOptions } from 'puppeteer-core';
import { EXPANDED_FRAME } from '@ggui-ai/design/rendering';
import { CANVAS_CLASSES, CANVAS_VIEWPORTS } from '../design-mode.js';
import {
  JUDGE_PANEL_CLASS,
  canvasChrome,
  judgeWindow,
  runVisualEvaluation,
  runVisualEval,
  summarizeVisualResult,
  type ScreenshotBrowser,
  type VisualEvalDeps,
} from './visual-evaluator.js';

const COMPONENT = 'export default function C(){ return null; }';

/** A launcher whose screenshots are stamped with the launch viewport width so each PNG is attributable. */
function recordingDeps(scores: readonly number[]): VisualEvalDeps & { launched: LaunchOptions[]; judged: number[] } {
  const launched: LaunchOptions[] = [];
  const judged: number[] = [];
  let call = 0;
  const launch = async (o: LaunchOptions): Promise<ScreenshotBrowser> => {
    launched.push(o);
    const width = o.defaultViewport?.width ?? 0;
    // A real page's document is the card plus the panel's gap when the judge drew the panel (ggui#1083 cut 3).
    let panelled = false;
    return {
      newPage: async () => ({
        setContent: async (html: string) => {
          panelled = html.includes(JUDGE_PANEL_CLASS);
        },
        waitForNetworkIdle: async () => {},
        waitForSelector: async () => null,
        evaluate: async () => (panelled ? 2 * EXPANDED_FRAME.insetPx : 0),
        screenshot: async () => new Uint8Array([width >> 8, width & 0xff]),
      }),
      close: async () => {},
    };
  };
  return {
    launched,
    judged,
    launch,
    env: { PUPPETEER_EXECUTABLE_PATH: '/fake/chromium' },
    settleMs: 0,
    judge: async (_config, _model, _prompt, screenshot) => {
      judged.push(screenshot.readUInt16BE(0));
      const s = scores[call++ % scores.length]!;
      return {
        text: JSON.stringify({ completeness: s, layout: s, hierarchy: s, aesthetics: s, issues: s < 70 ? [{ dimension: 'layout', severity: 'major', description: 'cramped', fix: 'space' }] : [], critique: `c${s}` }),
        inputTokens: 10,
        outputTokens: 5,
      };
    },
  };
}

describe('runVisualEvaluation — per-canvas mode', () => {
  it('screenshots the same shell once per class at CANVAS_VIEWPORTS and returns one verdict per class', async () => {
    const deps = recordingDeps([90, 80, 60, 85, 95]);
    const result = await runVisualEvaluation(
      { compiledCode: COMPONENT, originalPrompt: 'a card' },
      { provider: 'claude', passThreshold: 70, canvases: CANVAS_CLASSES },
      deps,
    );
    expect(result).not.toBeNull();
    expect(result!.canvases).toHaveLength(5);
    expect(result!.canvases!.map((c) => c.canvas)).toEqual([...CANVAS_CLASSES]);
    for (const c of result!.canvases!) {
      expect(c.viewport).toEqual(CANVAS_VIEWPORTS[c.canvas]);
      expect(c.screenshotPng).toBeInstanceOf(Buffer);
      // The PNG the judge saw at this class was captured at this class's WINDOW — the class box, plus
      // the host panel's gap on md/lg/xl (ggui#1083 cut 3) — and reported at the class box.
      expect(c.screenshotPng.readUInt16BE(0)).toBe(judgeWindow(CANVAS_VIEWPORTS[c.canvas], canvasChrome(c.canvas)).width);
    }
    expect(deps.launched.map((o) => o.defaultViewport)).toEqual(CANVAS_CLASSES.map((c) => judgeWindow(CANVAS_VIEWPORTS[c], canvasChrome(c))));
    expect(deps.judged).toEqual(CANVAS_CLASSES.map((c) => judgeWindow(CANVAS_VIEWPORTS[c], canvasChrome(c)).width));
    // Scores + aggregate: mean(90,80,60,85,95) = 82; md failed the 70 threshold → passed=false.
    expect(result!.canvases!.map((c) => c.score)).toEqual([90, 80, 60, 85, 95]);
    expect(result!.canvases!.map((c) => c.passed)).toEqual([true, true, false, true, true]);
    expect(result!.finalScore).toBe(82);
    expect(result!.passed).toBe(false);
    expect(result!.dimensions.completeness).toBe(82);
    expect(result!.issues.map((i) => i.description)).toEqual(['[md] cramped']);
    expect(result!.critique).toContain('md: c60');
    expect(result!.inputTokens).toBe(50);
    expect(result!.outputTokens).toBe(25);
  });

  it('every canvas passing → passed=true; the summary is the PNG-free projection', async () => {
    const deps = recordingDeps([80, 90]);
    const result = await runVisualEvaluation(
      { compiledCode: COMPONENT, originalPrompt: 'a card' },
      { provider: 'claude', passThreshold: 70, canvases: ['xs-chat-card', 'xl'] },
      deps,
    );
    expect(result!.passed).toBe(true);
    expect(result!.finalScore).toBe(85);
    expect(summarizeVisualResult(result!)).toEqual({
      score: 85,
      passed: true,
      // ggui#1042: the summary names the design tree the judge painted with.
      design: { src: expect.stringMatching(/design\/src$/), srcSha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      // ggui#1195: the fit stamp — the inline card's box (the first canvas whose policy FAILS an
      // overflow, judged with a measurable height); judged at the class viewport here, so `declared: false`.
      fit: { canvas: 'xs-chat-card', ceiling: { width: 400, height: 640 }, declared: false, overflowPx: 0 },
      canvases: [
        { canvas: 'xs-chat-card', viewport: { width: 400, height: 640 }, score: 80, passed: true, contentHeight: 0, overflow: false, inkRatio: null, judge: { k: 1, rule: 'median', samples: [80], sigma: 0, notes: [expect.any(String)] } },
        // ggui#1100: a fullscreen canvas is composed with the runtime's fit and says so; the inline card carries no `fit`.
        { canvas: 'xl', viewport: { width: 1440, height: 900 }, score: 90, passed: true, contentHeight: 0, overflow: false, inkRatio: null, judge: { k: 1, rule: 'median', samples: [90], sigma: 0, notes: [expect.any(String)] }, fit: 'fill' },
      ],
    });
  });

  it('unset canvases → today\'s single screenshot at `viewport`, NO canvases field, no summary', async () => {
    const deps = recordingDeps([88]);
    const result = await runVisualEvaluation(
      { compiledCode: COMPONENT, originalPrompt: 'a card' },
      { provider: 'claude', passThreshold: 70, viewport: { width: 1280, height: 800 } },
      deps,
    );
    expect(deps.launched).toHaveLength(1);
    expect(deps.launched[0]?.defaultViewport).toEqual({ width: 1280, height: 800 });
    expect(result!.finalScore).toBe(88);
    expect('canvases' in result!).toBe(false);
    expect(summarizeVisualResult(result!)).toBeUndefined();
  });

  it('no browser at a canvas → null (the leg is skipped), same as the single-shot contract', async () => {
    const deps = recordingDeps([80]);
    deps.launch = async () => {
      throw new Error('no chromium');
    };
    const result = await runVisualEvaluation(
      { compiledCode: COMPONENT, originalPrompt: 'a card' },
      { provider: 'claude', passThreshold: 70, canvases: ['md'] },
      deps,
    );
    expect(result).toBeNull();
  });
});

describe('runVisualEval — the harness outcome', () => {
  it('no browser → { issues: [] } with no summary key, and the leg says it was SKIPPED with the reason (ggui#1221)', async () => {
    // The default launcher (puppeteer-core) with a bogus binary fails to launch → null → empty outcome.
    // ggui#1221: the absence used to be silent — `{ issues: [] }` reads exactly like a clean run.
    const saved = process.env.PUPPETEER_EXECUTABLE_PATH;
    process.env.PUPPETEER_EXECUTABLE_PATH = '/definitely/not/a/browser';
    try {
      const outcome = await runVisualEval(
        { compiledCode: COMPONENT, originalPrompt: 'a card' },
        { provider: 'claude', passThreshold: 70, canvases: ['md'] },
      );
      expect(outcome.issues).toEqual([]);
      expect('summary' in outcome).toBe(false);
      expect(outcome.coverage.status).toBe('skipped');
      expect(typeof outcome.coverage.reason).toBe('string');
      expect(outcome.coverage.reason!.length).toBeGreaterThan(0);
    } finally {
      if (saved === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH;
      else process.env.PUPPETEER_EXECUTABLE_PATH = saved;
    }
  });

  it('a judged run says the leg RAN, beside the summary (ggui#1221)', async () => {
    const deps = recordingDeps([80, 90]);
    const outcome = await runVisualEval(
      { compiledCode: COMPONENT, originalPrompt: 'a card' },
      { provider: 'claude', passThreshold: 70, canvases: ['xs-chat-card', 'xl'] },
      deps,
    );
    expect(outcome.coverage).toEqual({ status: 'ran' });
    expect(outcome.summary?.score).toBe(85);
  });
});
