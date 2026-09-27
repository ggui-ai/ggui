// ggui#1436 — from K answers and the capture's measurements to one block: K-majority per id, a tie or an unanswered id
// reads n/a (the CTO's A2), instruments answer from measurements or read "instrument not run", humans read n/a.
import { describe, expect, it } from 'vitest';
import type { CriteriaContext } from '../types-public.js';
import { parseCriteriaBank } from './bank.js';
import { buildCriteriaJudgeBlock, resolveCriteriaBlock } from './resolve.js';
import { selectCriteria } from './select.js';

const bank = parseCriteriaBank({
  version: 'v1',
  criteria: [
    { id: 'floor.fit', severity: 'must', checker: 'instrument', text: 'fits', evidence: 'the bottom edge' },
    { id: 'finish.canvas.inhabited', severity: 'should', checker: 'instrument', text: 'inhabited', evidence: 'the void' },
    { id: 'finish.colour.contrast', severity: 'must', checker: 'instrument', text: 'AA', evidence: 'the text on the field' },
    { id: 'finish.rhythm.radius', severity: 'should', checker: 'judge', text: 'two radius families', evidence: 'the card and the pills' },
    { id: 'floor.copy.app', severity: 'must', checker: 'judge', text: 'the app\'s copy', evidence: 'the greeting' },
    { id: 'floor.void.placed', severity: 'should', checker: 'human', text: 'placed void', evidence: 'the empty region' },
  ],
});
const ctx: CriteriaContext = {
  canvas: 'md', hasActions: false, riskTier: 'low',
  axes: { render: 'static', state: 'none', writes: 'none', fetch: 'none', layout: 'single' },
  chroma: 'unknown', profilePresent: false, shell: 'fullscreen',
};
const selected = selectCriteria(bank, ctx);
const m = { overflow: false, contentHeight: 500, viewportHeight: 1024, inkRatio: 0.412 };

describe('resolveCriteriaBlock (ggui#1436)', () => {
  it('K-majority per judge criterion; the evidence is a majority vote\'s; a tie and an unanswered id read n/a', () => {
    const answers = [
      [{ id: 'finish.rhythm.radius', verdict: 'pass' as const, evidence: 'card + pills only' }, { id: 'floor.copy.app', verdict: 'pass' as const, evidence: 'greeting names the app' }],
      [{ id: 'finish.rhythm.radius', verdict: 'pass' as const, evidence: 'two families' }, { id: 'floor.copy.app', verdict: 'fail' as const, evidence: 'lorem' }],
      [{ id: 'finish.rhythm.radius', verdict: 'fail' as const, evidence: 'three' }, { id: 'floor.copy.app', verdict: 'n/a' as const, evidence: 'cannot read' }],
    ];
    const block = resolveCriteriaBlock({ bank, context: ctx, selected, answers, measurements: m });
    const by = Object.fromEntries(block.verdicts.map((v) => [v.id, v]));
    expect(by['finish.rhythm.radius']).toMatchObject({ verdict: 'pass', evidence: 'card + pills only', severity: 'should', checker: 'judge', source: 'static' });
    expect(by['floor.copy.app']).toMatchObject({ verdict: 'n/a', evidence: 'no majority', severity: 'must' });
    expect(block.criteriaSetId).toBe(selected.criteriaSetId);
    expect(block.context).toEqual(ctx);
    expect(block.bankVersion).toBe('v1');
    expect(block.selectorVersion).toBe('selector@1');
    const unanswered = resolveCriteriaBlock({ bank, context: ctx, selected, answers: [[], []], measurements: m });
    expect(unanswered.verdicts.find((v) => v.id === 'floor.copy.app')).toMatchObject({ verdict: 'n/a', evidence: 'not answered' });
  });
  it('instruments answer from the capture: fit pass/fail with the numbers, fill reported at n/a, others "instrument not run"; humans n/a', () => {
    const block = resolveCriteriaBlock({ bank, context: ctx, selected, answers: [[]], measurements: m });
    const by = Object.fromEntries(block.verdicts.map((v) => [v.id, v]));
    expect(by['floor.fit']).toMatchObject({ verdict: 'pass', evidence: 'content 500px against a 1024px box', checker: 'instrument' });
    expect(by['finish.canvas.inhabited']).toMatchObject({ verdict: 'n/a', evidence: 'fill 0.412 reported; no floor ruled' });
    expect(by['finish.colour.contrast']).toMatchObject({ verdict: 'n/a', evidence: 'instrument not run' });
    expect(by['floor.void.placed']).toMatchObject({ verdict: 'n/a', evidence: "reader's column", checker: 'human' });
    const overflowing = resolveCriteriaBlock({ bank, context: ctx, selected, answers: [[]], measurements: { ...m, overflow: true, contentHeight: 1300 } });
    expect(overflowing.verdicts.find((v) => v.id === 'floor.fit')).toMatchObject({ verdict: 'fail', evidence: 'content 1300px against a 1024px box' });
    const unmeasured = resolveCriteriaBlock({ bank, context: ctx, selected, answers: [[]], measurements: { ...m, contentHeight: null, inkRatio: null } });
    expect(unmeasured.verdicts.find((v) => v.id === 'floor.fit')).toMatchObject({ verdict: 'n/a', evidence: 'content height unmeasurable' });
    expect(unmeasured.verdicts.find((v) => v.id === 'finish.canvas.inhabited')).toMatchObject({ verdict: 'n/a', evidence: 'capture unreadable' });
  });
  it('the judge block lists only judge criteria with their evidence rule and the frame-only instruction; empty when none is selected', () => {
    const block = buildCriteriaJudgeBlock(bank, selected);
    expect(block).toContain('from the FRAME only');
    expect(block).toContain('- finish.rhythm.radius (should): two radius families Evidence must name: the card and the pills');
    expect(block).toContain('- floor.copy.app (must):');
    expect(block).not.toContain('floor.fit');
    expect(block).not.toContain('floor.void.placed');
    expect(buildCriteriaJudgeBlock(bank, { criteriaSetId: 'x', selection: [] })).toBe('');
    expect(buildCriteriaJudgeBlock(bank, { criteriaSetId: 'x', selection: [{ id: 'floor.fit', source: 'static', reason: 'static' }] })).toBe('');
  });
});
