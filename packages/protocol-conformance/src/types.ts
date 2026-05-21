/**
 * `@ggui-ai/protocol-conformance` fixture format — the authoring
 * contract third-party implementers compile against.
 *
 * This module is the public, wire-stable shape of every fixture case
 * under `./fixtures/**`. These declarations are the single source of
 * truth for the fixture-authoring vocabulary; other consumers in the
 * project re-export from this package rather than redefining it.
 *
 * ## Naming-load-bearing rule
 *
 * The shape of {@link TestCase}, {@link SetupStep},
 * {@link TeardownStep}, and {@link ExpectedBehavior} IS the public
 * API. Renaming a field breaks every third-party consumer of the
 * conformance kit. Treat this file the way `@ggui-ai/protocol`'s
 * type declarations get treated: additive changes only, extensibility
 * via `(string & {})` tails.
 *
 * ## Extensibly-closed unions
 *
 * Every discriminator in this module carries a `(string & {})` tail —
 * see SPEC §extensibility and `ContractErrorCode` in
 * `@ggui-ai/protocol`. Third-party conformance-host implementations
 * MAY introduce setup / teardown / expectation kinds the reference
 * kit doesn't recognize; the runner SHOULD skip such cases with a
 * warning rather than failing loudly, exactly the way
 * `ContractErrorCode`'s extensibility works.
 *
 * Only these discriminators are extensibly closed:
 *   - `SetupStep['type']`
 *   - `TeardownStep['type']`
 *   - `ExpectedBehavior['kind']`
 *   - `ExpectedObservabilityEvent['kind']`
 *   - `TransportConfig['kind']`
 *
 * Everything else — tool names, envelope field names, contract error
 * codes — is passed verbatim and the implementation under test owns
 * the recognition set.
 *
 * ## Why JSON + a loader, not pure TS
 *
 * Third-party consumers of the conformance kit are not all
 * TypeScript. The JSON format means a Python / Go / Rust implementer
 * can parse the same fixture catalog without shipping a TS compiler.
 * The loader exists so in-process TS consumers don't re-invent the
 * parser.
 *
 * ## Why inline authored vocabulary (not `import type` from `@ggui-ai/protocol`)
 *
 * The conformance kit is the AUTHORED artifact — its vocabulary is
 * pinned here, deliberately decoupled from the live source tree. A
 * drift check between these authored unions and the live protocol /
 * renderer types belongs in the kit's own meta-tests, NOT in this
 * file's import graph. If `@ggui-ai/protocol` adds a new
 * `ContractErrorCode` canonical member tomorrow, conformance kit
 * consumers MUST NOT be forced to recompile — their fixtures
 * continue to reference the value they authored, and the runner's
 * extensible `(string & {})` tail handles recognition. This mirrors
 * the protocol's own evolution discipline: authored shapes stay
 * additive.
 */

// =============================================================================
// Transport configuration
// =============================================================================

/**
 * Transport binding the kit uses to reach the implementation under
 * test. v1.0 ships WS-only — WebSocket is the canonical ggui
 * transport.
 *
 * The union is extensibly-closed (`(string & {})` tail) so post-v1.1
 * transports (stdio MCP, HTTP long-poll) can land without breaking
 * the kit's public API. The known arm is the full config object;
 * unknown arms are accepted as opaque records so third-party runners
 * can extend without a package bump.
 *
 * Pattern mirrored from `ContractErrorCode` in
 * `@ggui-ai/protocol/types/data-contract`.
 */
export type TransportConfig =
  | WebSocketTransportConfig
  | UnknownTransportConfig;

export interface WebSocketTransportConfig {
  readonly kind: 'ws';
  /** Fully-qualified WebSocket URL, e.g. `ws://localhost:3000/ws`. */
  readonly url: string;
  /** Auth carried on the upgrade request. See {@link AuthConfig}. */
  readonly auth: AuthConfig;
}

