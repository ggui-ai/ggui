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
  version: 'v1',
  applies: { canvases: ['xs-chat-card', 'md'] },
  criteria: [
    { id: 'floor.fit', level: 'must', checker: 'instrument', text: 'fits', evidence: 'the bottom edge' },
    { id: 'floor.copy.app', level: 'must', checker: 'judge', text: "the app's copy", evidence: 'the greeting' },
    { id: 'finish.rhythm.radius', level: 'should', checker: 'judge', text: 'two radius families', evidence: 'the card and the pills' },
    { id: 'finish.chip.primacy', level: 'must', checker: 'judge', text: 'one filled chip', evidence: 'the chips', appliesWhen: { hasActions: true } },
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
      answer(80, [{ id: 'floor.copy.app', verdict: 'pass', evidence: 'the greeting names the app' }, { id: 'finish.rhythm.radius', verdict: 'fail', evidence: 'three families' }]),
      answer(80, [{ id: 'floor.copy.app', verdict: 'pass', evidence: 'greeting' }, { id: 'finish.rhythm.radius', verdict: 'fail', evidence: 'three' }]),
      answer(80, [{ id: 'floor.copy.app', verdict: 'n/a', evidence: 'cannot read' }, { id: 'finish.rhythm.radius', verdict: 'pass', evidence: 'two' }]),
    ];
    const d = deps(votes);
    const out = await runVisualEvaluationDetailed({ compiledCode: COMPONENT, originalPrompt: 'a card', criteria: { bank, context } }, { ...config, judgeK: 3 }, d);
    expect(d.asked).toHaveLength(3);
    for (const a of d.asked) {
      expect(a.prompt).toBe(VISUAL_EVAL_PROMPT);
      expect(a.criteriaBlock).toContain('from the FRAME only');
      expect(a.criteriaBlock).toContain('- floor.copy.app (must)');
      expect(a.criteriaBlock).toContain('- finish.rhythm.radius (should)');
      expect(a.criteriaBlock).not.toContain('finish.chip.primacy'); // hasActions=false → omitted by the selector
      expect(a.criteriaBlock).not.toContain('floor.fit'); // an instrument's, never asked of the judge
    }
    const c = out.result!.canvases![0]!;
    expect(c.score).toBe(80);
    expect(c.passed).toBe(true);
    expect(c.criteria).toBeDefined();
    expect(c.criteria!.criteriaSetId).toHaveLength(16);
    expect(c.criteria!.bankVersion).toBe('v1');
    expect(c.criteria!.context).toEqual({ ...context, canvas: 'xs-chat-card' });
    expect(c.criteria!.selection.map((s) => s.id)).toEqual(['floor.fit', 'floor.copy.app', 'finish.rhythm.radius']);
    const by = Object.fromEntries(c.criteria!.verdicts.map((v) => [v.id, v]));
    expect(by['floor.copy.app']).toMatchObject({ verdict: 'pass', evidence: 'the greeting names the app', level: 'must', checker: 'judge' });
    expect(by['finish.rhythm.radius']).toMatchObject({ verdict: 'fail', evidence: 'three families', level: 'should' });
    expect(by['floor.fit']).toMatchObject({ verdict: 'pass', checker: 'instrument' });
    const summary = summarizeVisualResult(out.result!)!;
    expect(summary.canvases[0]!.criteria).toEqual(c.criteria);
    expect(summary.criteria).toEqual({ mustFailed: [], shouldFailed: ['finish.rhythm.radius'], mustNa: [] });
  });

  it('a tie reads n/a "no majority" and a must at n/a is listed in the roll-up, never a pass; the score is unmoved', async () => {
    const votes = [
      answer(75, [{ id: 'floor.copy.app', verdict: 'pass', evidence: 'a' }]),
      answer(75, [{ id: 'floor.copy.app', verdict: 'fail', evidence: 'b' }]),
      answer(75, [{ id: 'floor.copy.app', verdict: 'n/a', evidence: 'c' }]),
    ];
    const d = deps(votes);
    const out = await runVisualEvaluationDetailed({ compiledCode: COMPONENT, originalPrompt: 'a card', criteria: { bank, context } }, { ...config, judgeK: 3 }, d);
    const by = Object.fromEntries(out.result!.canvases![0]!.criteria!.verdicts.map((v) => [v.id, v]));
    expect(by['floor.copy.app']).toMatchObject({ verdict: 'n/a', evidence: 'no majority' });
    expect(by['finish.rhythm.radius']).toMatchObject({ verdict: 'n/a', evidence: 'not answered' });
    expect(summarizeVisualResult(out.result!)!.criteria).toEqual({ mustFailed: [], shouldFailed: [], mustNa: ['floor.copy.app'] });
    expect(out.result!.canvases![0]!.score).toBe(75);
  });

  it('report-only invariant: the same answer with and without the criteria array yields the same score, passed and issues', async () => {
    const withBlock = await runVisualEvaluationDetailed(
      { compiledCode: COMPONENT, originalPrompt: 'a card', criteria: { bank, context } },
      config,
      deps([answer(64, [{ id: 'floor.copy.app', verdict: 'fail', evidence: 'lorem' }])]),
    );
    const without = await runVisualEvaluationDetailed({ compiledCode: COMPONENT, originalPrompt: 'a card', criteria: { bank, context } }, config, deps([answer(64)]));
    const a = withBlock.result!.canvases![0]!;
    const b = without.result!.canvases![0]!;
    expect([a.score, a.passed, a.judge.samples]).toEqual([b.score, b.passed, b.judge.samples]);
    expect(withBlock.result!.issues.map((i) => i.description)).toEqual(without.result!.issues.map((i) => i.description));
    // N−1: an answer without the array still parses; its judge criteria read n/a "not answered".
    expect(b.criteria!.verdicts.find((v) => v.id === 'floor.copy.app')).toMatchObject({ verdict: 'n/a', evidence: 'not answered' });
    expect(a.criteria!.verdicts.find((v) => v.id === 'floor.copy.app')).toMatchObject({ verdict: 'fail', evidence: 'lorem' });
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
