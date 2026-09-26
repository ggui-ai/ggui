// ggui#1436 — the bank is data: the ONE loader accepts the authored shape, keeps additive fields, and refuses a malformed entry naming its path.
import { describe, expect, it } from 'vitest';
import { parseCriteriaBank } from './bank.js';

const V1 = {
  version: '2026-09-27.1',
  applies: { kind: ['hello'], canvases: ['xs-chat-card', 'md', 'phone'] },
  criteria: [
    { id: 'finish.colour.field', property: 2, level: 'must', checker: 'instrument', scope: 'static', text: 'The primary appears as a field.', evidence: 'the band or panel', fix: 'Add a band.' },
    { id: 'finish.rhythm.radius', property: null, level: 'should', checker: 'judge', text: 'At most two radius families.', evidence: 'the card and the pills' },
    { id: 'floor.copy.app', level: 'must', checker: 'judge', text: 'The copy is the app\'s.', evidence: 'the greeting line', appliesWhen: { kinds: ['hello'] } },
    { id: 'floor.fit', level: 'must', checker: 'instrument', text: 'The card fits its box.', evidence: 'the bottom edge', extra: 'tomorrow\'s field' },
  ],
};

describe('parseCriteriaBank (ggui#1436)', () => {
  it('accepts the authored v1 shape and keeps additive fields', () => {
    const bank = parseCriteriaBank(V1);
    expect(bank.version).toBe('2026-09-27.1');
    expect(bank.criteria.map((c) => c.id)).toEqual(['finish.colour.field', 'finish.rhythm.radius', 'floor.copy.app', 'floor.fit']);
    expect(bank.criteria[0]!.scope).toBe('static');
    // The authored file numbers the standard's properties and leaves the floor's unset (null).
    expect(bank.criteria[0]!.property).toBe(2);
    expect(bank.criteria[1]!.property).toBeNull();
    expect(bank.criteria[2]!.appliesWhen).toEqual({ kinds: ['hello'] });
  });
  it('refuses a duplicate id, naming the path', () => {
    const dup = { ...V1, criteria: [...V1.criteria, { ...V1.criteria[1] }] };
    expect(() => parseCriteriaBank(dup)).toThrow(/criteria\.4\.id: duplicate criterion id finish\.rhythm\.radius/);
  });
  it('refuses a malformed id, a missing text, an unknown checker — at launch, with the path', () => {
    expect(() => parseCriteriaBank({ ...V1, criteria: [{ ...V1.criteria[1], id: 'Radius' }] })).toThrow(/criteria\.0\.id/);
    expect(() => parseCriteriaBank({ ...V1, criteria: [{ ...V1.criteria[1], text: '' }] })).toThrow(/criteria\.0\.text/);
    expect(() => parseCriteriaBank({ ...V1, criteria: [{ ...V1.criteria[1], checker: 'oracle' }] })).toThrow(/criteria\.0\.checker/);
    expect(() => parseCriteriaBank({ version: 'x', criteria: [] })).toThrow(/criteria/);
  });
});
