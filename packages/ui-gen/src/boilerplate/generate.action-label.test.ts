/**
 * ggui#1190 — an action's control copy is the contract's `label`, VERBATIM.
 * The model was given `"Confirm & Schedule"` (contract-context) and wrote
 * `'Confirm Schedule'`: the label reached the prompt's contract block but not
 * the scaffold's hook site (shown there only when `nextStep` was set), and no
 * rule said "verbatim". Two legs pinned here — the site comment for EVERY
 * action, and the hard rule — beside the axis WARN that already names a
 * dropped label. RED before, GREEN after.
 */
import { describe, it, expect } from 'vitest';
import { generateBoilerplate } from './generate';
import { DATA_PARAMETERIZATION } from './hard-sections';

const CONTRACT = {
  propsSpec: { properties: { heading: { schema: { type: 'string' }, required: true } } },
  actionSpec: {
    confirmSchedule: { label: 'Confirm & Schedule', description: 'Operator confirms scheduling' },
    cancel: { label: 'Cancel', nextStep: 'close_dialog' },
  },
} as const;

describe('generateBoilerplate — the action label at the hook site (ggui#1190)', () => {
  it('every action hook line carries the contract label verbatim, punctuation included — with or without nextStep', () => {
    const boilerplate = generateBoilerplate('a maintenance scheduler', CONTRACT, 'chat', 'desktop');
    const confirm = boilerplate.split('\n').find((l) => l.includes("useAction<ActionConfirmSchedulePayload>('confirmSchedule')"));
    expect(confirm, 'the confirmSchedule hook line exists').toBeDefined();
    expect(confirm).toContain('control copy: "Confirm & Schedule" VERBATIM');
    const cancel = boilerplate.split('\n').find((l) => l.includes("useAction<ActionCancelPayload>('cancel')"));
    expect(cancel).toContain('control copy: "Cancel" VERBATIM');
    expect(cancel).toContain('nextStep: close_dialog');
  });

  it('the hard rule says the label is shown verbatim — every character, never paraphrased', () => {
    expect(DATA_PARAMETERIZATION).toMatch(/action[^\n]*label[^\n]*VERBATIM/i);
    expect(DATA_PARAMETERIZATION).toContain('`&`');
    expect(DATA_PARAMETERIZATION).toContain('is not `"Confirm Schedule"`');
  });
});
