/**
 * Pin: when the judge cannot judge, the reason rides in the RESULT, not only
 * on stderr. `runVisualEvaluationDetailed` returns `{ result: null,
 * unavailableReason, canvas? }`; `runVisualEvaluation` keeps its null.
 * Bought 2026-09-10: a production `judge_unavailable` receipt said only
 * "visual judge returned null" while stderr knew "Cannot find package
 * 'puppeteer-core'".
 */
import { describe, expect, it } from 'vitest';
import { runVisualEvaluation, runVisualEvaluationDetailed, type VisualEvalDeps } from './visual-evaluator.js';

const COMPONENT = 'export default function C(){ return null; }';

describe('visual judge — unavailable reason travels in the result', () => {
  it('a throwing launcher → result null + the launcher\'s message as the reason (per-canvas path names the canvas)', async () => {
    const deps: VisualEvalDeps = {
      launch: async () => {
        throw new Error("Cannot find package 'puppeteer-core'");
      },
      env: { PUPPETEER_EXECUTABLE_PATH: '/fake/chromium' },
      settleMs: 0,
    };
    const d = await runVisualEvaluationDetailed(
      { compiledCode: COMPONENT, originalPrompt: 'x' },
      { provider: 'claude', passThreshold: 60, canvases: ['xs-chat-card'] },
      deps,
    );
    expect(d.result).toBeNull();
    expect(d.unavailableReason).toContain("Cannot find package 'puppeteer-core'");
    expect(d.canvas).toBe('xs-chat-card');
    // the plain function keeps its null contract
    expect(await runVisualEvaluation({ compiledCode: COMPONENT, originalPrompt: 'x' }, { provider: 'claude', passThreshold: 60 }, deps)).toBeNull();
  });
  it('an unbundleable component → result null + "bundle failed: …" (never a throw from the detailed path)', async () => {
    const d = await runVisualEvaluationDetailed(
      { compiledCode: "import x from '@ggui-ai/does-not-exist'; export default x;", originalPrompt: 'x' },
      { provider: 'claude', passThreshold: 60 },
      { env: { PUPPETEER_EXECUTABLE_PATH: '/fake/chromium' }, launch: async () => { throw new Error('unreachable'); } },
    );
    expect(d.result).toBeNull();
    expect(d.unavailableReason?.startsWith('bundle failed:')).toBe(true);
    expect(d.unavailableReason).toContain('@ggui-ai/does-not-exist');
  });
});
