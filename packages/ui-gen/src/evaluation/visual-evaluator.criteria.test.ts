// ggui#1436 — the judge emits a typed criteria block per canvas, report-only beside the score: the selection is decided
// before the judge runs and rides in the USER turn (the system prompt and its digest pin never move — the CTO's A3); the
// block carries the selector's inputs (A1); K-majority with tie → n/a and a must-at-n/a roll-up (A2); the score path is
// byte-identical with the block stripped; no bank → no key at all (today, byte-for-byte); an old answer without the
// array still parses (N−1).
import { describe, expect, it } from 'vitest';
import type { LaunchOptions } from 'puppeteer-core';
import { parseCriteriaBank } from './criteria/bank.js';
import type { CriteriaContextInput } from './criteria/context.js';
import {
  VISUAL_EVAL_PROMPT,
  runVisualEvaluationDetailed,
  summarizeVisualResult,
  type ScreenshotBrowser,
  type VisualEvalDeps,
} from './visual-evaluator.js';

const COMPONENT = 'export default function C(){ return null; }';
const bank = parseCriteriaBank({
  version: 'v2',
  applies: { kind: ['*'], canvases: ['xs-chat-card', 'md'] },
  criteria: [
    { id: 'comp.fit', scope: {}, severity: 'must', evaluation: 'instrument', status: 'live', text: 'fits', evidence: 'the bottom edge' },
    { id: 'task.copy', scope: {}, severity: 'must', evaluation: 'judge', status: 'planned', text: "the app's copy", evidence: 'the greeting' },
    { id: 'space.shape', scope: {}, severity: 'should', evaluation: 'judge', status: 'planned', text: 'two radius families', evidence: 'the card and the pills' },
    { id: 'state.composer', scope: { kind: 'chat' }, severity: 'must', evaluation: 'judge', status: 'planned', text: 'a composer', evidence: 'the composer' },
  ],
});
const context: CriteriaContextInput = {
  hasActions: false,
  riskTier: 'low',
  axes: { render: 'static', state: 'none', writes: 'none', fetch: 'none', layout: 'single' },
  chroma: 'unknown',
  profilePresent: false,
  shell: 'chat',
};

type JudgeArgs = { prompt: string; profileBlock: string; criteriaBlock: string };
/** A fake browser + a judge that answers from a queue of texts and records what it was asked. */
function deps(texts: string[]): VisualEvalDeps & { asked: JudgeArgs[] } {
  const asked: JudgeArgs[] = [];
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
    asked,
    launch,
    env: { PUPPETEER_EXECUTABLE_PATH: '/fake/chromium' },
    settleMs: 0,
    judge: async (_config, _model, prompt, _png, _original, profileBlock = '', criteriaBlock = '') => {
      asked.push({ prompt, profileBlock, criteriaBlock });
      const text = texts[Math.min(asked.length - 1, texts.length - 1)]!;
      return { text, inputTokens: 10, outputTokens: 5 };
    },
  };
}
const answer = (score: number, criteria?: Array<{ id: string; verdict: string; evidence: string }>): string =>
  JSON.stringify({ completeness: score, layout: score, hierarchy: score, aesthetics: score, issues: [{ dimension: 'layout', severity: 'minor', description: 'd', fix: 'f' }], critique: 'c', ...(criteria !== undefined ? { criteria } : {}) });
const config = { provider: 'claude' as const, passThreshold: 70, canvases: ['xs-chat-card' as const] };