/**
 * Future-compat catch. Runners that receive a transport `kind` they
 * don't recognize MUST fail loudly — an unrecognized transport is a
 * configuration error, not a runtime extension point.
 */
export interface UnknownTransportConfig {
  readonly kind: string & {};
  readonly [field: string]: unknown;
}

/**
 * Authentication carried to the implementation under test. v1.0 names
 * two concrete shapes. Extensibility follows the transport pattern —
 * new auth shapes land as additional arms, not as a free-form record.
 */
export type AuthConfig =
  | { readonly kind: 'bearer'; readonly token: string }
  | { readonly kind: 'session-cookie'; readonly cookie: string };

// =============================================================================
// Setup / teardown directives
// =============================================================================

/**
 * Directive a conformance host interprets BEFORE driving a fixture's
 * `inputEnvelope`. The runner dispatches each step against the host's
 * injected `ConformanceHost` interface (see `./conformance-host`) —
 * this module authors the declarative intent; the host owns the
 * implementation.
 *
 * Discriminator is extensibly closed: unknown `type` values skip the
 * fixture with a warning rather than erroring. Third-party hosts MAY
 * extend the setup vocabulary without a kit version bump.
 */
export type SetupStep =
  | CreateSessionStep
  | RegisterToolStep
  | EmitEnvelopeStep
  | SeedChannelStep
  | UnknownSetupStep;

export interface CreateSessionStep {
  readonly type: 'create-session';
  /** Opaque session id the host allocates. Downstream steps + the
   *  fixture's `inputEnvelope` reference it by value. */
  readonly sessionId: string;
  /** Optional app (tenant) id the session scopes to. Defaults to the
   *  host's implementation-defined "default app". */
  readonly appId?: string;
}

export interface RegisterToolStep {
  readonly type: 'register-tool';
  readonly toolName: string;
  /** Handler identifier the host maps to a real implementation. The
   *  kit is authoring-only — it doesn't ship handler bodies. Known
   *  values the reference `@ggui-ai/mcp-server`-backed host supports:
   *
   *    - `'echo'`   — returns `{received: args}`.
   *    - `'throw'`  — rejects with `Error('tool_threw_for_fixture')`.
   *    - `'timeout'`— never resolves (host enforces its own timeout).
   *    - `'malformed-stream'` — returns `{wrong:'shape'}`.
   *
   *  Third-party hosts MAY recognize additional handlers; the kit
   *  records the string verbatim. */
  readonly handler: string;
}

export interface EmitEnvelopeStep {
  readonly type: 'emit-envelope';
  /** Reserved-channel or declared-channel name. */
  readonly channel: string;
  /** Raw envelope body. Host is responsible for wrapping in the wire
   *  format (sequence stamp, timestamp, etc.). */
  readonly payload: unknown;
}

export interface SeedChannelStep {
  readonly type: 'seed-channel';
  readonly sessionId: string;
  readonly channel: string;
  readonly value: unknown;
}

/**
 * Future-compat catch. Hosts that do not recognize the `type` SHOULD
 * skip the case with a warning.
 */
export interface UnknownSetupStep {
  readonly type: string & {};
  readonly [field: string]: unknown;
}

/**
 * Teardown directive — mirrors {@link SetupStep}'s vocabulary, scoped
 * to cleanup.
 */
export type TeardownStep =
  | CloseSessionStep
  | UnregisterToolStep
  | UnknownTeardownStep;

export interface CloseSessionStep {
  readonly type: 'close-session';
  readonly sessionId: string;
}

export interface UnregisterToolStep {
  readonly type: 'unregister-tool';
  readonly toolName: string;
}

export interface UnknownTeardownStep {
  readonly type: string & {};
  readonly [field: string]: unknown;
}

// =============================================================================
// Expected-behavior union
// =============================================================================

