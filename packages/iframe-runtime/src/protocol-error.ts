/**
 * `ProtocolError` typed union — canonical shape for every error the
 * renderer surfaces OUTWARD: to the host page via postMessage, to the
 * session via the `_ggui:contract-error` channel, and to the
 * in-iframe status DOM.
 *
 * The transport wiring around this union:
 *
 *   - `postMessage({type:'ggui:protocol-error', error})` for every
 *     boot-path failure; the `_ggui:contract-error` envelope on the
 *     live channel for session-bound failures.
 *   - `<McpAppIframe onError={(err: ProtocolError) => …}>` surfaces
 *     these to embedding apps.
 *
 * The union is the failure-mode axis of `WireConfig`'s contract:
 * named parties = renderer ↔ host; obligation = the renderer emits a
 * ProtocolError for every failure class; failure mode = exhaustive
 * on `kind`; observable = hosts can pattern-match `err.kind`.
 *
 * Extensibly-closed discipline: `kind: 'protocol'`'s `code` and the
 * `BootstrapFailureReason` union both accept `(string & {})` so
 * servers can introduce new codes without a client bump while IDE
 * autocomplete still lists the canonical set. Every OTHER
 * discriminator (`kind` itself, transport codes, auth codes, version
 * fields) is fully closed — drift there is a real shape change, not
 * a new code.
 */
import type { ContractErrorPayload } from '@ggui-ai/protocol';
import { ClientContractViolationError } from '@ggui-ai/wire';

// =============================================================================
// BootstrapFailureReason — extensibly-closed union of boot-path failures
// =============================================================================

/**
 * Closed-or-extensibly-closed union of bootstrap-failure reasons.
 *
 * Consolidates three sources:
 *
 *   1. **Parse-time failures** — every member of
 *      `BootstrapParseFailureReason` (`MISSING_TOOL_OUTPUT` /
 *      `MISSING_META_GGUI_BOOTSTRAP` / `MALFORMED_BOOTSTRAP` /
 *      `EXPIRED_BOOTSTRAP`). `MISSING_META_GGUI_BOOTSTRAP` and
 *      `BOOTSTRAP_META_MISSING` are synonyms — the latter is the
 *      on-wire name, the former the parse-internal name.
 *
 *   2. **Post-parse orchestration failures** — `UI_INITIALIZE_FAILED`
 *      / `WS_HANDSHAKE_FAILED`. Matches `RendererBootFailureReason`.
 *
 *   3. **Transport-observable failures** — `BUNDLE_FETCH_FAILED` /
 *      `CSP_VIOLATION` / `SESSION_NOT_FOUND` / `AUTH_REJECTED`. These
 *      fire before the renderer parse path runs, so they're authored
 *      here rather than inside `BootstrapParseFailureReason`.
 *
 * `(string & {})` tail keeps the union extensibly-closed — new wire
 * codes can land without a client bump, while IDE autocomplete
 * surfaces the canonical set.
 */
export type BootstrapFailureReason =
  // Parse-time failures.
  | 'MISSING_TOOL_OUTPUT'
  | 'MISSING_META_GGUI_BOOTSTRAP'
  | 'BOOTSTRAP_META_MISSING'
  | 'MALFORMED_BOOTSTRAP'
  | 'EXPIRED_BOOTSTRAP'
  // Post-parse orchestration.
  | 'UI_INITIALIZE_FAILED'
  | 'WS_HANDSHAKE_FAILED'
  | 'UPGRADE_REQUIRED'
  // Transport-observable.
  | 'BUNDLE_FETCH_FAILED'
  | 'CSP_VIOLATION'
  | 'SESSION_NOT_FOUND'
  | 'AUTH_REJECTED'
  // Extensibly-closed tail — future wire codes without a client bump.
  | (string & {});

// =============================================================================
// ProtocolError — canonical typed union
// =============================================================================

