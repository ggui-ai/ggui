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
 * `dispatchTeardown()` for every step after the assertion. A host
 * that does not implement a directive MUST throw so it surfaces as a
 * test SKIP with a clear "host does not implement X" reason — never
 * a silent pass.
 *
 * ## Closed vocabulary
 *
 * Both step unions here are CLOSED — they carry exactly the directive
 * vocabulary the shipped fixture catalog authors, with the same field
 * names the fixture JSON uses. The runner validates every authored
 * directive against the JSON-authoring union in `./types` before
 * dispatch (unknown / malformed directives are fixture-authoring
 * errors, thrown loudly, never dispatched), so a host only ever
 * receives shape-valid steps of a known kind. Hosts therefore need
 * exactly two behaviors per directive: implement it, or throw
 * "not implemented" — never silently succeed.
 *
 * ## Relation to `./types`
 *
 * `./types` defines the JSON-authoring surface (discriminated on
 * `type`); this module defines the *runtime* surface the host
 * receives (discriminated on `kind`). The two are intentionally
 * parallel: same directives, same field names, different
 * discriminator key.
 */
import type { ActionSpecEntryDecl } from './types.js';

// =============================================================================
// Setup directives — runtime surface
// =============================================================================

/**
 * Setup directive the host dispatches BEFORE a fixture's input
 * envelope drives the system under test.
 *
 * Closed union — the runner validates fixture-authored directives
 * before dispatch, so only these five kinds ever reach a host. A host
 * that does not implement one of them MUST throw (e.g.
 * `Error('host does not implement renderer-url-override')`) so the
 * runner records the fixture as SKIPPED with that reason — never
 * silently succeed.
 */
export type SetupStep =
  | CreateGguiSessionSetup
  | RendererUrlOverrideSetup
  | ServerVersionOverrideSetup
  | UiInitializeResponseOverrideSetup
  | EmitEnvelopeSetup;

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

/** Runtime form of `RendererUrlOverrideStep` (see `./types`). */
export interface RendererUrlOverrideSetup {
  readonly kind: 'renderer-url-override';
  readonly sessionId: string;
  readonly url: string;
}

/** Runtime form of `ServerVersionOverrideStep` (see `./types`). */
export interface ServerVersionOverrideSetup {
  readonly kind: 'server-version-override';
  readonly sessionId: string;
  readonly advertiseVersion: string;
}

/** Runtime form of `UiInitializeResponseOverrideStep` (see `./types`). */
export interface UiInitializeResponseOverrideSetup {
  readonly kind: 'ui-initialize-response-override';
  readonly sessionId: string;
  readonly override: unknown;
}

/** Runtime form of `EmitEnvelopeStep` (see `./types`). */
export interface EmitEnvelopeSetup {
  readonly kind: 'emit-envelope';
  readonly channel: string;
  readonly payload: unknown;
}

// =============================================================================
// Teardown directives — runtime surface
// =============================================================================

/**
 * Closed-and-empty, mirroring `./types`' `TeardownStep`: no teardown
 * vocabulary exists in this kit version (renders decay via TTL), so
 * `dispatchTeardown` is never invoked today. The slot stays so future
 * cleanup directives land additively as union arms.
 */
export type TeardownStep = never;

// =============================================================================
// Host interface
// =============================================================================

/**
 * Adapter the implementation under test provides to the runner. An
 * implementation MAY:
 *
 *   - Implement every directive the kit authors (full coverage — the
 *     reference `@ggui-ai/mcp-server`-backed host target).
 *   - Implement a subset + throw on the rest (partial coverage — the
 *     kit records unimplemented directives as SKIPPED rather than
 *     failed).
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

  /**
   * Read one field off a live GguiSession — the introspection seam a
   * `session-state` expectation (`./types`' `SessionStateBehavior`)
   * grades against. The runner calls this AFTER the fixture's input
   * envelope has been dispatched and the observation window has
   * elapsed, then deep-equals the result against the fixture's
   * `expected`.
   *
   * Optional. A host that does not provide it makes every
   * `session-state` fixture SKIP — the kit cannot honestly grade a
   * stateful obligation it has no way to observe. Throwing signals
   * "this field is not exposed" and the runner records a SKIP with
   * the error's message; a throw is never treated as a pass or a
   * fail — a host that cannot read state cannot grade it.
   *
   * Honest-grade contract: the returned value MUST reflect the
   * GguiSession's true post-dispatch state. A host that fabricates a
   * passing value is cheating its own conformance audit — that is the
   * implementer's integrity to keep, exactly as with every other
   * host-mediated directive.
   */
  readSessionField?(sessionId: string, field: string): Promise<unknown>;
}