describe('the judge emits a typed criteria block per canvas (ggui#1436)', () => {
  it('no bank → no criteria key anywhere and an empty criteria block to the judge — today, byte-for-byte', async () => {
    const d = deps([answer(80)]);
    const out = await runVisualEvaluationDetailed({ compiledCode: COMPONENT, originalPrompt: 'a card' }, config, d);
    const c = out.result!.canvases![0]!;
    expect('criteria' in c).toBe(false);
    expect(d.asked[0]!.criteriaBlock).toBe('');
    expect('criteria' in summarizeVisualResult(out.result!)!).toBe(false);
  });

  it('with a bank: the selection is asked in the USER turn (the system prompt untouched), the block records context + selection + K-majority verdicts, the score path is unchanged', async () => {
    const votes = [
      answer(80, [{ id: 'task.copy', verdict: 'pass', evidence: 'the greeting names the app' }, { id: 'space.shape', verdict: 'fail', evidence: 'three families' }]),
      answer(80, [{ id: 'task.copy', verdict: 'pass', evidence: 'greeting' }, { id: 'space.shape', verdict: 'fail', evidence: 'three' }]),
      answer(80, [{ id: 'task.copy', verdict: 'n/a', evidence: 'cannot read' }, { id: 'space.shape', verdict: 'pass', evidence: 'two' }]),
    ];
    const d = deps(votes);
    const out = await runVisualEvaluationDetailed({ compiledCode: COMPONENT, originalPrompt: 'a card', criteria: { bank, context } }, { ...config, judgeK: 3 }, d);
    expect(d.asked).toHaveLength(3);
    for (const a of d.asked) {
      expect(a.prompt).toBe(VISUAL_EVAL_PROMPT);
      expect(a.criteriaBlock).toContain('from the FRAME only');
      expect(a.criteriaBlock).toContain('- task.copy (must)');
      expect(a.criteriaBlock).toContain('- space.shape (should)');
      expect(a.criteriaBlock).not.toContain('state.composer'); // kind unset → omitted by the selector
      expect(a.criteriaBlock).not.toContain('comp.fit'); // an instrument's, never asked of the judge
    }
    const c = out.result!.canvases![0]!;
    expect(c.score).toBe(80);
    expect(c.passed).toBe(true);
    expect(c.criteria).toBeDefined();
    expect(c.criteria!.criteriaSetId).toHaveLength(16);
    expect(c.criteria!.bankVersion).toBe('v2');
    expect(c.criteria!.context).toEqual({ ...context, canvas: 'xs-chat-card' });
    expect(c.criteria!.selection.map((s) => s.id)).toEqual(['comp.fit', 'task.copy', 'space.shape']);
    const by = Object.fromEntries(c.criteria!.verdicts.map((v) => [v.id, v]));
    expect(by['task.copy']).toMatchObject({ verdict: 'pass', evidence: 'the greeting names the app', severity: 'must', method: 'judge', status: 'planned' });
    expect(by['space.shape']).toMatchObject({ verdict: 'fail', evidence: 'three families', severity: 'should' });
    expect(by['comp.fit']).toMatchObject({ verdict: 'pass', method: 'instrument', status: 'live' });
    const summary = summarizeVisualResult(out.result!)!;
    expect(summary.canvases[0]!.criteria).toEqual(c.criteria);
    expect(summary.criteria).toEqual({ mustFailed: [], shouldFailed: ['space.shape'], mustNa: [] });
  });

  it('a tie reads n/a "no majority" and a must at n/a is listed in the roll-up, never a pass; the score is unmoved', async () => {
    const votes = [
      answer(75, [{ id: 'task.copy', verdict: 'pass', evidence: 'a' }]),
      answer(75, [{ id: 'task.copy', verdict: 'fail', evidence: 'b' }]),
      answer(75, [{ id: 'task.copy', verdict: 'n/a', evidence: 'c' }]),
    ];
    const d = deps(votes);
    const out = await runVisualEvaluationDetailed({ compiledCode: COMPONENT, originalPrompt: 'a card', criteria: { bank, context } }, { ...config, judgeK: 3 }, d);
    const by = Object.fromEntries(out.result!.canvases![0]!.criteria!.verdicts.map((v) => [v.id, v]));
    expect(by['task.copy']).toMatchObject({ verdict: 'n/a', evidence: 'no majority' });
    expect(by['space.shape']).toMatchObject({ verdict: 'n/a', evidence: 'not answered' });
    expect(summarizeVisualResult(out.result!)!.criteria).toEqual({ mustFailed: [], shouldFailed: [], mustNa: ['task.copy'] });
    expect(out.result!.canvases![0]!.score).toBe(75);
  });

  it('report-only invariant: the same answer with and without the criteria array yields the same score, passed and issues', async () => {
    const withBlock = await runVisualEvaluationDetailed(
      { compiledCode: COMPONENT, originalPrompt: 'a card', criteria: { bank, context } },
      config,
      deps([answer(64, [{ id: 'task.copy', verdict: 'fail', evidence: 'lorem' }])]),
    );
    const without = await runVisualEvaluationDetailed({ compiledCode: COMPONENT, originalPrompt: 'a card', criteria: { bank, context } }, config, deps([answer(64)]));
    const a = withBlock.result!.canvases![0]!;
    const b = without.result!.canvases![0]!;
    expect([a.score, a.passed, a.judge.samples]).toEqual([b.score, b.passed, b.judge.samples]);
    expect(withBlock.result!.issues.map((i) => i.description)).toEqual(without.result!.issues.map((i) => i.description));
    // N−1: an answer without the array still parses; its judge criteria read n/a "not answered".
    expect(b.criteria!.verdicts.find((v) => v.id === 'task.copy')).toMatchObject({ verdict: 'n/a', evidence: 'not answered' });
    expect(a.criteria!.verdicts.find((v) => v.id === 'task.copy')).toMatchObject({ verdict: 'fail', evidence: 'lorem' });
  });

  it('a canvas outside the bank\'s `applies` gets a block with an empty selection, no verdicts, and nothing asked of the judge', async () => {
    const d = deps([answer(80)]);
    const out = await runVisualEvaluationDetailed(
      { compiledCode: COMPONENT, originalPrompt: 'a card', criteria: { bank, context } },
      { ...config, canvases: ['lg' as const] },
      d,
    );
    expect(d.asked[0]!.criteriaBlock).toBe('');
    const c = out.result!.canvases![0]!;
    expect(c.criteria!.selection).toEqual([]);
    expect(c.criteria!.verdicts).toEqual([]);
    expect(summarizeVisualResult(out.result!)!.criteria).toEqual({ mustFailed: [], shouldFailed: [], mustNa: [] });
  });
});
