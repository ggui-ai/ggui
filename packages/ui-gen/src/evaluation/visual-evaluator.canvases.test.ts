/**
 * Per-canvas visual judging — ARM-NEUTRAL (the same judge either design
 * mode). With `config.canvases` set, `runVisualEvaluation` renders the
 * SAME html shell once per class at `CANVAS_VIEWPORTS[class]`, judges
 * each screenshot, returns one `{canvas, viewport, score, passed,
 * screenshotPng}` per class, and folds them into the single-shot fields
 * (score = mean, passed = every canvas passed). Unset = today's single
 * screenshot and NO `canvases` field. Browser + judge are injected.
 */
import { describe, expect, it } from 'vitest';
import type { LaunchOptions } from 'puppeteer-core';
import { CANVAS_CLASSES, CANVAS_VIEWPORTS } from '../design-mode.js';
import {
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
    return {
      newPage: async () => ({
        setContent: async () => {},
        waitForNetworkIdle: async () => {},
        waitForSelector: async () => null,
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
      // The PNG the judge saw at this class was captured at this class's width.
      expect(c.screenshotPng.readUInt16BE(0)).toBe(CANVAS_VIEWPORTS[c.canvas].width);
    }
    expect(deps.launched.map((o) => o.defaultViewport)).toEqual(CANVAS_CLASSES.map((c) => CANVAS_VIEWPORTS[c]));
    expect(deps.judged).toEqual(CANVAS_CLASSES.map((c) => CANVAS_VIEWPORTS[c].width));
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
      canvases: [
        { canvas: 'xs-chat-card', viewport: { width: 400, height: 640 }, score: 80, passed: true },
        { canvas: 'xl', viewport: { width: 1440, height: 900 }, score: 90, passed: true },
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
  it('no browser → { issues: [] } with no summary key (the pre-canvas shape)', async () => {
    // The default launcher (puppeteer-core) with a bogus binary fails to launch → null → empty outcome.
    const saved = process.env.PUPPETEER_EXECUTABLE_PATH;
    process.env.PUPPETEER_EXECUTABLE_PATH = '/definitely/not/a/browser';
    try {
      const outcome = await runVisualEval(
        { compiledCode: COMPONENT, originalPrompt: 'a card' },
        { provider: 'claude', passThreshold: 70, canvases: ['md'] },
      );
      expect(outcome).toEqual({ issues: [] });
    } finally {
      if (saved === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH;
      else process.env.PUPPETEER_EXECUTABLE_PATH = saved;
    }
  });
});
