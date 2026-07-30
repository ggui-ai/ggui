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
    .or(frame.getByRole('switch', { name, checked: true }))
    .or(frame.getByRole('button', { name, pressed: true }));

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

/**
 * True when the todo's text (or a near ancestor) is struck through. Agents
 * sometimes emit a styled div-with-SVG checkbox — no role, no aria state, no
 * "✓" text node — and mark completion ONLY via `line-through`. No ARIA/text
 * locator can see that (the 2026-07-30 nightly capstone timed out with a
 * fully-working checked UI on screen for exactly this reason).
 */
async function todoTextStruckThrough(frame: FrameLocator, name: RegExp): Promise<boolean> {
  return frame
    .getByText(name)
    .first()
    .evaluate(
      (el) => {
        let node: Element | null = el;
        for (let depth = 0; node !== null && depth < 4; depth += 1) {
          if (getComputedStyle(node).textDecorationLine.includes('line-through')) return true;
          node = node.parentElement;
        }
        return false;
      },
      undefined,
      { timeout: 1_000 },
    )
    // Absent text / mid-remount frame is a normal transient while polling.
    .catch(() => false);
}

/**
 * Wait until the todo named `name` visibly reads as completed, whichever way
 * the agent chose to express it: races {@link findTodoCheckedIndicator}
 * (ARIA roles / :checked / completion text) against a computed-style poll for
 * strikethrough. Use this instead of a bare visibility wait on
 * `findTodoCheckedIndicator` wherever a styled-div checkbox must count.
 */
export async function waitForTodoCheckedIndicator(
  frame: FrameLocator,
  name: RegExp,
  timeout: number,
): Promise<void> {
  const deadline = Date.now() + timeout;
  const locatorLeg = findTodoCheckedIndicator(frame, name).waitFor({
    state: 'visible',
    timeout,
  });
  const styleLeg = (async (): Promise<void> => {
    for (;;) {
      if (await todoTextStruckThrough(frame, name)) return;
      if (Date.now() >= deadline) {
        throw new Error(`no line-through on "${name.source}" within ${timeout}ms`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  })();
  try {
    await Promise.any([locatorLeg, styleLeg]);
  } catch (err) {
    const errors = err instanceof AggregateError ? err.errors : [err];
    throw new Error(
      `todo "${name.source}" never showed a completed indicator — both legs failed: ` +
        errors.map((e) => (e instanceof Error ? e.message : String(e))).join(' | '),
    );
  }
}