/**
 * What the test asserts after the input envelope drives the host.
 *
 * Discriminator is extensibly closed via `(string & {})`. Each arm
 * carries only the fields the assertion semantically requires — no
 * optional-everything-bags. Cross-cuts (e.g. every failure-path case
 * also expects a matching observability event) are authored as
 * {@link TestCase.expectedBehavior} of one kind PLUS
 * {@link TestCase.expectedObservability} alongside, not as nested
 * unions.
 */
export type ExpectedBehavior =
  | ContractErrorBehavior
  | StreamUpdateBehavior
  | ObservabilityBehavior
  | BootstrapFailureBehavior
  | BootstrapSuccessBehavior
  | VersionMismatchBehavior
  | PropsUpdateBehavior
  | NoOpBehavior
  | UnknownBehavior;

/**
 * Expect a `_ggui:contract-error` envelope with the given code + tool
 * + optional actionName + optional sourceAction.type. Matches the
 * renderer's {@link ProtocolError} kind `'contract'` variant AND the
 * server-wire `ContractErrorPayload` shape.
 */
export interface ContractErrorBehavior {
  readonly kind: 'contract-error';
  readonly code: ContractErrorCode;
  readonly toolName: string;
  readonly actionName?: string;
  readonly sourceAction?: 'wired-action' | 'refresh-stream' | (string & {});
  /**
   * Optional observability co-assertion. Most contract-error paths
   * also emit a `contract-error-emitted` observability event with the
   * same `code` + `toolName`. Authoring this here keeps the
   * cross-cut in one place.
   */
  readonly observability?: ExpectedObservabilityEvent;
}

/** Expect a stream-update on the named channel matching the given value
 *  shape (deep-equal, via the host's matcher). */
export interface StreamUpdateBehavior {
  readonly kind: 'stream-update';
  readonly channel: string;
  readonly value: unknown;
}

/** Expect a standalone observability event (no wired-action / refresh
 *  side-effect paired). Mostly used by happy-path rows + the
 *  `wired-tool-invoked` event. */
export interface ObservabilityBehavior {
  readonly kind: 'observability-event';
  readonly event: ExpectedObservabilityEvent;
}

/**
 * Expect a bootstrap-failure postMessage envelope + the renderer's
 * {@link ProtocolError} of kind `'bootstrap'` with the matching
 * reason. Post-wire paths (`BUNDLE_FETCH_FAILED`,
 * `BOOTSTRAP_META_MISSING`) are pre-WS — they surface via
 * `postMessage({type:'ggui:bootstrap-failed', …})` only, NOT on
 * the live channel.
 */
export interface BootstrapFailureBehavior {
  readonly kind: 'bootstrap-failure';
  readonly reason: BootstrapFailureReason;
  /** Optional substring the renderer's `message` field should contain.
   *  Keeps assertions resilient to message copy edits. */
  readonly messageContains?: string;
}

/**
 * Expect the renderer to reach the "ready to accept actions" state —
 * no bootstrap failure, no version rejection, the first stack item
 * rendered with `data-ggui-code-ready="true"` (or the host's
 * equivalent signal).
 */
export interface BootstrapSuccessBehavior {
  readonly kind: 'bootstrap-success';
  /** Optional: observability events the host MUST emit in order. */
  readonly observabilitySequence?: readonly ExpectedObservabilityEvent[];
}

/**
 * Expect a version-handshake rejection. Maps to the
 * `{type:'ggui:upgrade-required', server, client}` postMessage
 * envelope + the renderer's {@link ProtocolError} kind `'version'`.
 */
export interface VersionMismatchBehavior {
  readonly kind: 'version-mismatch';
  readonly serverVersion: string;
  readonly clientAccepts: readonly string[];
}

/**
 * Expect a `props_update` round-trip — hosts deliver new props via
 * channel 0, the iframe DOM reflects the update within `timeoutMs`.
 */
