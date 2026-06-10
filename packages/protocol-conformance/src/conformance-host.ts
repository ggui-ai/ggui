/**
 * `ConformanceHost` — the seam between the kit's authored fixtures
 * and the implementation under test.
 *
 * Most fixtures declare `setup` / `teardown` directives (see
 * {@link SetupStep} / {@link TeardownStep} in `./types`) that the host
 * dispatches against its live server. v1.0 of the kit does NOT
 * require implementations to ship a host — fixtures that need setup
 * directives skip cleanly when `runConformance()` is called without
 * a `host`.
 *
 * When a host IS provided, the runner calls `dispatchSetup()` for
 * every step before driving the fixture's `inputEnvelope`, then
 * `dispatchTeardown()` for every step after the assertion. Unknown
 * `kind` values MUST throw so unimplemented directives surface as a
 * test SKIP with a clear "host does not implement X" reason — never
 * a silent pass.
 *
 * ## Extensibly-closed
 *
 * The concrete step vocabulary below mirrors `./types`' vocabulary
 * but is re-exported here as a host-facing narrower form:
 *   - Every arm carries the full semantic payload (not the JSON-
 *     loader's `unknown`-fields view).
 *   - The tail `(Record<string, unknown> & { readonly kind: string & {} })`
 *     catches fixture-JSON directives the host hasn't wired — the host
 *     returns by throwing, the runner maps it to a skip.
 *
 * Third-party hosts MAY extend either union with additional arms by
 * augmenting the declaration in their own module. v1.0 of the kit
 * does not require exhaustive coverage — it requires *honest*
 * coverage: either implement the directive OR throw, never silently
 * succeed on an unknown kind.
 *
 * ## Relation to `./types`
 *
 * `./types` defines the JSON-authoring surface: every directive has
 * optional-by-default fields so JSON authors don't have to think
 * about shape. This module defines the *runtime* surface: once the
 * loader has validated a directive, the host receives a narrowed
 * form. The two are intentionally parallel but not identical — JSON
 * loaders accept what the author wrote; hosts receive what the
 * runner confirmed is shape-valid.
 */
import type { ActionSpecEntryDecl } from './types.js';

// =============================================================================
// Setup directives — runtime surface
// =============================================================================

/**
 * Setup directive the host dispatches BEFORE a fixture's input
 * envelope drives the system under test.
 *
 * Extensibly-closed: a host that receives a `kind` it doesn't
 * recognize MUST throw `Error('conformance-host: unknown setup kind: <kind>')`
 * so the runner records the fixture as SKIPPED with that reason —
 * never silently succeed.
 */
export type SetupStep =
  | CreateGguiSessionSetup
  | EmitEnvelopeSetup
  | RendererUrlOverrideSetup
  | UiInitializeResponseOverrideSetup
  | ServerVersionOverrideSetup
  | UnknownSetupStep;

export interface CreateGguiSessionSetup {
  readonly kind: 'create-session';
  readonly sessionId: string;
  readonly appId?: string;
  /**
   * Optional actionSpec declared on the GguiSession at creation. See
   * `CreateGguiSessionStep.actionSpec` in `./types` — hosts that
   * receive the field MUST install it as the render's declared-action
   * contract before the fixture's input envelope is dispatched.
   */
  readonly actionSpec?: Readonly<Record<string, ActionSpecEntryDecl>>;
}

export interface EmitEnvelopeSetup {
  readonly kind: 'emit-envelope';
  readonly channel: string;
  readonly payload: unknown;
}

export interface RendererUrlOverrideSetup {
  readonly kind: 'renderer-url-override';
  readonly url: string;
}

export interface UiInitializeResponseOverrideSetup {
  readonly kind: 'ui-initialize-response-override';
  readonly response: unknown;
}

export interface ServerVersionOverrideSetup {
  readonly kind: 'server-version-override';
  readonly version: string;
}

/**
 * Future-compat catch. A host that reaches this arm MUST throw rather
 * than return silently — the runner interprets the throw as a skip
 * with the error message as the reason.
 */
export type UnknownSetupStep = Record<string, unknown> & {
  readonly kind: string & {};
};

// =============================================================================
// Teardown directives — runtime surface
// =============================================================================

export type TeardownStep = UnknownTeardownStep;

export type UnknownTeardownStep = Record<string, unknown> & {
  readonly kind: string & {};
};

// =============================================================================
// Host interface
// =============================================================================

/**
 * Adapter the implementation under test provides to the runner. An
 * implementation MAY:
 *
 *   - Implement every directive the kit authors (full coverage — the
 *     reference `@ggui-ai/mcp-server`-backed host target).
 *   - Implement a subset + throw on unknown kinds (partial coverage
 *     — the kit records unimplemented directives as SKIPPED rather
 *     than failed).
 *   - Not be provided at all (the runner drops every fixture with a
 *     non-empty `setup` or `teardown` as skip-with-reason).
 *
 * The runner invokes `dispatchSetup()` once per setup step, in order,
 * before driving the fixture's `inputEnvelope`; invokes
 * `dispatchTeardown()` once per teardown step, in order, after the
 * assertion (pass or fail). Teardown runs unconditionally — the host
 * is responsible for its own idempotency under partial setup.
 *
 * Throwing from either dispatcher is the signal for "I don't
 * implement this directive" — the runner records the fixture as
 * SKIPPED with the error's `message` as the skip reason. A host MUST
 * NOT treat a fixture as passed after throwing from setup — the
 * runner does not call the assertion if setup throws.
 */
export interface ConformanceHost {
  /**
   * Dispatch one setup step. Throws `Error` to signal "directive not
   * implemented" — the runner maps this to a skip with the error's
   * message as the skip reason. Throws are NOT treated as failures.
   */
  dispatchSetup(step: SetupStep): Promise<void>;

  /**
   * Dispatch one teardown step. Same contract as `dispatchSetup`.
   * Teardown errors do NOT flip a passed fixture to failed — they
   * emit a warning-level event to the reporter so operators can see
   * the cleanup gap without corrupting the pass/fail tally.
   */
  dispatchTeardown(step: TeardownStep): Promise<void>;
}
