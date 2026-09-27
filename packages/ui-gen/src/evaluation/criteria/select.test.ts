// ggui#1436 — the selector is deterministic and recorded: same context → same id and set; a changed key changes the id;
// the bank's gates and each criterion's appliesWhen decide the set, and every entry carries its reason.
import { describe, expect, it } from 'vitest';
import type { CriteriaContext } from '../types-public.js';
import { parseCriteriaBank } from './bank.js';
import { CRITERIA_SELECTOR_VERSION, canonicalCriteriaContext, criteriaSetIdFor, selectCriteria } from './select.js';

const bank = parseCriteriaBank({
  version: 'v1',
  applies: { kind: ['hello'], canvases: ['xs-chat-card', 'md'] },
  criteria: [
    { id: 'floor.fit', severity: 'must', checker: 'instrument', scope: 'static', text: 't', evidence: 'e' },
    { id: 'finish.chip.primacy', severity: 'must', checker: 'judge', text: 't', evidence: 'e', appliesWhen: { hasActions: true } },
    { id: 'finish.colour.field', severity: 'must', checker: 'instrument', text: 't', evidence: 'e', appliesWhen: { chroma: 'chromatic', canvases: ['xs-chat-card'] } },
    { id: 'hello.greeting', severity: 'should', checker: 'judge', text: 't', evidence: 'e', appliesWhen: { kinds: ['hello'] } },
  ],
});
const ctx: CriteriaContext = {
  canvas: 'xs-chat-card',
  hasActions: true,
  riskTier: 'low',
  axes: { render: 'static', state: 'none', writes: 'none', fetch: 'none', layout: 'single' },
  chroma: 'chromatic',
  profilePresent: true,
  shell: 'chat',
  kind: 'hello',
};

describe('selectCriteria (ggui#1436)', () => {
  it('same context → same criteriaSetId and the same selection; key order does not matter', () => {
    const a = selectCriteria(bank, ctx);
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(ctx).reverse()))) as CriteriaContext;
    const b = selectCriteria(bank, reordered);
    expect(a.criteriaSetId).toHaveLength(16);
    expect(b).toEqual(a);
    expect(canonicalCriteriaContext(reordered)).toBe(canonicalCriteriaContext(ctx));
    expect(criteriaSetIdFor('v1', ctx)).toBe(a.criteriaSetId);
    expect(CRITERIA_SELECTOR_VERSION).toBe('selector@1');
  });
  it('records why each criterion was asked: static vs the matched context conditions', () => {
    const { selection } = selectCriteria(bank, ctx);
    expect(selection).toEqual([
      { id: 'floor.fit', source: 'static', reason: 'static (scope static)' },
      { id: 'finish.chip.primacy', source: 'context', reason: 'context: hasActions=true' },
      { id: 'finish.colour.field', source: 'context', reason: 'context: canvas=xs-chat-card, chroma=chromatic' },
      { id: 'hello.greeting', source: 'context', reason: 'context: kind=hello' },
    ]);
  });
  it('a changed key changes the id and the set; an omitted criterion is absent, never n/a', () => {
    const noActions = selectCriteria(bank, { ...ctx, hasActions: false });
    expect(noActions.criteriaSetId).not.toBe(selectCriteria(bank, ctx).criteriaSetId);
    expect(noActions.selection.map((s) => s.id)).toEqual(['floor.fit', 'finish.colour.field', 'hello.greeting']);
    const achromaticMd = selectCriteria(bank, { ...ctx, chroma: 'achromatic', canvas: 'md' });
    expect(achromaticMd.selection.map((s) => s.id)).toEqual(['floor.fit', 'finish.chip.primacy', 'hello.greeting']);
  });
  it('the bank-level gates: a canvas outside `applies` selects nothing; kind gates only when the caller named one', () => {
    expect(selectCriteria(bank, { ...ctx, canvas: 'lg' }).selection).toEqual([]);
    expect(selectCriteria(bank, { ...ctx, kind: 'dashboard' }).selection).toEqual([]);
    const { kind: _kind, ...noKind } = ctx;
    expect(selectCriteria(bank, noKind).selection.map((s) => s.id)).toEqual(['floor.fit', 'finish.chip.primacy', 'finish.colour.field']);
  });
});
