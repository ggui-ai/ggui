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
 * type declarations get treated: additive changes only; where a
 * union is extensible, it is via `(string & {})` tails (see the next
 * section for which unions those are).
 *
 * ## Closed vs extensibly-closed unions
 *
 * Two different evolution postures coexist in this module:
 *
 *   - `SetupStep['type']` is **closed** — exactly the directive
 *     vocabulary the shipped fixture catalog authors. An unknown or
 *     malformed directive is a fixture-authoring error the runner
 *     rejects loudly (it can never be a legitimate runtime extension
 *     point, because the catalog and the vocabulary ship together).
 *     New directives land as new union arms in a kit version bump.
 *     `TeardownStep` is the same posture with a currently-empty
 *     vocabulary.
 *   - `ExpectedBehavior['kind']` and `TransportConfig['kind']` carry a
 *     `(string & {})` tail — see SPEC §extensibility and
 *     `ContractErrorCode` in `@ggui-ai/protocol`. Runners that
 *     receive a behavior kind they don't recognize SHOULD skip with a
 *     warning; an unrecognized transport kind is a configuration
 *     error.
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
 * Discriminator is CLOSED: exactly the directive vocabulary the
 * shipped fixture catalog authors. The runner validates every step
 * against this union before dispatching and throws a descriptive
 * fixture-authoring error on an unknown or malformed directive — a
 * typo'd `type` can never silently skip. Hosts that don't implement
 * a (valid) directive signal it by throwing from `dispatchSetup`,
 * which the runner records as a SKIP.
 */
export type SetupStep =
  | CreateGguiSessionStep
  | RendererUrlOverrideStep
  | ServerVersionOverrideStep
  | UiInitializeResponseOverrideStep
  | EmitEnvelopeStep;

/**
 * Declared-action entry for {@link CreateGguiSessionStep.actionSpec}.
 * The behavioral fixtures exercise the name-membership half of the
 * action contract — an empty entry declares a void-payload action.
 * `schema` is authoring-reserved for future payload-validation
 * fixtures; hosts MAY ignore it today.
 */
export interface ActionSpecEntryDecl {
  readonly schema?: unknown;
}

export interface CreateGguiSessionStep {
  readonly type: 'create-session';
  /** Opaque render id the host allocates. Downstream steps + the
   *  fixture's `inputEnvelope` reference it by value. */
  readonly sessionId: string;
  /** Optional app (tenant) id the render scopes to. Defaults to the
   *  host's implementation-defined "default app". */
  readonly appId?: string;
  /**
   * Optional actionSpec declared on the GguiSession at creation —
   * mirrors how a real ggui server derives the declared-action set
   * from the render's data contract (actions are part of the render's
   * identity, not separately registered). Servers MUST reject
   * `data:submit` envelopes naming actions absent from this record
   * with an `error` frame, code `CONTRACT_VIOLATION`. Omitting the
   * field declares no contract — all actions are accepted.
   */
  readonly actionSpec?: Readonly<Record<string, ActionSpecEntryDecl>>;
}

/**
 * Point the render's bootstrap at a renderer-bundle URL the host
 * controls — typically an unreachable one, to drive the
 * `BUNDLE_FETCH_FAILED` bootstrap-failure path. A browser-host (Path-B)
 * concern: WS-only hosts throw on it and the fixture skips.
 */
export interface RendererUrlOverrideStep {
  readonly type: 'renderer-url-override';
  /** GguiSession the override scopes to (a prior `create-session`). */
  readonly sessionId: string;
  /** Renderer-bundle URL the host substitutes for the real one. */
  readonly url: string;
}

/**
 * Advertise a server schema version other than the implementation's
 * real one — drives the version-handshake rejection path
 * (`UPGRADE_REQUIRED`).
 */
export interface ServerVersionOverrideStep {
  readonly type: 'server-version-override';
  /** GguiSession the override scopes to (a prior `create-session`). */
  readonly sessionId: string;
  /** Schema version the server advertises on the wire for this render. */
  readonly advertiseVersion: string;
}

/**
 * Substitute the MCP Apps `ui/initialize` response the host returns to
 * the iframe — drives bootstrap-failure paths like
 * `BOOTSTRAP_META_MISSING`. A browser-host (Path-B) concern: WS-only
 * hosts throw on it and the fixture skips.
 */
export interface UiInitializeResponseOverrideStep {
  readonly type: 'ui-initialize-response-override';
  /** GguiSession the override scopes to (a prior `create-session`). */
  readonly sessionId: string;
  /** Response body the host returns from `ui/initialize` verbatim. */
  readonly override: unknown;
}

export interface EmitEnvelopeStep {
  readonly type: 'emit-envelope';
  /** Reserved-channel or declared-channel name. */
  readonly channel: string;
  /** Raw envelope body. Host is responsible for wrapping in the wire
   *  format (sequence stamp, timestamp, etc.). */
  readonly payload: unknown;
}

/**
 * Teardown directive — mirrors {@link SetupStep}'s closed posture,
 * scoped to cleanup. The vocabulary is EMPTY in this kit version: no
 * fixture authors a teardown directive (renders decay via TTL), so
 * the union has no members and the runner rejects any authored
 * teardown step as a fixture-authoring error. Future cleanup
 * directives land additively as union arms.
 */
export type TeardownStep = never;

// =============================================================================
// Expected-behavior union
// =============================================================================

/**
 * What the test asserts after the input envelope drives the host.
 *
 * Discriminator is extensibly closed via `(string & {})`. Each arm
 * carries only the fields the assertion semantically requires — no
 * optional-everything-bags.
 */
