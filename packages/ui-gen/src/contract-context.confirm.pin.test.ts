/**
 * Pin (ggui#1108 / #1112): the contract's `confirm` flag reaches the model as
 * INFORMATION with the field's OWN meaning — and only when it is stated.
 *
 * `confirm` was the one declared action field the contract renderer dropped
 * (label, description, example and nextStep all reached the model; this one
 * did not). It is rendered as information, never as a rule: citing it in the
 * terminal-actions section MEASURED ZERO (two wordings, n = 4 each, a `save`
 * carrying `confirm: true` came back armed 0/4 and 0/4 — reliability Exp 005).
 *
 * Its meaning is protocol's, and it is narrow: `confirm` asks the user BEFORE
 * an action fires; HOW OFTEN it may fire is `oneShot`'s question. The rendered
 * line must say the first and never the second — a line that tells the model
 * "a second press is a mistake" puts the sibling's meaning on this field, and
 * that is what this pin exists to refuse.
 *
 * Absent (or stated false), the rendered context is byte-identical to a
 * contract that never carried the key: the flag adds a line and nothing else.
 */
import { describe, expect, it } from 'vitest';
import type { DataContract } from '@ggui-ai/protocol';
import { buildContractsContext } from './contract-context.js';

const WITHOUT: DataContract = {
  actionSpec: { save: { label: 'Save', description: 'Persist the draft' } },
};
const WITH_TRUE: DataContract = {
  actionSpec: { save: { label: 'Save', description: 'Persist the draft', confirm: true } },
};
const WITH_FALSE: DataContract = {
  actionSpec: { save: { label: 'Save', description: 'Persist the draft', confirm: false } },
};

describe('contract context — the `confirm` flag (ggui#1108 / #1112)', () => {
  it('a stated `confirm: true` renders as an author flag that says the field\'s OWN meaning: confirm BEFORE it fires — never how often', () => {
    const rendered = buildContractsContext(WITH_TRUE);
    expect(rendered).toContain('Author flag: `confirm`');
    expect(rendered).toMatch(/before it fires/i);
    // `oneShot`'s meaning does not belong on this line.
    expect(rendered).not.toMatch(/second press|once|at most/i);
  });

  it('the flag adds ONE line and nothing else: with it, the rest of the context is byte-identical to without it', () => {
    const w = buildContractsContext(WITH_TRUE).split('\n');
    const wo = buildContractsContext(WITHOUT).split('\n');
    const extra = w.filter((l) => !wo.includes(l));
    expect(extra).toHaveLength(1);
    expect(extra[0]).toContain('Author flag: `confirm`');
    expect(wo.filter((l) => !w.includes(l))).toEqual([]);
  });

  it('absent or `confirm: false` ⇒ byte-identical to a contract that never carried the key', () => {
    expect(buildContractsContext(WITH_FALSE)).toBe(buildContractsContext(WITHOUT));
    expect(buildContractsContext(WITHOUT)).not.toContain('Author flag');
  });
});