export interface PropsUpdateBehavior {
  readonly kind: 'props-update';
  readonly channel: string;
  /** Props values the host MUST deliver. */
  readonly props: Record<string, unknown>;
  /** DOM-level attribute / text evidence the update landed. */
  readonly evidence: {
    readonly selector: string;
    readonly attribute?: string;
    readonly expected: string;
  };
}

/**
 * No observable side-effect expected. Used for inputs the protocol
 * intentionally drops (malformed envelopes, unrecognized JSON-RPC
 * methods). The host SHOULD warn internally; the wire stays silent.
 */
export interface NoOpBehavior {
  readonly kind: 'no-op';
  /** Human-readable justification — why silence is the correct
   *  outcome. Surfaces in the reporter so operators can audit it. */
  readonly reason: string;
}

/** Future-compat catch. Runner skips with a warning. */
export interface UnknownBehavior {
  readonly kind: string & {};
  readonly [field: string]: unknown;
}

// =============================================================================
// Observability co-assertion
// =============================================================================

/**
 * Narrowed observability-event shape for fixture assertions. Parallel
 * to `@ggui-ai/iframe-runtime`'s `ObservabilityEvent` but with every field
 * optional-by-default so fixtures can assert "at least these values"
 * without over-specifying (e.g. `latencyMs` is nondeterministic).
 */
export interface ExpectedObservabilityEvent {
  readonly kind:
    | 'wired-tool-invoked'
    | 'contract-error-emitted'
    | 'schema-version-mismatch'
    | 'subscribe-failed'
    | (string & {});
  readonly toolName?: string;
  readonly actionName?: string;
  readonly code?: string;
}

// =============================================================================
// Test case
// =============================================================================

/**
 * One conformance-kit fixture. Authored as JSON under `./fixtures/**`,
 * consumed via the kit's loader, driven by either this package's
 * runner or third-party consumers of the JSON catalog.
 */
export interface TestCase {
  /**
   * Unique fixture name. MUST match the JSON filename without `.json`.
   * Reporter output uses this as the primary identifier.
   */
  readonly name: string;

  /** Human-readable description of what this fixture proves. */
  readonly description: string;

  /**
   * If non-null, the runner SKIPS this fixture and prints the reason.
   * Used for fixtures authored against a `ConformanceHost` directive
   * the implementation under test hasn't wired yet.
   */
  readonly skipReason: string | null;

  /**
   * Setup directives the host executes BEFORE the input envelope. May
   * be empty. See {@link SetupStep}.
   */
  readonly setup: readonly SetupStep[];

  /**
   * The envelope the runner feeds to the system under test. Opaque
   * shape — the runner passes it verbatim to the host's transport.
   *
   * Typically an object like
   * `{type: 'action', channel: 0, sessionId: 'test-s1', action: {…}}`
   * (channel 0 = wired-action dispatch) or
   * `{type: 'render', sessionId: 'test-s1', resource: {…}}` for
   * bootstrap-path fixtures.
   *
   * `unknown` rather than a typed union because the kit may drive
   * fixtures over multiple transport kinds post-v1.1 (stdio, HTTP
   * long-poll) and each transport's envelope shape is its own.
   */
  readonly inputEnvelope: unknown;

  /** What the runner asserts after the envelope is dispatched. */
  readonly expectedBehavior: ExpectedBehavior;

  /**
   * Optional observability assertion, independent of
   * {@link expectedBehavior}. When `expectedBehavior.kind ===
   * 'contract-error'` and `expectedBehavior.observability` is set,
   * this field SHOULD be omitted — the nested one is canonical.
   */
  readonly expectedObservability?: readonly ExpectedObservabilityEvent[];

  /** Cleanup directives the host executes AFTER the assertion. */
  readonly teardown: readonly TeardownStep[];
}

// =============================================================================
// Authored protocol vocabulary — decoupled copies
// =============================================================================

