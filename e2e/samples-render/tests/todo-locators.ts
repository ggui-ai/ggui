/**
 * Locators for agent-authored todo UIs — find the toggleable control and its
 * "checked" indicator across the named-role and unlabeled-row patterns that
 * different LLMs emit. Pure Playwright locator builders (no spawning, no
 * harness coupling).
 *
 * Relocated here from the (retired) workspace `agent-loop-harness.ts` so the
 * samples-render suite is self-contained. If agent-rendered todo patterns
 * evolve, update these.
 */
import type { FrameLocator, Locator } from '@playwright/test';

/** A button or `role="button"` element that can be clicked, outside any loading preview. */
const ENABLED_BUTTON =
  '(self::button or @role="button") and not(@disabled) and not(@aria-disabled="true")' +
  ' and not(ancestor::*[@data-ggui-preview])';

/**
 * Text that reads `name`, outside any `[data-ggui-preview]` subtree. The
 * loading preview paints the same item texts in a disabled shell, so a row
 * found from the preview's copy of the text would hold no control to click.
 */
function itemText(frame: FrameLocator, name: RegExp): Locator {
  return frame
    .getByText(name)
    .locator('xpath=self::*[not(ancestor-or-self::*[@data-ggui-preview])]')
    .first();
}

/**
 * The row of a todo whose toggle is a button that does not carry the item in
 * its name, e.g. every row's button reads "Toggle todo". The row is the
 * nearest ancestor of the item's text that holds an enabled button. It is
 * refused when it holds a checkbox or switch, which the checkbox row reads
 * instead, or a list item or table row, which means it is the list rather
 * than one row of it.
 */
function rowWithButton(frame: FrameLocator, name: RegExp): Locator {
  return itemText(frame, name).locator(
    `xpath=ancestor-or-self::*[.//*[${ENABLED_BUTTON}]][1]` +
      '[not(.//input[@type="checkbox"] or .//*[@role="checkbox"] or .//*[@role="switch"]' +
      ' or .//li or .//*[@role="listitem"] or .//tr or .//*[@role="row"])]',
  );
}

/**
 * The clickable toggle for a todo named `name`. Tries named ARIA roles first
 * (checkbox / switch / menuitemcheckbox / button), then falls back to the
 * smallest ancestor row of the text that contains an interactive checkbox —
 * the unlabeled pattern Gemini tends to emit — and then to the first enabled
 * button in the item's row ({@link rowWithButton}), for rows whose buttons
 * all share one name. A row with a delete button before its toggle would
 * click delete; the checked indicator then fails, so that shape reads red.
 */
export function findTodoToggleable(frame: FrameLocator, name: RegExp): Locator {
  const namedRoles = frame
    .getByRole('checkbox', { name })
    .or(frame.getByRole('switch', { name }))
    .or(frame.getByRole('menuitemcheckbox', { name }))
    .or(frame.getByRole('button', { name }));

  const rowWithCheckbox = itemText(frame, name).locator(
    'xpath=ancestor-or-self::*[.//input[@type="checkbox"] or .//*[@role="checkbox"] or .//*[@role="switch"]][1]',
  );
  const rowCheckbox = rowWithCheckbox
    .getByRole('checkbox')
    .or(rowWithCheckbox.getByRole('switch'))
    .or(rowWithCheckbox.locator('input[type="checkbox"]'));
  const rowButton = rowWithButton(frame, name).locator(`xpath=.//*[${ENABLED_BUTTON}]`).first();

  return namedRoles.or(rowCheckbox).or(rowButton).first();
}

/**
 * A "completed/checked" indicator for the todo named `name`. Same labeled-vs-
 * unlabeled split as {@link findTodoToggleable} (a pressed button in the
 * item's row counts as checked), plus a near-text fallback for agents that
 * render "done"/"completed"/"✓" text instead of a checked control.
 */
export function findTodoCheckedIndicator(frame: FrameLocator, name: RegExp): Locator {
  const namedChecked = frame
    .getByRole('checkbox', { name, checked: true })
    .or(frame.getByRole('switch', { name, checked: true }))
    .or(frame.getByRole('button', { name, pressed: true }));

  const rowWithCheckbox = itemText(frame, name).locator(
    'xpath=ancestor-or-self::*[.//input[@type="checkbox"] or .//*[@role="checkbox"] or .//*[@role="switch"]][1]',
  );
  const rowChecked = rowWithCheckbox
    .getByRole('checkbox', { checked: true })
    .or(rowWithCheckbox.getByRole('switch', { checked: true }))
    .or(rowWithCheckbox.locator('input[type="checkbox"]:checked'))
    .or(rowWithButton(frame, name).getByRole('button', { pressed: true }));

  const completionTextNear = frame.getByText(
    new RegExp(
      `${name.source}[\\s\\S]{0,40}(done|completed|✓|☑|complete)|` +
        `\\b(done|completed|✓|☑|complete)\\b[\\s\\S]{0,40}${name.source}`,
      'i',
    ),
  );

  return namedChecked.or(rowChecked).or(completionTextNear).first();
}

/**
 * Wait until the todo named `name` reads as completed through an
 * ACCESSIBLE carrier — {@link findTodoCheckedIndicator}'s ARIA roles /
 * `:checked` / completion text. This is deliberately the ONLY leg:
 * the line-through computed-style fallback that used to race it
 * (added for the 2026-07-30 capstone, where a styled-div checkbox
 * carried completion in styling alone) was retired on the ggui#408
 * close condition — generation-side, the deterministic
 * `state.ui_affordance.state_aria_present` axis-check now hard-fails
 * style-only state before code ships, and the 2026-08-16 capstone
 * (run 31898735198) proved the generated control carrying an
 * ARIA/native indicator live. A timeout here is a REAL regression of
 * that guarantee, not a locator gap — investigate the generation, do
 * not resurrect the fallback.
 */
export async function waitForTodoCheckedIndicator(
  frame: FrameLocator,
  name: RegExp,
  timeout: number,
): Promise<void> {
  await findTodoCheckedIndicator(frame, name).waitFor({
    state: 'visible',
    timeout,
  });
  console.log(`[todo-locators] checked indicator for "${name.source}": ARIA/native`);
}
