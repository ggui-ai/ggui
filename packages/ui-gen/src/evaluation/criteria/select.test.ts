// ggui#1436 — the selector is deterministic and recorded: same context → same id and set; a changed key changes the id;
// the bank's gates and each row's scope decide the set, recipes only under their preset, every entry with its reason.
import { describe, expect, it } from 'vitest';
import type { CriteriaContext } from '../types-public.js';
import { parseCriteriaBank } from './bank.js';
import { CRITERIA_SELECTOR_VERSION, canonicalCriteriaContext, criteriaSetIdFor, selectCriteria } from './select.js';

const bank = parseCriteriaBank({
  version: 'v2',
  applies: { kind: ['*'], canvases: ['xs-chat-card', 'md'] },
  criteria: [
    { id: 'comp.fit', scope: {}, severity: 'must', evaluation: 'instrument', status: 'live', text: 't', evidence: 'e' },
    { id: 'state.empty', scope: { kind: 'list' }, severity: 'should', evaluation: 'judge', status: 'planned', text: 't', evidence: 'e' },
    { id: 'state.composer', scope: { kind: 'chat', canvas: 'xs-chat-card' }, severity: 'should', evaluation: 'judge', status: 'planned', text: 't', evidence: 'e' },
    { id: 'comp.touch', scope: { canvas: 'md' }, severity: 'should', evaluation: 'instrument', status: 'planned', text: 't', evidence: 'e' },
  ],
  recipes: [{ id: 'hello.field', scope: { preset: 'hello' }, severity: 'must', evaluation: 'instrument', status: 'reference', text: 't', evidence: 'e' }],
});
const ctx: CriteriaContext = {
  canvas: 'xs-chat-card',
  hasActions: true,
  riskTier: 'low',
  axes: { render: 'static', state: 'none', writes: 'none', fetch: 'none', layout: 'single' },
  chroma: 'chromatic',
  profilePresent: true,
  shell: 'chat',
  kind: 'chat',
  preset: 'hello',
};

describe('selectCriteria (ggui#1436)', () => {
  it('same context → same criteriaSetId and the same selection; key order does not matter', () => {
    const a = selectCriteria(bank, ctx);
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(ctx).reverse()))) as CriteriaContext;
    const b = selectCriteria(bank, reordered);
    expect(a.criteriaSetId).toHaveLength(16);
    expect(b).toEqual(a);
    expect(canonicalCriteriaContext(reordered)).toBe(canonicalCriteriaContext(ctx));
    expect(criteriaSetIdFor('v2', ctx)).toBe(a.criteriaSetId);
    expect(CRITERIA_SELECTOR_VERSION).toBe('selector@2');
  });
  it('records why each row was asked: static (empty scope) vs the matched scope keys; a recipe only under its preset', () => {
    const { selection } = selectCriteria(bank, ctx);
    expect(selection).toEqual([
      { id: 'comp.fit', source: 'static', reason: 'static' },
      { id: 'state.composer', source: 'context', reason: 'context: kind=chat, canvas=xs-chat-card' },
      { id: 'hello.field', source: 'context', reason: 'context: preset=hello' },
    ]);
  });
  it('a changed key changes the id and the set; an omitted row is absent, never n/a', () => {
    const md = selectCriteria(bank, { ...ctx, canvas: 'md' });
    expect(md.criteriaSetId).not.toBe(selectCriteria(bank, ctx).criteriaSetId);
    expect(md.selection.map((s) => s.id)).toEqual(['comp.fit', 'comp.touch', 'hello.field']);
    const { preset: _p, ...noPreset } = ctx;
    expect(selectCriteria(bank, noPreset).selection.map((s) => s.id)).toEqual(['comp.fit', 'state.composer']);
    expect(selectCriteria(bank, { ...ctx, kind: 'list' }).selection.map((s) => s.id)).toEqual(['comp.fit', 'state.empty', 'hello.field']);
  });
  it('the bank-level gates: a canvas outside `applies` selects nothing; kind `*` admits any kind; a named kind list gates only when the caller named one', () => {
    expect(selectCriteria(bank, { ...ctx, canvas: 'lg' }).selection).toEqual([]);
    const gated = parseCriteriaBank({ ...bank, applies: { kind: ['hello'], canvases: ['xs-chat-card'] } });
    expect(selectCriteria(gated, { ...ctx, kind: 'dashboard' }).selection).toEqual([]);
    const { kind: _k, ...noKind } = ctx;
    expect(selectCriteria(gated, noKind).selection.map((s) => s.id)).toEqual(['comp.fit', 'hello.field']);
  });
});