export type ExpectedBehavior =
  | ActionAckBehavior
  | ErrorFrameBehavior
  | StreamUpdateBehavior
  | BootstrapFailureBehavior
  | BootstrapSuccessBehavior
  | VersionMismatchBehavior
  | PropsUpdateBehavior
  | SessionStateBehavior
  | NoOpBehavior
  | UnknownBehavior;

/**
 * Expect the action's `ack` frame to carry a numeric
 * `payload.sequence` — the monotonic event sequence the server
 * assigned when it appended the action to the GguiSession's consume
 * buffer. The ack-carries-sequence contract is the wire-observable
 * proof the event persisted; the retrieval half (the agent draining
 * the buffer via `ggui_consume`) is an MCP tool call outside this WS
 * kit's observation window.
 */
export interface ActionAckBehavior {
  readonly kind: 'action-ack';
  /**
   * `requestId` the fixture's `inputEnvelope` stamps on the action
   * frame. The matcher requires the ack to echo it — distinguishing
   * the action's ack from the ack the runner's own subscribe frame
   * produces.
   */
  readonly requestId: string;
}

/**
 * Expect an `error` frame whose `payload.code` matches. Generic
 * error-frame vocabulary: `version-mismatch`'s `UPGRADE_REQUIRED`
 * match is the same read narrowed to one code, and future rejection
 * fixtures (`SESSION_NOT_FOUND`, `APP_MISMATCH`, …) author this arm
 * with their expected code.
 */
export interface ErrorFrameBehavior {
  readonly kind: 'error-frame';
  /** Expected `payload.code` on the error frame. */
  readonly code: string;
  /** Optional `requestId` the error frame must echo — pins the error
   *  to the fixture's own dispatched frame rather than any error the
   *  observation window happens to catch. */
  readonly requestId?: string;
}

/**
 * Expect a canonical channel-3 delivery frame (SPEC §12.2):
 * `{type: 'data', payload: StreamEnvelope}` whose envelope names the
 * declared `channel` and whose `payload.payload` body deep-equals the
 * declared `value`. The `StreamEnvelope` shape is defined by
 * `@ggui-ai/protocol` (`types/live-channel`). Note `{type: 'stream'}`
 * is a different frame — agent text-chunk streaming — and does NOT
 * satisfy this expectation.
 */
export interface StreamUpdateBehavior {
  readonly kind: 'stream-update';
  readonly channel: string;
  readonly value: unknown;
  /**
   * How {@link value} is compared against the observed envelope's
   * `payload` body.
   *
   *   - `'exact'` (default) — deep-equal. The observed body MUST have
   *     exactly the declared keys, no more.
   *   - `'subset'` — every key declared in {@link value} MUST be
   *     present and matching in the observed body; extra observed keys
   *     are ignored. Subset semantics relax object key sets only —
   *     primitives and arrays still compare exact (an array with a
   *     missing element is a different array, not a subset).
   *
   * Use `'subset'` when the real payload carries non-deterministic
   * fields the fixture cannot pin (generated ids, timestamps). Pinning
   * only the deterministic keys keeps the assertion honest without
   * wrongly rejecting a correct server over a random id.
   */
  readonly valueMatch?: 'exact' | 'subset';
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
 * no bootstrap failure, no version rejection, the render reaching
 * `data-ggui-code-ready="true"` (or the host's
 * equivalent signal).
 */
export interface BootstrapSuccessBehavior {
  readonly kind: 'bootstrap-success';
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
 * Expect a render-state mutation — the input message produced no wire
 * response, but it MUST have changed observable GguiSession state.
 *
 * This is the kit's THIRD grading mechanism, alongside the Path-A WS
 * fixtures (wire-observable) and the pure-function catalogs
 * (deterministic validation): a *stateful* obligation. A
 * Client→Server message like `host_context_observed` has no
 * synchronous response envelope — its whole contract is the
 * persistence onto the GguiSession. Asserting `no-op` (wire silence)
 * would certify a server that drops the message entirely, so the
 * honest grade reads the field back.
 *
 * The runner resolves this AFTER the observation window via
 * {@link ConformanceHost.readSessionField} — it asks the host for the
 * field's post-dispatch value and deep-equals it against
 * {@link expected} (the same exact deep-equal the frame matchers
 * use). A host that does not provide `readSessionField` makes the
 * fixture SKIP (the kit cannot observe a mutation it has no
 * introspection seam for) — never a silent pass. `matchBehavior`
 * returns `unmatchable-on-ws` for this kind: frames cannot prove
 * state.
 */
export interface SessionStateBehavior {
  readonly kind: 'session-state';
  /**
   * The GguiSession field whose post-dispatch value the kit asserts
   * (e.g. `hostContext`). Passed verbatim to
   * {@link ConformanceHost.readSessionField}; the host owns the
   * field-name recognition set.
   */
  readonly field: string;
  /**
   * The value the field MUST hold after the input message has been
   * processed by the implementation under test. Compared with exact
   * deep equality.
   */
  readonly expected: unknown;
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
   * Typically a live-channel action message like
   * `{type: 'action', requestId, payload: {sessionId, type:
   * 'data:submit', payload: {action, data}}}` or
   * `{type: 'render', sessionId: 'test-r1', resource: {…}}` for
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
   * Cleanup directives the host executes AFTER the assertion.
   * Optional — no current fixture needs teardown (renders decay via
   * TTL). The slot stays so future cleanup directives land additively.
   */
  readonly teardown?: readonly TeardownStep[];
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
