/**
 * Pin (#1017): a malformed judge answer is retried ONCE with the same
 * prompt; a good second answer yields a result and one logged
 * `visual_judge_retry`; two bad answers yield `unavailableReason` carrying
 * the FIRST reason verbatim — never a throw that fails the whole item.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runVisualEvaluation, runVisualEvaluationDetailed, type ScreenshotBrowser, type VisualEvalDeps } from './visual-evaluator.js';

const COMPONENT = 'export default function C(){ return null; }';
const GOOD = JSON.stringify({ completeness: 90, layout: 90, hierarchy: 90, aesthetics: 90, issues: [] });
const BAD = '{"completeness": 90, "layout": 90, "issues": [ {"dimension": "layout" ';

function deps(answers: readonly string[]): VisualEvalDeps & { calls: number } {
  const state = { calls: 0 };
  const launch = async (): Promise<ScreenshotBrowser> => ({
    newPage: async () => ({
      setContent: async () => {},
      waitForNetworkIdle: async () => {},
      waitForSelector: async () => null,
      evaluate: async () => 0,
      screenshot: async () => new Uint8Array([1, 2]),
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
      const text = answers[Math.min(state.calls, answers.length - 1)] ?? GOOD;
      state.calls += 1;
      return { text, inputTokens: 1, outputTokens: 1 };
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('visual judge — one retry on a malformed answer (#1017)', () => {
  it('garbage then JSON → a result, exactly two judge calls, one logged visual_judge_retry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = deps([BAD, GOOD]);
    const out = await runVisualEvaluationDetailed(
      { compiledCode: COMPONENT, originalPrompt: 'x' },
      { provider: 'claude', passThreshold: 60, canvases: ['md'] },
      d,
    );
    expect(out.result?.finalScore).toBe(90);
    expect(d.calls).toBe(2);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('visual_judge_retry')).length).toBe(1);
  });
  it('garbage twice → result null, unavailableReason = the FIRST reason verbatim, canvas named; plain function returns null', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = deps([BAD, BAD]);
    const out = await runVisualEvaluationDetailed(
      { compiledCode: COMPONENT, originalPrompt: 'x' },
      { provider: 'claude', passThreshold: 60, canvases: ['xs-chat-card'] },
      d,
    );
    expect(out.result).toBeNull();
    expect(out.unavailableReason?.startsWith('judge answer unparsable:')).toBe(true);
    expect(out.canvas).toBe('xs-chat-card');
    expect(d.calls).toBe(2);
    const plain = await runVisualEvaluation({ compiledCode: COMPONENT, originalPrompt: 'x' }, { provider: 'claude', passThreshold: 60 }, deps([BAD, BAD]));
    expect(plain).toBeNull();
  });
  it('single-shot path retries the same way', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = deps([BAD, GOOD]);
    const out = await runVisualEvaluationDetailed({ compiledCode: COMPONENT, originalPrompt: 'x' }, { provider: 'claude', passThreshold: 60 }, d);
    expect(out.result?.finalScore).toBe(90);
    expect(d.calls).toBe(2);
  });
});
