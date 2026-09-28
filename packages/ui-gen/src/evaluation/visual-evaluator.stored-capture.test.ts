// ggui#1438 — a STORED capture is judged exactly as a fresh one (K scoring calls on the frame, the median, fit from the
// recorded content height, ink off the PNG, the criteria block from its own report-only call — ggui#1436), without
// rendering: the calibration's path.
import { describe, expect, it } from 'vitest';
import { parseCriteriaBank } from './criteria/bank.js';
import type { CriteriaContextInput } from './criteria/context.js';
import { VISUAL_EVAL_PROMPT, judgeStoredCapture } from './visual-evaluator.js';

const bank = parseCriteriaBank({
  version: 'v2',
  criteria: [
    { id: 'comp.fit', scope: {}, severity: 'must', evaluation: 'instrument', status: 'live', text: 'fits', evidence: 'the bottom edge' },
    { id: 'task.copy', scope: {}, severity: 'must', evaluation: 'judge', status: 'planned', text: "the app's copy", evidence: 'the greeting' },
  ],
});
const context: CriteriaContextInput = {
  hasActions: true, riskTier: 'low', axes: { render: 'static', state: 'none', writes: 'none', fetch: 'none', layout: 'single' },
  chroma: 'unknown', profilePresent: false, shell: 'chat',
};
const answer = (score: number, verdict: 'pass' | 'fail' | 'n/a') =>
  JSON.stringify({ completeness: score, layout: score, hierarchy: score, aesthetics: score, issues: [], critique: `c${score}`, criteria: [{ id: 'task.copy', verdict, evidence: 'the greeting names the app' }] });
type Asked = { prompt: string; criteriaBlock: string };
/** Scoring calls (no criteria block) answer from `texts` in call order; the criteria call answers `criteriaText`, else the last text. */
function judgeOf(texts: string[], criteriaText?: string): { asked: Asked[]; judge: (...a: unknown[]) => Promise<{ text: string; inputTokens: number; outputTokens: number }> } {
  const asked: Asked[] = [];
  let scored = 0;
  return {
    asked,
    judge: async (_c, _m, prompt, _png, _o, _p, criteriaBlock = '') => {
      asked.push({ prompt: prompt as string, criteriaBlock: criteriaBlock as string });
      if ((criteriaBlock as string).length > 0) return { text: criteriaText ?? texts[texts.length - 1]!, inputTokens: 10, outputTokens: 5 };
      const text = texts[Math.min(scored, texts.length - 1)]!;
      scored += 1;
      return { text, inputTokens: 10, outputTokens: 5 };
    },
  };
}
const NOT_A_PNG = Buffer.from('not a png');
const config = { provider: 'claude' as const, passThreshold: 70, judgeK: 3 };

describe('judgeStoredCapture (ggui#1438)', () => {
  it('K scoring calls on the stored frame and ONE criteria call, the median score, the block from the criteria call, ink read off the PNG (unreadable → null, never blank)', async () => {
    const j = judgeOf([answer(80, 'fail'), answer(90, 'fail'), answer(70, 'fail')], answer(10, 'pass'));
    const out = await judgeStoredCapture(
      { canvas: 'xs-chat-card', png: NOT_A_PNG, viewport: { width: 400, height: 640 }, contentHeight: 600, originalPrompt: 'a card', criteria: { bank, context } },
      config,
      { judge: j.judge as never },
    );
    expect(j.asked).toHaveLength(4);
    for (const a of j.asked) expect(a.prompt).toBe(VISUAL_EVAL_PROMPT);
    expect(j.asked.filter((a) => a.criteriaBlock === '')).toHaveLength(3);
    const criteriaAsked = j.asked.filter((a) => a.criteriaBlock !== '');
    expect(criteriaAsked).toHaveLength(1);
    expect(criteriaAsked[0]!.criteriaBlock).toContain('- task.copy (must)');
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    const v = out.verdict;
    expect(v.score).toBe(80);
    expect(v.passed).toBe(true);
    expect(v.judge).toEqual({ k: 3, rule: 'median', samples: [80, 90, 70], sigma: 8.2, notes: ['c80', 'c90', 'c70'] });
    expect(v.inkRatio).toBeNull();
    expect(v.issues.map((i) => i.dimension)).toEqual([]);
    expect(v.overflow).toBe(false);
    const by = Object.fromEntries(v.criteria!.verdicts.map((x) => [x.id, x]));
    expect(by['task.copy']).toMatchObject({ verdict: 'pass', evidence: 'the greeting names the app', severity: 'must', method: 'judge' });
    expect(by['comp.fit']).toMatchObject({ verdict: 'pass', evidence: 'content 600px against a 640px box' });
    expect(v.criteria!.context).toEqual({ ...context, canvas: 'xs-chat-card' });
    expect(v.inputTokens).toBe(40); // three scoring calls + the criteria call
  });
  it('the recorded content height drives the fit verdict as at capture: overflow on the inline card fails the canvas and the comp.fit row', async () => {
    const j = judgeOf([answer(85, 'pass')]);
    const out = await judgeStoredCapture(
      { canvas: 'xs-chat-card', png: NOT_A_PNG, viewport: { width: 400, height: 640 }, contentHeight: 900, originalPrompt: 'a card', criteria: { bank, context } },
      { ...config, judgeK: 1 },
      { judge: j.judge as never },
    );
    if (out.kind !== 'ok') throw new Error(out.reason);
    expect(out.verdict.passed).toBe(false);
    expect(out.verdict.overflow).toBe(true);
    expect(out.verdict.issues.map((i) => i.dimension)).toEqual(['canvas-overflow']);
    expect(out.verdict.criteria!.verdicts.find((x) => x.id === 'comp.fit')).toMatchObject({ verdict: 'fail', evidence: 'content 900px against a 640px box' });
  });
  it('no bank → no criteria key and an empty block to the judge; every answer unparsable → unavailable with the reason', async () => {
    const j = judgeOf([answer(75, 'pass')]);
    const out = await judgeStoredCapture({ canvas: 'md', png: NOT_A_PNG, viewport: { width: 768, height: 1024 }, contentHeight: null, originalPrompt: 'a card' }, { ...config, judgeK: 1 }, { judge: j.judge as never });
    expect(j.asked[0]!.criteriaBlock).toBe('');
    if (out.kind !== 'ok') throw new Error(out.reason);
    expect('criteria' in out.verdict).toBe(false);
    expect(out.verdict.contentHeight).toBeNull();
    const bad = judgeOf(['not json']);
    const u = await judgeStoredCapture({ canvas: 'md', png: NOT_A_PNG, viewport: { width: 768, height: 1024 }, contentHeight: null, originalPrompt: 'a card' }, { ...config, judgeK: 1 }, { judge: bad.judge as never });
    expect(u.kind).toBe('unavailable');
  });
});
