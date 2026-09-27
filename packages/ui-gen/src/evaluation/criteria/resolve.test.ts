// ggui#1436 — from K answers and the capture's measurements to one block: K-majority per judge row, a tie or an
// unanswered id reads n/a (the CTO's A2), instruments answer from measurements only when live, otherwise n/a with the
// reason from `status`; humans read n/a; every verdict carries severity, method and status.
import { describe, expect, it } from 'vitest';
import type { CriteriaContext } from '../types-public.js';
import { parseCriteriaBank } from './bank.js';
import { CRITERIA_PROPS_MAX_CHARS, buildCriteriaJudgeBlock, criteriaFrameLine, resolveCriteriaBlock } from './resolve.js';
import { selectCriteria } from './select.js';

const bank = parseCriteriaBank({
  version: 'v2',
  criteria: [
    { id: 'comp.fit', scope: {}, severity: 'must', evaluation: 'instrument', status: 'live', text: 'fits', evidence: 'the bottom edge' },
    { id: 'read.contrast', scope: {}, severity: 'must', evaluation: 'instrument', status: 'reference', text: 'AA', evidence: 'the text on the field' },
    { id: 'host.casing', scope: {}, severity: 'must', evaluation: 'instrument', status: 'planned', text: 'casing', evidence: 'the prose' },
    { id: 'space.shape', scope: {}, severity: 'should', evaluation: 'judge', status: 'planned', text: 'two radius families', evidence: 'the card and the pills' },
    { id: 'task.copy', scope: {}, severity: 'must', evaluation: 'judge', status: 'planned', text: "the app's copy", evidence: 'the greeting' },
    { id: 'comp.void', scope: {}, severity: 'should', evaluation: 'human', status: 'manual', text: 'placed void', evidence: 'the empty region' },
    { id: 'finish.canvas.inhabited', scope: {}, severity: 'should', evaluation: 'instrument', status: 'live', text: 'inhabited', evidence: 'the void' },
    { id: 'host.theme', scope: {}, severity: 'must', evaluation: 'instrument', status: 'live', text: 'theme', evidence: 'the tokens' },
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
  it("K-majority per judge row; the evidence is a majority vote's; a tie and an unanswered id read n/a; severity/method/status ride each verdict", () => {
    const answers = [
      [{ id: 'space.shape', verdict: 'pass' as const, evidence: 'card + pills only' }, { id: 'task.copy', verdict: 'pass' as const, evidence: 'greeting names the app' }],
      [{ id: 'space.shape', verdict: 'pass' as const, evidence: 'two families' }, { id: 'task.copy', verdict: 'fail' as const, evidence: 'lorem' }],
      [{ id: 'space.shape', verdict: 'fail' as const, evidence: 'three' }, { id: 'task.copy', verdict: 'n/a' as const, evidence: 'cannot read' }],
    ];
    const block = resolveCriteriaBlock({ bank, context: ctx, selected, answers, measurements: m });
    const by = Object.fromEntries(block.verdicts.map((v) => [v.id, v]));
    expect(by['space.shape']).toEqual({ id: 'space.shape', severity: 'should', method: 'judge', status: 'planned', source: 'static', verdict: 'pass', evidence: 'card + pills only' });
    expect(by['task.copy']).toMatchObject({ verdict: 'n/a', evidence: 'no majority', severity: 'must' });
    expect(block.criteriaSetId).toBe(selected.criteriaSetId);
    expect(block.context).toEqual(ctx);
    expect(block.bankVersion).toBe('v2');
    expect(block.selectorVersion).toBe('selector@2');
    const unanswered = resolveCriteriaBlock({ bank, context: ctx, selected, answers: [[], []], measurements: m });
    expect(unanswered.verdicts.find((v) => v.id === 'task.copy')).toMatchObject({ verdict: 'n/a', evidence: 'not answered' });
  });
  it('instruments: live + bound → measured (fit with numbers, fill reported at n/a); live unbound → "not wired"; reference/planned → n/a from status; humans n/a', () => {
    const block = resolveCriteriaBlock({ bank, context: ctx, selected, answers: [[]], measurements: m });
    const by = Object.fromEntries(block.verdicts.map((v) => [v.id, v]));
    expect(by['comp.fit']).toMatchObject({ verdict: 'pass', evidence: 'content 500px against a 1024px box', method: 'instrument', status: 'live' });
    expect(by['finish.canvas.inhabited']).toMatchObject({ verdict: 'n/a', evidence: 'fill 0.412 reported; no floor ruled' });
    expect(by['host.theme']).toMatchObject({ verdict: 'n/a', evidence: 'instrument not wired (status live, no binding)' });
    expect(by['read.contrast']).toMatchObject({ verdict: 'n/a', evidence: 'not implemented (status reference)' });
    expect(by['host.casing']).toMatchObject({ verdict: 'n/a', evidence: 'not implemented (status planned)' });
    expect(by['comp.void']).toMatchObject({ verdict: 'n/a', evidence: "reader's column (status manual)", method: 'human' });
    const overflowing = resolveCriteriaBlock({ bank, context: ctx, selected, answers: [[]], measurements: { ...m, overflow: true, contentHeight: 1300 } });
    expect(overflowing.verdicts.find((v) => v.id === 'comp.fit')).toMatchObject({ verdict: 'fail', evidence: 'content 1300px against a 1024px box' });
    const unmeasured = resolveCriteriaBlock({ bank, context: ctx, selected, answers: [[]], measurements: { ...m, contentHeight: null, inkRatio: null } });
    expect(unmeasured.verdicts.find((v) => v.id === 'comp.fit')).toMatchObject({ verdict: 'n/a', evidence: 'content height unmeasurable' });
    expect(unmeasured.verdicts.find((v) => v.id === 'finish.canvas.inhabited')).toMatchObject({ verdict: 'n/a', evidence: 'capture unreadable' });
  });
  it('the judge block lists only judge rows with their evidence rule and the frame-only instruction; empty when none is selected', () => {
    const block = buildCriteriaJudgeBlock(bank, selected);
    expect(block).toContain('from the FRAME only');
    expect(block).toContain('- space.shape (should): two radius families Evidence must name: the card and the pills');
    expect(block).toContain('- task.copy (must):');
    expect(block).not.toContain('comp.fit');
    expect(block).not.toContain('comp.void');
    expect(buildCriteriaJudgeBlock(bank, { criteriaSetId: 'x', selection: [] })).toBe('');
    // the inline chat card is host-sized: the block says to judge inside the card's extent on that canvas only
    // every canvas names its box and how the card occupies it (the evidence audit on #1438: phone rows guessed a tablet box)
    const xs = { canvas: 'xs-chat-card' as const, width: 400, height: 640 };
    const phone = { canvas: 'mobile-fullscreen-small' as const, width: 390, height: 844 };
    // ggui#1475 — the capture IS the card at its natural height (the box is its ceiling), so the line names no void under it.
    expect(criteriaFrameLine(xs)).toContain("an inline chat card captured at its natural height (at most 400×640, the host's ceiling)");
    expect(criteriaFrameLine(xs)).not.toContain('empty region');
    expect(criteriaFrameLine(phone)).toContain('390×844, a fixed full-screen box the card fills');
    expect(buildCriteriaJudgeBlock(bank, selected, { frame: xs })).toContain(criteriaFrameLine(xs));
    expect(buildCriteriaJudgeBlock(bank, selected, { frame: phone })).toContain(criteriaFrameLine(phone));
    expect(buildCriteriaJudgeBlock(bank, selected, { frame: { canvas: 'md', width: 384, height: 516 } })).toContain('This frame is 384×516, a fixed');
    expect(block).not.toContain('This frame is');
    // the rendered props are the one declared non-frame input, bounded and labelled
    const withProps = buildCriteriaJudgeBlock(bank, selected, { propsJson: '{"title":"Harbor"}' });
    expect(withProps).toContain('The one input besides the frame — the props this card was rendered with');
    expect(withProps).toContain('{"title":"Harbor"}');
    expect(block).not.toContain('The one input besides the frame');
    const long = buildCriteriaJudgeBlock(bank, selected, { propsJson: `"${'x'.repeat(CRITERIA_PROPS_MAX_CHARS + 50)}"` });
    expect(long).toContain('… (truncated)');
    // the judge's n/a means not evaluated, never "does not apply" (applicability is the selector's)
    expect(block).toContain('"n/a" never means "does not apply"');
    expect(block).toContain('recorded as not evaluated');
    expect(buildCriteriaJudgeBlock(bank, { criteriaSetId: 'x', selection: [{ id: 'comp.fit', source: 'static', reason: 'static' }] })).toBe('');
  });
});
