/**
 * The repeatable-control tripwire, shared by scenario 3 (a generated
 * card) and scenario 29 (fixed cards that pin both of its branches).
 */
import { expect } from 'vitest';
import type { FrameLocator, Locator } from 'playwright-core';

/**
 * `save` is a REPEATABLE action, and both halves of that are declared by
 * the fixture rather than assumed here: it is absent from ui-gen's
 * `TERMINAL_WORDS` (`submit|confirm|approve|schedule|reserve|book|pay|
 * checkout|purchase|order`), and `SHARED_INTENT` (fixtures/shared-contract.ts) says the click
 * "fires the save action immediately". So its control MUST survive its
 * own gesture.
 *
 * Why this assertion exists at all (ggui#1108, Exp 005): over-guarding
 * has **no lexical signal**. Terminality does — the action's name — which
 * is why `universal.terminal_action_unguarded` can be keyword-shaped.
 * Nothing in generated source distinguishes a correctly guarded terminal
 * control from a wrongly guarded repeatable one; the only distinguishing
 * act is interacting a SECOND time, which is what scenario 3's click loop
 * already does. That made the loop an accidental detector. This makes it
 * an explicit one.
 *
 * It buys LEGIBILITY, not coverage: the loop already fails when the
 * control is guarded, but it fails as a 30s `element is not enabled`
 * timeout that cost a bisect to interpret. A detector whose output has to
 * be decoded gets misread by whoever meets it first.
 *
 * Scope, deliberately: ONE generated-card spec asserts this (scenario 3),
 * not three. 01 and 10 share the fixture and keep the bare loop, so this
 * claim has a single owner. Scenario 29 pins the check itself on fixed
 * cards, both branches, so a pass never depends on what a model drew. And
 * the claim sees exactly one shape — a single-action Save contract — so a
 * model that over-guards only book/pay-shaped repeatables passes here
 * clean. This is a regression tripwire, never the acceptance criterion
 * for a prompt change.
 *
 * Pending is not guarding (ggui#1398). A control that dispatches an action
 * shows it is working until the agent's answer repaints the card, or until
 * the runtime's pending bound passes: it is `disabled`, `aria-busy`, and
 * often relabelled ("Saving…", which `/save/i` does not match). It clears
 * when the card is next repainted, and at the latest when the bound
 * passes. In this harness a repaint follows the tap within seconds
 * (scenario 29's pending card recovers in under 9 s). The check does not
 * rely on either: it asks two things. Right after the
 * gesture the control is still there (a visible `/save/i` control, or a
 * pending `aria-busy` one), and within the bound it comes back as an
 * enabled `/save/i` control. A guarded control never comes back.
 */
/** `DEFAULT_ACTION_PENDING_BOUND_MS` in `@ggui-ai/wire`'s wire-config, plus margin. */
export const PENDING_CLEARS_WITHIN_MS = 20_000 + 10_000;

export async function expectSaveStillRepeatable(appFrame: FrameLocator, controls: Locator): Promise<void> {
  const visible = controls.filter({ visible: true });
  const pending = appFrame.locator('button[aria-busy="true"]').filter({ visible: true });
  expect(
    (await visible.count()) + (await pending.count()),
    'repeatable action `save` lost its control after firing — no visible /save/i ' +
      'control and no pending (aria-busy) control remains. `save` is not in ui-gen ' +
      'TERMINAL_WORDS and SHARED_INTENT declares the click fires it immediately, so ' +
      'the control must survive its own gesture.',
  ).toBeGreaterThan(0);

  const enabledAgain = await expect
    .poll(async () => (await visible.count()) > 0 && (await visible.first().isEnabled()), {
      timeout: PENDING_CLEARS_WITHIN_MS,
      interval: 500,
    })
    .toBe(true)
    .then(
      () => true,
      () => false,
    );
  const label = (
    await (enabledAgain ? visible : pending).first().innerText({ timeout: 1_000 }).catch(() => '')
  ).trim();
  expect(
    enabledAgain,
    `repeatable action \`save\` was guarded after firing — ${PENDING_CLEARS_WITHIN_MS} ms ` +
      `later the control reads "${label}" and is still not an enabled /save/i control. ` +
      `A pending state clears within the runtime's bound; this one did not. \`save\` is ` +
      `not in ui-gen TERMINAL_WORDS and SHARED_INTENT declares the click fires it ` +
      `immediately, so it must accept a second interaction.`,
  ).toBe(true);
}
