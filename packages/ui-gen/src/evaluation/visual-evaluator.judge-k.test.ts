// Pin (ggui#1072): median-of-K judging on the SAME captured frame. k = 1 is
// byte-identical to the single judgement (one shape serves both); k > 1
// takes k vision calls per sampled canvas, `score` = the median, `passed` on
// the median + the fit exactly as before, `judge` carries every sample, σ and
// the per-sample critique; an unparsable sample is dropped, never invented.
import { describe, expect, it } from 'vitest';
import type { LaunchOptions } from 'puppeteer-core';
import { runVisualEvaluationDetailed, summarizeVisualResult, type ScreenshotBrowser, type VisualEvalDeps } from './visual-evaluator.js';

const COMPONENT = 'export default function C(){ return null; }';

/** A judge that answers each call from a queue of scores (in call order; the parser's retry consumes a slot too); a `null` entry answers garbage. */
function deps(answers: Array<number | null>): VisualEvalDeps & { calls: number } {
  const state = { calls: 0 };
  const launch = async (_o: LaunchOptions): Promise<ScreenshotBrowser> => ({
    newPage: async () => ({
      setContent: async () => {},
      waitForNetworkIdle: async () => {},
      waitForSelector: async () => null,
      evaluate: async () => 500,
      screenshot: async () => new Uint8Array([1, 2, 3]),
    }),
    close: async () => {},
  });
  return {
    get calls() {
      return state.calls;
    },
    launch,
    env: { PUPPETEER_EXECUTABLE_PATH: '/fake/chromium' },
    settleMs: 0,
    judge: async () => {
      // Beyond the queue the judge answers garbage — a retry past the script is never a phantom sample.
      const score = state.calls < answers.length ? answers[state.calls]! : null;
      state.calls += 1;
      return {
        text:
          score === null
            ? 'not json at all'
            : JSON.stringify({ completeness: score, layout: score, hierarchy: score, aesthetics: score, issues: [], critique: `c${score}` }),
        inputTokens: 10,
        outputTokens: 5,
      };
    },
  };
}
const ctx = { compiledCode: COMPONENT, originalPrompt: 'a card', cssTokens: '' };
const config = { provider: 'claude' as const, passThreshold: 70, canvases: ['xs-chat-card' as const] };

describe('median-of-K judge (ggui#1072)', () => {
  it('k absent ⇒ one call per canvas, judge: { k: 1, samples: [score], sigma: 0, notes: [critique] }', async () => {
    const d = deps([80]);
    const out = await runVisualEvaluationDetailed(ctx, config, d);
    expect(d.calls).toBe(1);
    const c = out.result!.canvases![0]!;
    expect(c.score).toBe(80);
    expect(c.judge).toEqual({ k: 1, rule: 'median', samples: [80], sigma: 0, notes: ['c80'] });
    expect(summarizeVisualResult(out.result!)!.canvases[0]!.judge).toEqual(c.judge);
  });

  it('k = 3 ⇒ three calls on the same frame; score = the median; passed on the median; σ and the three critiques recorded', async () => {
    const d = deps([82, 66, 78]);
    const out = await runVisualEvaluationDetailed(ctx, { ...config, judgeK: 3 }, d);
    expect(d.calls).toBe(3);
    const c = out.result!.canvases![0]!;
    expect(c.score).toBe(78);
    expect(c.passed).toBe(true);
    expect(c.judge).toEqual({ k: 3, rule: 'median', samples: [82, 66, 78], sigma: 6.8, notes: ['c82', 'c66', 'c78'] });
    expect(out.result!.inputTokens).toBe(30);
  });

  it('the median decides the verdict: samples [82, 60, 61] with a bar of 70 ⇒ 61, FAIL, even though one call passed', async () => {
    const out = await runVisualEvaluationDetailed(ctx, { ...config, judgeK: 3 }, deps([82, 60, 61]));
    const c = out.result!.canvases![0]!;
    expect(c.score).toBe(61);
    expect(c.passed).toBe(false);
  });

  it('a canvas outside judgeKCanvases is judged once; a sampled one k times', async () => {
    const d = deps([75, 75, 75, 75]);
    const out = await runVisualEvaluationDetailed(ctx, { ...config, canvases: ['xs-chat-card', 'md'], judgeK: 3, judgeKCanvases: ['md'] }, d);
    expect(d.calls).toBe(4);
    const [xs, md] = out.result!.canvases!;
    expect(xs!.judge.k).toBe(1);
    expect(md!.judge.k).toBe(3);
  });

  it('an unparsable sample is dropped, k stays the requested k, the row shows the short samples', async () => {
    // calls: 80, garbage, 70 — then the garbage sample's one retry draws garbage again and is dropped.
    const out = await runVisualEvaluationDetailed(ctx, { ...config, judgeK: 3 }, deps([80, null, 70, null]));
    const c = out.result!.canvases![0]!;
    expect(c.judge.k).toBe(3);
    expect(c.judge.samples).toEqual([80, 70]);
    expect(c.score).toBe(70);
  });
});
