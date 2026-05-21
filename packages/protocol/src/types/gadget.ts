// packages/protocol/src/types/gadget.ts
//
// `GadgetHook` generic + the runtime status / error types that
// every browser-capability gadget hook in `@ggui-ai/gadgets`
// (and any third-party gadget hook) MUST satisfy.
//
// Capabilities differ from agent tools by direction and ownership:
//
//   - **agentCapabilities** (in `@ggui-ai/protocol`'s
//     `DataContract.agentCapabilities`) — RPC the contract REFERENCES.
//     The agent's MCP toolbox is the source of truth at dispatch time.
//     Catalog declaration is documentation.
//
//   - **clientCapabilities** (in `DataContract.clientCapabilities`) —
//     browser-capability gadget HOOKS the UI uses. The catalog says
//     "this UI calls `useMicrophone()`"; the value flows from browser →
//     UI → (optionally) into context/action payloads. The agent does
//     NOT invoke these from its side — there is no RPC. The UI hook
//     owns the lifecycle (prompting, status, value, error).
//
// The generic below pins what every gadget hook MUST return so the
// generated boilerplate, the LLM authoring contract, and the
// `@ggui-ai/gadgets` v1 package all agree on shape.

/**
 * Lifecycle states a {@link GadgetHook} reports through its
 * `status` field. Implementations MUST transition through these in a
 * predictable order; the UI generator's boilerplate may render
 * status-conditioned UI (e.g., a "Tap to start" CTA on `'idle'`, a
 * spinner on `'prompting'`, an error banner on `'denied' | 'error'`).
 *
 *  - `'idle'`       — hook mounted; no `start()` invoked yet.
 *  - `'prompting'`  — browser permission UI surfaced; awaiting user.
 *  - `'active'`     — gadget in flight (mic recording, location
 *                     stream open, camera frame loop running, …). For
 *                     one-shot gadgets (`navigator.share`), this
 *                     status may not be observed.
 *  - `'completed'`  — terminal success state. `value` populated.
 *  - `'denied'`     — terminal failure: user (or platform policy)
 *                     refused permission. `error.code === 'permission_denied'`.
 *  - `'error'`      — terminal failure: any other error.
 */
export type GadgetStatus =
  | 'idle'
  | 'prompting'
  | 'active'
  | 'completed'
  | 'denied'
  | 'error';

/**
 * Shape of {@link GadgetHook}'s `error` field when the hook is
 * in a terminal-failure status (`'denied'` / `'error'`).
 *
 * `code` is a closed set today and MAY be extended with `(string &
 * {})` in a future minor — consumers MUST handle unknown codes by
 * falling through to a default branch instead of throwing.
 *
 * `message` is author-readable; safe to surface in UI. Hooks SHOULD
 * NOT include raw stack traces here (those belong on hook-internal
 * logging, not on the public error surface).
 */
export interface GadgetError {
  /**
   * Canonical failure code. Implementations MUST set one of:
   *
   *  - `'permission_denied'` — user refused the browser-permission
   *    prompt OR a platform policy (iframe sandbox, HTTP origin,
   *    enterprise lockdown) blocks the gadget.
   *  - `'not_supported'`     — the host environment does not implement
   *    the underlying API (`!('mediaDevices' in navigator)`).
   *  - `'aborted'`           — the call was cancelled (e.g., the user
   *    closed a `navigator.share` sheet, the hook was unmounted
   *    mid-flight).
   *  - `'timeout'`           — the hook exceeded its configured
   *    deadline (e.g., geolocation watch never produced a fix).
   *  - `'unknown'`           — fallback for failures the hook can't
   *    classify; `message` carries the platform string.
   */
  readonly code: 'permission_denied' | 'not_supported' | 'aborted' | 'timeout' | 'unknown';
  /** Short, author-readable failure summary. Safe to surface in UI. */
  readonly message: string;
}

/**
 * The interface every browser-capability gadget hook in
 * `@ggui-ai/gadgets` (and any third-party gadget hook
 * registered on a `clientCapabilities` entry) MUST satisfy.
 *
 * Shape generic over:
 *
 *   - `TOutput`  — the value the gadget produces when active /
 *     completed (e.g., a `MediaRecorder`-backed `Blob` for
 *     `useMicrophone`, a `GeolocationPosition` for `useGeolocation`).
 *   - `TOptions` — the optional configuration passed to the hook (e.g.,
 *     `{ enableHighAccuracy: true }` for `useGeolocation`). Defaults to
 *     `void` for hooks that take no options.
 *
 * Return-shape contract:
 *
 *   - `value`   — `TOutput | undefined`. Undefined until the
 *     gadget transitions to `'active'` / `'completed'`.
 *   - `status`  — current lifecycle state; see {@link GadgetStatus}.
 *   - `error`   — present iff `status` is `'denied'` or `'error'`.
 *   - `start()` — invokes the gadget. MUST be idempotent if called
 *     while `status === 'active'`. Resolves with the produced value on
 *     success, `undefined` on failure (consumers read `error` for
 *     diagnostics).
 *   - `stop?`   — optional cancel/teardown for continuous gadgets
 *     (mic stream, geolocation watch). Absent on one-shot gadgets.
 *
 * Why declarative-only on the contract surface:
 *
 *   `DataContract.clientCapabilities.gadgets` is package-keyed —
 *   `Record<packageName, Record<exportName, { description?, usage? }>>`.
 *   Each export entry declares only WHICH export the UI uses (the
 *   export name is the inner map key; its grammar — `use`-prefixed
 *   hook vs PascalCase component — discriminates kind) and HOW the
 *   agent should describe it. It does NOT carry argument schemas,
 *   response schemas, or example payloads. Gadget values only become
 *   observable to the agent if the UI threads them into a
 *   `contextSpec` slot or an `actionSpec` payload —
 *   `clientCapabilities.gadgets` itself is an export-declaration
 *   catalog, not an RPC channel.
 */
export interface GadgetHook<TOutput, TOptions = void> {
  (options?: TOptions): {
    /**
     * Current gadget value. Undefined until the hook transitions to
     * `'active'` / `'completed'`. For continuous gadgets (mic stream)
     * this may update on every frame; for one-shot gadgets
     * (`navigator.share`) it settles once on success.
     */
    readonly value: TOutput | undefined;
    /** Lifecycle state; see {@link GadgetStatus}. */
    readonly status: GadgetStatus;
    /** Present iff `status` is `'denied'` or `'error'`. */
    readonly error?: GadgetError;
    /**
     * Invoke the gadget. Idempotent while `status === 'active'`.
     * Resolves to the produced value on success, `undefined` on
     * failure. Consumers read `error` for diagnostics.
     */
    readonly start: () => Promise<TOutput | undefined>;
    /**
     * Optional teardown. Present only on continuous gadgets (mic
     * stream, geolocation watch). Absent on one-shot gadgets
     * (`navigator.share`).
     */
    readonly stop?: () => void;
  };
}