/**
 * Every error the renderer surfaces outward flows through this union.
 *
 * Discriminated on `kind`:
 *
 *   - `transport`  — WebSocket-level failure (DISCONNECTED / TIMEOUT).
 *                    Includes `retryable` so hosts can decide to reconnect
 *                    vs. give up.
 *   - `auth`       — session / token rejection pre-handshake.
 *                    `SESSION_NOT_FOUND` / `TOKEN_EXPIRED` /
 *                    `AUTH_REJECTED` — all terminal; hosts typically
 *                    escalate to a login flow.
 *   - `protocol`   — envelope / session-mismatch failures post-handshake.
 *                    Extensibly-closed on `code` because servers may
 *                    introduce new codes without a client bump.
 *                    `details` carries opaque structured context.
 *   - `contract`   — client-contract violation. Payload matches the
 *                    protocol-owned `ContractErrorPayload` so the
 *                    `_ggui:contract-error` envelope shape flows
 *                    unchanged through this variant.
 *   - `bootstrap`  — anything in {@link BootstrapFailureReason}.
 *   - `version`    — `UPGRADE_REQUIRED` path (handshake rejection).
 *                    `serverVersion` may be absent on the wire; callers
 *                    tolerate `undefined` for legacy servers.
 *   - `unknown`    — fallback for anything the renderer failed to
 *                    classify. Always carries the raw value so hosts
 *                    can at least log it.
 */
export type ProtocolError =
  | { readonly kind: 'transport'; readonly code: 'DISCONNECTED' | 'TIMEOUT'; readonly retryable: boolean; readonly message?: string }
  | { readonly kind: 'auth'; readonly code: 'SESSION_NOT_FOUND' | 'TOKEN_EXPIRED' | 'AUTH_REJECTED'; readonly message?: string }
  | {
      readonly kind: 'protocol';
      readonly code: 'SESSION_MISMATCH' | 'APP_MISMATCH' | 'MALFORMED_ENVELOPE' | (string & {});
      readonly message?: string;
      readonly details?: unknown;
    }
  | { readonly kind: 'contract'; readonly payload: ContractErrorPayload }
  | { readonly kind: 'bootstrap'; readonly reason: BootstrapFailureReason; readonly message: string }
  | { readonly kind: 'version'; readonly serverVersion?: string; readonly clientSupports: readonly string[]; readonly message?: string }
  | { readonly kind: 'unknown'; readonly raw: unknown };

// =============================================================================
// Emitter seam
// =============================================================================

/**
 * Caller sink for every `ProtocolError` the renderer classifies.
 *
 * This is OPTIONAL on every emitter site — the default is a tagged
 * `console.warn` so operators see the error in dev. The
 * `<McpAppIframe>` host wrapper bridges this to its `onError` prop;
 * session-bound variants are ALSO routed to the
 * `_ggui:contract-error` envelope over the WebSocket.
 *
 * Handlers MUST NOT throw — the emitter already fired the renderer's
 * own fallback path; a throwing handler would mask the real error.
 * Implementations that want to re-surface (e.g. console inspector)
 * should `queueMicrotask(() => …)` before any heavier work.
 */
export type ProtocolErrorEmitter = (err: ProtocolError) => void;

/**
 * Default emitter — operator-visible `console.warn` with a grep-
 * friendly tag. Identical posture to `GguiSession.surfaceContractViolation`'s
 * console.warn fallback. Callers override by injecting their own.
 */
export function defaultProtocolErrorEmitter(err: ProtocolError): void {
  // eslint-disable-next-line no-console -- dev-visible signal; mirrors
  // the pre-ProtocolError console.warn fallbacks across renderer paths.
  console.warn('[ggui:protocol-error]', err);
}

// =============================================================================
// Constructors — keep creation sites honest
// =============================================================================

