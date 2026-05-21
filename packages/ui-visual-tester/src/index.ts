/**
 * Public surface for `@ggui-ai/ui-visual-tester`.
 *
 * One function — {@link validateContractBehavior} — drives a generated
 * component through every entry in its `actionSpec`, observes whether
 * each click actually does something (mutates DOM that is bound to
 * `contextSpec` state OR dispatches an action), and reports per-action
 * failures.
 *
 * Closes the gap structural validators (zod schema, wire-preservation,
 * compile/lint) miss: a component whose buttons render correctly but
 * are wired to no-op handlers. The motivating regression: synthesized
 * Counter contracts that wired increment/decrement to `useAction(...)`
 * (one-shot dispatch to agent) instead of local state, so the visible
 * `count` never updated.
 *
 * Playwright is an OPTIONAL peer dep. Callers must pass the
 * `playwright-core` module (or compatible) via factory dep injection:
 *
 *   import { chromium } from 'playwright-core';
 *   const result = await validateContractBehavior({
 *     componentCode, contract,
 *     playwright: { chromium },
 *   });
 *
 * If `playwright` is omitted, the validator throws a clear error
 * pointing the operator at the advanced-pod opt-in. This keeps the
 * default OSS install free of the Chromium binary (~300MB).
 *
 * Classification gate:
 *
 *   For each `actionSpec[name]`:
 *     - If the action's handler mutates a `contextSpec` slot (detected by
 *       `nextStep` ABSENT on the entry — the action is "context-bound"),
 *       require a DOM change as the success signal.
 *     - If the action's handler dispatches to the agent (detected by
 *       `nextStep` PRESENT on the entry — the action is "agent-bound"),
 *       require a `dispatch(...)` call as the success signal.
 *
 *   When neither holds (label-only entry, no `nextStep`), accept EITHER
 *   signal — DOM mutation OR dispatch — as success. This is the safest
 *   default for actions whose authoring intent is ambiguous from the
 *   contract alone.
 *
 *   This aligns with the actions-vs-context principle: `nextStep`
 *   declares the agent-route intent at authoring time; without it,
 *   the action is observation-only or local-only.
 *
 * Behavior
 * --------
 *
 * For each entry in `contract.actionSpec`:
 *
 *   1. Render the component in a real Chromium tab via Playwright.
 *   2. Find a button matching the action's `label` (aria-label first,
 *      then visible-text contains, case-insensitive).
 *   3. Snapshot the current DOM state.
 *   4. Click the button.
 *   5. Wait up to `timeoutMs` for the required signal (per the gate
 *      above) to fire.
 *   6. Classify: ok / action-no-effect / action-not-rendered /
 *      render-failed.
 *
 * Empty `actionSpec` returns `{ ok: true, failures: [] }` (not
 * applicable — nothing to test).
 */
import type { DataContract } from '@ggui-ai/protocol';
import type {
  Browser as PlaywrightBrowser,
  BrowserContext as PlaywrightBrowserContext,
  Page as PlaywrightPage,
  LaunchOptions as PlaywrightLaunchOptions,
} from 'playwright-core';

/**
 * Minimal Playwright `chromium` surface the validator depends on.
 *
 * The full `playwright-core` shape is intentionally NOT imported here
 * — we only require `chromium.launch(...)`. Callers may pass any
 * module satisfying this shape (real Playwright, a stub for tests,
 * `playwright` instead of `playwright-core`).
 */
export interface PlaywrightModule {
  readonly chromium: {
    launch(options?: PlaywrightLaunchOptions): Promise<PlaywrightBrowser>;
  };
}

/** Re-exported for callers building their own driver. */
export type {
  PlaywrightBrowser,
  PlaywrightBrowserContext,
  PlaywrightPage,
};

export interface ValidateContractBehaviorInput {
  readonly componentCode: string;
  readonly contract: DataContract;
  readonly timeoutMs?: number;
  /**
   * Playwright module. Pass `{ chromium }` from `playwright-core` or
   * `playwright`. Required — when absent the validator throws with a
   * pointer to the advanced-pod opt-in.
   */
  readonly playwright: PlaywrightModule;
}

export type BehaviorFailureKind =
  | 'action-no-effect'
  | 'action-not-rendered'
  | 'render-failed'
  | 'timeout';

export interface BehaviorFailure {
  readonly kind: BehaviorFailureKind;
  readonly actionName?: string;
  readonly diagnostic: string;
}

export interface ValidateContractBehaviorResult {
  readonly ok: boolean;
  readonly failures: readonly BehaviorFailure[];
}

export { validateContractBehavior } from './validate.js';

/**
 * Error thrown when {@link validateContractBehavior} is called without
 * a `playwright` module. Surfaced verbatim so operator scripts can
 * branch on it.
 */
export class PlaywrightNotAvailableError extends Error {
  override readonly name = 'PlaywrightNotAvailableError';
  constructor() {
    super(
      '@ggui-ai/ui-visual-tester: a Playwright module is required but was not passed. ' +
        'Behavioral validation needs a Playwright module + Chromium binary. ' +
        'Pass `{ chromium }` from `playwright-core` via the `playwright` field on the input. ' +
        'Playwright is an optional peer dependency — install it only if you run behavioral validation.',
    );
  }
}