/**
 * Canonical contract-error codes. Mirrors `@ggui-ai/protocol`'s
 * `ContractErrorCode` at the time this kit version was authored. The
 * `(string & {})` tail lets fixtures reference codes introduced by
 * later protocol revisions without a kit bump — the runner's
 * recognition set is its own concern.
 *
 * Drift discipline: the kit ships a meta-test that walks
 * `@ggui-ai/protocol`'s `ContractErrorCode` union against this
 * declaration and warns when a new canonical member appears. The
 * runner's behaviour on unknown codes (skip with warning) is
 * additive-safe: adding a code here is a kit minor; removing one is
 * a major.
 */
export type ContractErrorCode =
  | 'TOOL_NOT_FOUND'
  | 'TOOL_THREW'
  | 'TOOL_TIMEOUT'
  | 'SCHEMA_VIOLATION'
  | 'SCHEMA_MISMATCH_ERROR'
  | 'SESSION_NOT_FOUND'
  | 'AUTH_REJECTED'
  | (string & {});

/**
 * Boot-path failure reasons. Mirrors `@ggui-ai/iframe-runtime`'s
 * `BootstrapFailureReason` — combines parse-time, post-parse
 * orchestration, and pre-WS transport-observable failures. Authored
 * copy for the same drift-decoupling reason as
 * {@link ContractErrorCode}.
 */
export type BootstrapFailureReason =
  | 'MISSING_TOOL_OUTPUT'
  | 'MISSING_META_GGUI_BOOTSTRAP'
  | 'BOOTSTRAP_META_MISSING'
  | 'MALFORMED_BOOTSTRAP'
  | 'EXPIRED_BOOTSTRAP'
  | 'UI_INITIALIZE_FAILED'
  | 'WS_HANDSHAKE_FAILED'
  | 'UPGRADE_REQUIRED'
  | 'BUNDLE_FETCH_FAILED'
  | 'CSP_VIOLATION'
  | 'SESSION_NOT_FOUND'
  | 'AUTH_REJECTED'
  | (string & {});

/**
 * Narrow ProtocolError shape mirroring `@ggui-ai/iframe-runtime`'s public
 * union at the time this kit version was authored. Fixture authors
 * do NOT typically reference this type — it's exported so conformance
 * runners can assert on the typed shape the host under test emits.
 * Every member mirrors the renderer's canonical arm; the kit freezes
 * the shape at this kit version and evolves additively per the
 * drift-decoupling posture above.
 */
export type ProtocolError =
  | {
      readonly kind: 'transport';
      readonly code: 'DISCONNECTED' | 'TIMEOUT';
      readonly retryable: boolean;
      readonly message?: string;
    }
  | {
      readonly kind: 'auth';
      readonly code: 'SESSION_NOT_FOUND' | 'TOKEN_EXPIRED' | 'AUTH_REJECTED';
      readonly message?: string;
    }
  | {
      readonly kind: 'protocol';
      readonly code:
        | 'SESSION_MISMATCH'
        | 'APP_MISMATCH'
        | 'MALFORMED_ENVELOPE'
        | (string & {});
      readonly message?: string;
      readonly details?: unknown;
    }
  | {
      readonly kind: 'contract';
      readonly payload: {
        readonly toolName: string;
        readonly actionName?: string;
        readonly sourceAction?: {
          readonly type: 'wired-action' | 'refresh-stream' | (string & {});
          readonly dispatchedAt: string;
        };
        readonly error: {
          readonly code: ContractErrorCode;
          readonly message: string;
          readonly causedBy?: string;
        };
        readonly timestamp: string;
        readonly schemaVersion?: string;
      };
    }
  | {
      readonly kind: 'bootstrap';
      readonly reason: BootstrapFailureReason;
      readonly message: string;
    }
  | {
      readonly kind: 'version';
      readonly serverVersion?: string;
      readonly clientSupports: readonly string[];
      readonly message?: string;
    }
  | { readonly kind: 'unknown'; readonly raw: unknown };
