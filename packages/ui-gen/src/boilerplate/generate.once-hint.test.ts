/**
 * ggui#1244 — the action hook line carries the once-hint ALONE.
 *
 * ggui#1190 put its copy reminder (`— control copy: "<label>" VERBATIM`) on
 * every hook line, directly before ggui#1108's `— if this is meant ONCE,
 * disable its control after it fires`. Side by side the two read as the
 * control's spec: gemini-3.5-flash-lite guarded the wire scenarios' repeatable
 * Save 8/8 (1/8 with the pair split, 1/8 before either). Removing the once-hint
 * instead cost the true positive — one-time scheduling guarded 9/12 against
 * 24/24 — so the hint stays and its neighbour moves: the copy reminder rides
 * the payload type's doc comment (generate.action-label.test.ts). Exp 009.
 */
import { describe, it, expect } from 'vitest';
import { generateBoilerplate } from './generate';

const CONTRACT = {
  actionSpec: {
    save: { label: 'Save' },
    confirmBooking: { label: 'Confirm Booking', nextStep: 'send_confirmation' },
  },
} as const;

describe('generateBoilerplate — the hook line carries the once-hint alone (ggui#1244)', () => {
  const lines = generateBoilerplate('a reservation card with a save button', CONTRACT, 'chat', 'desktop').split('\n');
  const hookLines = lines.filter((l) => l.includes('= useAction<'));

  it('scaffolds one hook line per action', () => {
    expect(hookLines).toHaveLength(2);
  });

  it('every hook line keeps the once-hint and carries no copy reminder beside it', () => {
    for (const line of hookLines) {
      expect(line).toContain('if this is meant ONCE, disable its control after it fires');
      expect(line).not.toContain('control copy');
      expect(line).not.toContain('VERBATIM');
    }
  });

  it('the Save hook line is byte-identical to the line that ran before the two hints met', () => {
    expect(hookLines.find((l) => l.includes("('save')"))).toBe(
      "  const save = useAction<ActionSavePayload>('save'); // () => void — fire and forget — if this is meant ONCE, disable its control after it fires",
    );
  });

  it('the copy reminder moved, it did not leave — each payload type still states its label', () => {
    const doc = (typeName: string): string | undefined => lines[lines.findIndex((l) => l.startsWith(`type ${typeName} =`)) - 1];
    expect(doc('ActionSavePayload')).toContain('control copy: "Save" VERBATIM');
    expect(doc('ActionConfirmBookingPayload')).toContain('control copy: "Confirm Booking" VERBATIM');
  });
});