/**
 * Map a client-side `ClientContractViolationError` (from
 * `@ggui-ai/wire`, fired when a pre-dispatch validator rejects an
 * outbound action, or when an inbound stream / props payload fails the
 * local validator) onto a `ProtocolError`.
 *
 * Client-side violations do NOT ride the server-emitted
 * `_ggui:contract-error` envelope — that shape (`ContractErrorPayload`)
 * is tool-failure-scoped and authored by the session-channel router.
 * A client-side violation is a DIFFERENT category: nothing reached the
 * tool. We surface it as `{kind: 'protocol'; code:
 * 'CLIENT_CONTRACT_VIOLATION'}` with structured `details` so hosts can
 * render the same summary that `console.warn` would have produced.
 *
 * Server-emitted `ContractErrorPayload` landing on
 * `_ggui:contract-error` rides the separate `{kind: 'contract'}`
 * variant — that path activates when the renderer observes the
 * reserved channel.
 */
export function fromClientContractViolation(
  err: ClientContractViolationError,
): ProtocolError {
  return {
    kind: 'protocol',
    code: 'CLIENT_CONTRACT_VIOLATION',
    message: err.message,
    details: {
      direction: err.direction,
      violations: err.violations,
    },
  };
}

/**
 * Wrap a server-emitted `ContractErrorPayload` (received over the
 * reserved `_ggui:contract-error` channel) as the 'contract' variant.
 * Trivial wrapper — exists so call sites produce the union via a
 * factory rather than an object literal (keeps emission uniform and
 * makes grep for creation sites exact).
 */
export function fromContractErrorPayload(
  payload: ContractErrorPayload,
): ProtocolError {
  return { kind: 'contract', payload };
}

/**
 * Build a `ProtocolError` of kind 'version' from the existing
 * `UpgradeRequiredError` class. Matches the `liftUpgradeRequiredFromError`
 * shape already plumbed through `subscribe.ts`.
 *
 * `UpgradeRequiredError.observedVersion` can be `string` (one version)
 * OR `readonly string[]` (the server advertised a set). We collapse
 * the array form to a comma-separated string to keep the 'version'
 * variant shape a single optional string — hosts render the observed
 * set uniformly.
 */
export function fromUpgradeRequired(
  err: {
    readonly observedVersion?: string | readonly string[];
    readonly acceptedVersions: readonly string[];
    readonly message: string;
  },
): ProtocolError {
  const serverVersion =
    err.observedVersion === undefined
      ? undefined
      : typeof err.observedVersion === 'string'
        ? err.observedVersion
        : err.observedVersion.join(', ');
  return {
    kind: 'version',
    ...(serverVersion !== undefined ? { serverVersion } : {}),
    clientSupports: err.acceptedVersions,
    message: err.message,
  };
}

/**
 * Build a `ProtocolError` of kind 'bootstrap' — closed-or-extensibly-
 * closed reason + operator-visible message.
 */
export function fromBootstrapFailure(
  reason: BootstrapFailureReason,
  message: string,
): ProtocolError {
  return { kind: 'bootstrap', reason, message };
}

/**
 * Fallback constructor — wraps any raw value we can't classify.
 * Keeps the emitter union total.
 */
export function fromUnknown(raw: unknown): ProtocolError {
  return { kind: 'unknown', raw };
}

/**
 * Build a `ProtocolError` of kind 'transport' — disconnection /
 * timeout paths. `retryable` differentiates the reconnection-eligible
 * `DISCONNECTED` from terminal `TIMEOUT` states; hosts pattern-match
 * on the flag.
 */
export function fromTransportFailure(
  code: 'DISCONNECTED' | 'TIMEOUT',
  retryable: boolean,
  message?: string,
): ProtocolError {
  return {
    kind: 'transport',
    code,
    retryable,
    ...(message !== undefined ? { message } : {}),
  };
}

/**
 * Build a `ProtocolError` of kind 'auth' — session / token rejection
 * pre-handshake.
 */
export function fromAuthFailure(
  code: 'SESSION_NOT_FOUND' | 'TOKEN_EXPIRED' | 'AUTH_REJECTED',
  message?: string,
): ProtocolError {
  return {
    kind: 'auth',
    code,
    ...(message !== undefined ? { message } : {}),
  };
}
