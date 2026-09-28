// ggui#1436 — the judge emits a typed criteria block per canvas, report-only beside the score: the selection is decided
// before the judge runs and is asked in a USER turn (the system prompt and its digest pin never move — the CTO's A3); the
// block carries the selector's inputs (A1); a must at n/a is listed in the roll-up (A2); no bank → no key at all (today,
// byte-for-byte); an old answer without the array still parses (N−1).
//
// REPORT-ONLY means the block is never asked inside a call whose score binds. It first shipped inside the scoring call,
// and this file's "report-only invariant" checked only that the ANSWER's criteria array did not enter the score
// arithmetic — which a scripted judge cannot contradict, while a real one scores differently when its turn carries the
// block — the first release that carried it into a served judge lowered first-attempt scores. The invariant pinned here is the
// one a scripted judge CAN check: the scoring calls are asked exactly what they are asked with no bank at all, and the
// block rides one call of its own whose score is discarded.
import { describe, expect, it } from 'vitest';
import type { LaunchOptions } from 'puppeteer-core';
import { parseCriteriaBank } from './criteria/bank.js';
import type { CriteriaContextInput } from './criteria/context.js';
import { CARD_OVERFLOW_X_EXPRESSION,
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

type JudgeArgs = { prompt: string; original: string; profileBlock: string; criteriaBlock: string };
/**
 * A fake browser + a judge that records what it was asked. A scoring call (no criteria block) answers from
 * `scoring` in call order; the criteria call answers `criteriaText`.
 */
function deps(scoring: string[], criteriaText?: string): VisualEvalDeps & { asked: JudgeArgs[] } {
  const asked: JudgeArgs[] = [];
  let scored = 0;
  const launch = async (_o: LaunchOptions): Promise<ScreenshotBrowser> => ({
    newPage: async () => ({
      setContent: async () => {},
      waitForNetworkIdle: async () => {},
      waitForSelector: async () => null,
      // ggui#1475 — the inline card's horizontal overflow is its own measurement: this card fits its width.
      evaluate: async (expression: string) => (expression === CARD_OVERFLOW_X_EXPRESSION ? 0 : 500),
      screenshot: async () => new Uint8Array([1, 2, 3]),
    }),
    close: async () => {},
  });
  return {
    asked,
    launch,
    env: { PUPPETEER_EXECUTABLE_PATH: '/fake/chromium' },
    settleMs: 0,
    judge: async (_config, _model, prompt, _png, original, profileBlock = '', criteriaBlock = '') => {
      asked.push({ prompt, original, profileBlock, criteriaBlock });
      if (criteriaBlock.length > 0) return { text: criteriaText ?? 'not json', inputTokens: 100, outputTokens: 50 };
      const text = scoring[Math.min(scored, scoring.length - 1)]!;
      scored += 1;
      return { text, inputTokens: 10, outputTokens: 5 };
    },
  };
}
const answer = (score: number, criteria?: Array<{ id: string; verdict: string; evidence: string }>): string =>
  JSON.stringify({ completeness: score, layout: score, hierarchy: score, aesthetics: score, issues: [{ dimension: 'layout', severity: 'minor', description: 'd', fix: 'f' }], critique: 'c', ...(criteria !== undefined ? { criteria } : {}) });
const config = { provider: 'claude' as const, passThreshold: 70, canvases: ['xs-chat-card' as const] };
const scoringCalls = (asked: readonly JudgeArgs[]): JudgeArgs[] => asked.filter((a) => a.criteriaBlock === '');
const criteriaCalls = (asked: readonly JudgeArgs[]): JudgeArgs[] => asked.filter((a) => a.criteriaBlock !== '');

describe('the judge emits a typed criteria block per canvas (ggui#1436)', () => {
  it('no bank → no criteria key anywhere, no criteria call, and an empty criteria block to the judge — today, byte-for-byte', async () => {
    const d = deps([answer(80)]);
    const out = await runVisualEvaluationDetailed({ compiledCode: COMPONENT, originalPrompt: 'a card' }, config, d);
    const c = out.result!.canvases![0]!;
    expect('criteria' in c).toBe(false);
    expect(d.asked).toHaveLength(1);
    expect(d.asked[0]!.criteriaBlock).toBe('');
    expect('criteria' in summarizeVisualResult(out.result!)!).toBe(false);
  });

  it('REPORT-ONLY: with a bank the K scoring calls are asked exactly what they are asked with no bank, and the block rides ONE call of its own', async () => {
    const scoring = [answer(80), answer(78), answer(82)];
    const bare = deps(scoring);
    await runVisualEvaluationDetailed({ compiledCode: COMPONENT, originalPrompt: 'a card' }, { ...config, judgeK: 3 }, bare);
    const d = deps(scoring, answer(10, [{ id: 'task.copy', verdict: 'pass', evidence: 'greeting' }]));
    const out = await runVisualEvaluationDetailed({ compiledCode: COMPONENT, originalPrompt: 'a card', criteria: { bank, context } }, { ...config, judgeK: 3 }, d);
    expect(d.asked).toHaveLength(4);
    expect(scoringCalls(d.asked)).toEqual(bare.asked);
    expect(criteriaCalls(d.asked)).toHaveLength(1);
    const c = out.result!.canvases![0]!;
    // the criteria call's own score (10) never enters the samples, the median or the verdict
    expect(c.judge.samples).toEqual([80, 78, 82]);
    expect(c.score).toBe(80);
    expect(c.passed).toBe(true);
  });

  it('with a bank: the selection is asked in the criteria call\'s USER turn (the system prompt untouched); the block records context + selection + the call\'s verdicts', async () => {
    const d = deps([answer(80)], answer(80, [{ id: 'task.copy', verdict: 'pass', evidence: 'the greeting names the app' }, { id: 'space.shape', verdict: 'fail', evidence: 'three families' }]));
    const out = await runVisualEvaluationDetailed({ compiledCode: COMPONENT, originalPrompt: 'a card', criteria: { bank, context } }, config, d);
    for (const a of d.asked) expect(a.prompt).toBe(VISUAL_EVAL_PROMPT);
    const [asked] = criteriaCalls(d.asked);
    expect(asked!.criteriaBlock).toContain('from the FRAME only');
    expect(asked!.criteriaBlock).toContain('- task.copy (must)');
    expect(asked!.criteriaBlock).toContain('- space.shape (should)');
    expect(asked!.criteriaBlock).not.toContain('state.composer'); // kind unset → omitted by the selector
    expect(asked!.criteriaBlock).not.toContain('comp.fit'); // an instrument's, never asked of the judge
    const c = out.result!.canvases![0]!;
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

  it('a must answered n/a is listed in the roll-up, never a pass; an unanswered id reads n/a "not answered"; the score is unmoved', async () => {
    const d = deps([answer(75)], answer(75, [{ id: 'task.copy', verdict: 'n/a', evidence: 'cannot read' }]));
    const out = await runVisualEvaluationDetailed({ compiledCode: COMPONENT, originalPrompt: 'a card', criteria: { bank, context } }, config, d);
    const by = Object.fromEntries(out.result!.canvases![0]!.criteria!.verdicts.map((v) => [v.id, v]));
    expect(by['task.copy']).toMatchObject({ verdict: 'n/a', evidence: 'cannot read' });
    expect(by['space.shape']).toMatchObject({ verdict: 'n/a', evidence: 'not answered' });
    expect(summarizeVisualResult(out.result!)!.criteria).toEqual({ mustFailed: [], shouldFailed: [], mustNa: ['task.copy'] });
    expect(out.result!.canvases![0]!.score).toBe(75);
  });

  it('a criteria call that never parses leaves the canvas judged: the score stands, every judge row reads n/a "not answered"', async () => {
    const d = deps([answer(72)], 'not json');
    const out = await runVisualEvaluationDetailed({ compiledCode: COMPONENT, originalPrompt: 'a card', criteria: { bank, context } }, config, d);
    const c = out.result!.canvases![0]!;
    expect(c.score).toBe(72);
    expect(c.criteria!.verdicts.find((v) => v.id === 'task.copy')).toMatchObject({ verdict: 'n/a', evidence: 'not answered' });
  });

  it('N−1: a criteria answer without the array still parses; its judge rows read n/a "not answered"', async () => {
    const out = await runVisualEvaluationDetailed({ compiledCode: COMPONENT, originalPrompt: 'a card', criteria: { bank, context } }, config, deps([answer(64)], answer(64)));
    expect(out.result!.canvases![0]!.criteria!.verdicts.find((v) => v.id === 'task.copy')).toMatchObject({ verdict: 'n/a', evidence: 'not answered' });
  });

  it('the criteria call\'s spend is reported APART: the scoring tokens are the K scoring calls\' alone, so a cost read off them never includes the block', async () => {
    const out = await runVisualEvaluationDetailed(
      { compiledCode: COMPONENT, originalPrompt: 'a card', criteria: { bank, context } },
      { ...config, judgeK: 3 },
      deps([answer(80)], answer(80, [{ id: 'task.copy', verdict: 'pass', evidence: 'g' }])),
    );
    const c = out.result!.canvases![0]!;
    expect(out.result!.inputTokens).toBe(3 * 10);
    expect(out.result!.outputTokens).toBe(3 * 5);
    expect(c.criteriaTokens).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(out.result!.criteriaTokens).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(c.score).toBe(80);
  });

  it('no bank → no criteria spend reported anywhere', async () => {
    const out = await runVisualEvaluationDetailed({ compiledCode: COMPONENT, originalPrompt: 'a card' }, config, deps([answer(80)]));
    expect('criteriaTokens' in out.result!).toBe(false);
    expect('criteriaTokens' in out.result!.canvases![0]!).toBe(false);
  });

  it('a canvas outside the bank\'s `applies` gets a block with an empty selection, no verdicts, and no criteria call', async () => {
    const d = deps([answer(80)]);
    const out = await runVisualEvaluationDetailed(
      { compiledCode: COMPONENT, originalPrompt: 'a card', criteria: { bank, context } },
      { ...config, canvases: ['lg' as const] },
      d,
    );
    expect(d.asked).toHaveLength(1);
    expect(d.asked[0]!.criteriaBlock).toBe('');
    const c = out.result!.canvases![0]!;
    expect(c.criteria!.selection).toEqual([]);
    expect(c.criteria!.verdicts).toEqual([]);
    expect(summarizeVisualResult(out.result!)!.criteria).toEqual({ mustFailed: [], shouldFailed: [], mustNa: [] });
  });
});
