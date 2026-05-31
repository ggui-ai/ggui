/**
 * Locators for agent-authored todo UIs — find the toggleable control and its
 * "checked" indicator across the named-role and unlabeled-row patterns that
 * different LLMs emit. Pure Playwright locator builders (no spawning, no
 * harness coupling).
 *
 * Relocated here from the (retired) workspace `agent-loop-harness.ts` so the
 * scaffold-render suite is self-contained. If agent-rendered todo patterns
 * evolve, update these.
 */
import type { FrameLocator, Locator } from '@playwright/test';

/**
 * The clickable toggle for a todo named `name`. Tries named ARIA roles first
 * (checkbox / switch / menuitemcheckbox / button), then falls back to the
 * smallest ancestor row of the text that contains an interactive checkbox —
 * the unlabeled pattern Gemini tends to emit.
 */
export function findTodoToggleable(frame: FrameLocator, name: RegExp): Locator {
  const namedRoles = frame
    .getByRole('checkbox', { name })
    .or(frame.getByRole('switch', { name }))
    .or(frame.getByRole('menuitemcheckbox', { name }))
    .or(frame.getByRole('button', { name }));

  const rowWithCheckbox = frame
    .getByText(name)
    .first()
    .locator(
      'xpath=ancestor-or-self::*[.//input[@type="checkbox"] or .//*[@role="checkbox"] or .//*[@role="switch"]][1]',
    );
  const rowCheckbox = rowWithCheckbox
    .getByRole('checkbox')
    .or(rowWithCheckbox.getByRole('switch'))
    .or(rowWithCheckbox.locator('input[type="checkbox"]'));

  return namedRoles.or(rowCheckbox).first();
}

/**
 * A "completed/checked" indicator for the todo named `name`. Same labeled-vs-
 * unlabeled split as {@link findTodoToggleable}, plus a near-text fallback for
 * agents that render "done"/"completed"/"✓" text instead of a checked control.
 */
export function findTodoCheckedIndicator(frame: FrameLocator, name: RegExp): Locator {
  const namedChecked = frame
    .getByRole('checkbox', { name, checked: true })
    .or(frame.getByRole('switch', { name, checked: true }));

  const rowWithCheckbox = frame
    .getByText(name)
    .first()
    .locator(
      'xpath=ancestor-or-self::*[.//input[@type="checkbox"] or .//*[@role="checkbox"] or .//*[@role="switch"]][1]',
    );
  const rowChecked = rowWithCheckbox
    .getByRole('checkbox', { checked: true })
    .or(rowWithCheckbox.getByRole('switch', { checked: true }))
    .or(rowWithCheckbox.locator('input[type="checkbox"]:checked'));

  const completionTextNear = frame.getByText(
    new RegExp(
      `${name.source}[\\s\\S]{0,40}(done|completed|✓|☑|complete)|` +
        `\\b(done|completed|✓|☑|complete)\\b[\\s\\S]{0,40}${name.source}`,
      'i',
    ),
  );

  return namedChecked.or(rowChecked).or(completionTextNear).first();
}
