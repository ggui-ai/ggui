// ggui#1436 — the bank is data: the ONE loader accepts the authored v2 shape (criteria + recipes, the founder's field
// split), drops page matter, and refuses a malformed entry naming its path.
import { describe, expect, it } from 'vitest';
import { bankRows, parseCriteriaBank } from './bank.js';

const V2 = {
  version: '2026-09-27.2',
  seed: 'page matter',
  fields: { scope: 'page matter' },
  groups: ['readability'],
  applies: { kind: ['*'], canvases: ['xs-chat-card', 'md'] },
  criteria: [
    { id: 'read.contrast', group: 'readability', scope: {}, severity: 'must', evaluation: 'instrument', status: 'reference', text: 'AA everywhere.', evidence: 'per text box', fix: 'Raise the contrast.', examples: { pairs: ['page only'] } },
    { id: 'task.copy', group: 'task', scope: {}, severity: 'must', evaluation: 'judge', status: 'planned', text: "The copy is the app's.", evidence: 'the greeting line' },
    { id: 'state.empty', group: 'states', scope: { kind: 'list' }, severity: 'should', evaluation: 'judge', status: 'planned', text: 'An empty state reads as designed.', evidence: 'the list region' },
    { id: 'comp.fit', group: 'composition', scope: {}, severity: 'must', evaluation: 'instrument', status: 'live', text: 'Fits its box.', evidence: 'the bottom edge' },
  ],
  recipes: [
    { id: 'hello.field', group: 'preset', scope: { preset: 'hello' }, severity: 'must', evaluation: 'instrument', status: 'reference', text: 'The primary appears as a field.', evidence: 'the band', fix: 'Make the band a field.' },
  ],
};

describe('parseCriteriaBank (ggui#1436)', () => {
  it('accepts the authored v2 shape, keeps the split fields, drops page matter', () => {
    const bank = parseCriteriaBank(V2);
    expect(bank.version).toBe('2026-09-27.2');
    expect(bankRows(bank).map((r) => r.id)).toEqual(['read.contrast', 'task.copy', 'state.empty', 'comp.fit', 'hello.field']);
    expect(bank.criteria[0]).toMatchObject({ severity: 'must', evaluation: 'instrument', status: 'reference', scope: {} });
    expect('examples' in bank.criteria[0]!).toBe(false);
    expect('fields' in bank).toBe(false);
    expect(bank.recipes![0]!.scope).toEqual({ preset: 'hello' });
    expect(bank.applies).toEqual({ kind: ['*'], canvases: ['xs-chat-card', 'md'] });
  });
  it('a row without a scope reads as static (scope {}); a missing status or an unknown evaluation refuses with the path', () => {
    const noScope = parseCriteriaBank({ ...V2, criteria: [{ ...V2.criteria[3], scope: undefined }] });
    expect(noScope.criteria[0]!.scope).toEqual({});
    expect(() => parseCriteriaBank({ ...V2, criteria: [{ ...V2.criteria[3], status: undefined }] })).toThrow(/criteria\.0\.status/);
    expect(() => parseCriteriaBank({ ...V2, criteria: [{ ...V2.criteria[3], evaluation: 'oracle' }] })).toThrow(/criteria\.0\.evaluation/);
    expect(() => parseCriteriaBank({ ...V2, criteria: [{ ...V2.criteria[3], severity: 'nice' }] })).toThrow(/criteria\.0\.severity/);
  });
  it('refuses a duplicate id across criteria and recipes, a malformed id, an empty bank — at launch, with the path', () => {
    expect(() => parseCriteriaBank({ ...V2, recipes: [{ ...V2.recipes[0], id: 'comp.fit' }] })).toThrow(/recipes\.0\.id: duplicate criterion id comp\.fit/);
    expect(() => parseCriteriaBank({ ...V2, criteria: [{ ...V2.criteria[1], id: 'Copy' }] })).toThrow(/criteria\.0\.id/);
    expect(() => parseCriteriaBank({ version: 'x', criteria: [] })).toThrow(/criteria/);
  });
});
