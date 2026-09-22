/**
 * ggui#1190 — an action's control copy is the contract's `label`, VERBATIM.
 * The model was given `"Confirm & Schedule"` (contract-context) and wrote
 * `'Confirm Schedule'`: the label reached the prompt's contract block but not
 * the scaffold's hook site (shown there only when `nextStep` was set), and no
 * rule said "verbatim". Two legs pinned here — the reminder beside EVERY
 * action, and the hard rule — beside the axis WARN that already names a
 * dropped label. RED before, GREEN after. Since ggui#1244 the reminder rides
 * each action's payload-type doc comment, never the hook line (see
 * generate.once-hint.test.ts for why the hook line must carry the once-hint
 * alone).
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
  it("every action's payload-type doc comment carries the contract label verbatim, punctuation included — with or without nextStep", () => {
    const lines = generateBoilerplate('a maintenance scheduler', CONTRACT, 'chat', 'desktop').split('\n');
    const payloadDoc = (typeName: string): string | undefined =>
      lines[lines.findIndex((l) => l.startsWith(`type ${typeName} =`)) - 1];
    expect(payloadDoc('ActionConfirmSchedulePayload'), 'the confirmSchedule payload type is documented').toContain(
      'control copy: "Confirm & Schedule" VERBATIM',
    );
    expect(payloadDoc('ActionCancelPayload')).toContain('control copy: "Cancel" VERBATIM');
    const cancelHook = lines.find((l) => l.includes("useAction<ActionCancelPayload>('cancel')"));
    expect(cancelHook).toContain('nextStep: close_dialog');
  });

  it('the hard rule says the label is shown verbatim — every character, never paraphrased', () => {
    expect(DATA_PARAMETERIZATION).toMatch(/action[^\n]*label[^\n]*VERBATIM/i);
    expect(DATA_PARAMETERIZATION).toContain('`&`');
    expect(DATA_PARAMETERIZATION).toContain('is not `"Confirm Schedule"`');
  });
});
