/**
 * Central envelope builders — single stamp point for `schemaVersion`
 * across every producer path.
 *
 * **Why centralize.** The `schemaVersion` forward-compat stamp is
 * emitted from many producer sites (wire helper, React-SDK emit
 * paths, OSS in-memory stream buffer, renderChannel contract-error
 * router, hosted server paths). Spreading stamp logic across N sites
 * causes drift — producers silently skip the stamp. These builders
 * remove the drift surface by giving every producer a single function
 * to call; the default stamp happens inside the builder.
 *
 * **Override semantics.** Each builder accepts `schemaVersion` in the
 * input object:
 *
 *   - **Key omitted** → the builder stamps {@link PROTOCOL_SCHEMA_VERSION}.
 *   - **Explicit string** → used as-is (cross-version test scenarios,
 *     replay fidelity when forwarding an already-stamped envelope).
 *   - **Explicit `undefined`** (`makeXxx({ schemaVersion: undefined,
 *     ... })`) → the builder OMITS the field entirely (no
 *     `schemaVersion` key on the returned envelope). This is a
 *     test-only pattern used by consumer-side tests that assert
 *     behavior when the field is absent on the wire. Production
 *     producers MUST NOT pass `undefined` explicitly.
 *
 * Key-present-vs-absent is distinguished via the `in` operator —
 * `'schemaVersion' in parts` is `true` iff the caller wrote the key,
 * even as `undefined`. The builders rely on that distinction so the
 * test-only omit path does not require a separate escape-hatch flag.
 *
 * **Exactly which key is set** matters. The builder omits `undefined`
 * optional fields entirely (it does not emit `{key: undefined}`) so
 * that `JSON.stringify` produces the same bytes as the old manual
 * `if (x !== undefined) envelope.x = x` pattern — byte-equivalence
 * with every pre-refactor stamp site is a load-bearing claim of the
 * centralization.
 *
 * **Scope.** These builders stamp and shape; they do NOT validate.
 * Validators live in `@ggui-ai/protocol/validation/*`. The division
 * is deliberate: stamping is part of the wire-shape contract (a
 * producer obligation), validation is part of the behavior contract
 * (an observable-violation obligation). Keeping them separate keeps
 * each module's surface narrow.
 *
 * @see PROTOCOL_SCHEMA_VERSION on `@ggui-ai/protocol`
 */
import type { ActionEnvelope, EventType } from '../types/events.js';
import type { ErrorPayload, StreamEnvelope } from '../types/live-channel.js';
import type {
  ContractErrorCode,
  ContractErrorPayload,
  JsonValue,
  StreamChannelMode,
} from '../types/data-contract.js';
import { PROTOCOL_SCHEMA_VERSION } from '../version.js';

/** Input type for {@link makeActionEnvelope}. */
export interface MakeActionEnvelopeInput<TPayload = JsonValue> {
  readonly renderId: string;
  readonly type: EventType;
  readonly payload?: TPayload;
  readonly clientSeq?: number;
  /**
   * `schemaVersion` override. See the module docstring for the three
   * semantic paths (omit key → default stamp; pass string → stamp
   * that value; pass explicit `undefined` → omit stamp entirely —
   * test-only).
   */
  readonly schemaVersion?: string;
}

/** Input type for {@link makeStreamEnvelope}. */
export interface MakeStreamEnvelopeInput {
  readonly renderId: string;
  readonly channel: string;
  readonly mode: StreamChannelMode;
  readonly payload: JsonValue;
  readonly complete?: boolean;
  readonly seq?: number;
  /** See {@link MakeActionEnvelopeInput.schemaVersion}. */
  readonly schemaVersion?: string;
}

/** Input type for {@link makeErrorPayload}. */
export interface MakeErrorPayloadInput {
  readonly code: string;
  readonly message: string;
  readonly details?: JsonValue;
}

/** Input type for {@link makeContractErrorPayload}. */
export interface MakeContractErrorPayloadInput {
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
  /** See {@link MakeActionEnvelopeInput.schemaVersion}. */
  readonly schemaVersion?: string;
}

/**
 * Resolve the stamp decision for the three semantic paths. Returns
 * `undefined` when the field should be omitted entirely; returns a
 * string when it should be stamped.
 */
function resolveSchemaVersion(
  parts: { readonly schemaVersion?: string },
): string | undefined {
  if ('schemaVersion' in parts) {
    // Caller wrote the key — trust their decision (string OR explicit
    // undefined-to-omit).
    return parts.schemaVersion;
  }
  // Key absent — default stamp.
  return PROTOCOL_SCHEMA_VERSION;
}

/**
 * Build an {@link ActionEnvelope} with `schemaVersion` stamped to
 * {@link PROTOCOL_SCHEMA_VERSION} unless the caller overrides.
 *
 * Filters `undefined` optional fields so the serialized wire message
 * omits them (matches the producer convention that "absent field =
 * default").
 */
export function makeActionEnvelope<TPayload = JsonValue>(
  parts: MakeActionEnvelopeInput<TPayload>,
): ActionEnvelope<TPayload> {
  const envelope: ActionEnvelope<TPayload> = {
    renderId: parts.renderId,
    type: parts.type,
  };
  if (parts.payload !== undefined) envelope.payload = parts.payload;
  if (parts.clientSeq !== undefined) envelope.clientSeq = parts.clientSeq;
  const stamp = resolveSchemaVersion(parts);
  if (stamp !== undefined) envelope.schemaVersion = stamp;
  return envelope;
}

/**
 * Build a {@link StreamEnvelope} with `schemaVersion` stamped to
 * {@link PROTOCOL_SCHEMA_VERSION} unless the caller overrides.
 *
 * Filters `undefined` optional fields (`complete`, `seq`) so the
 * serialized wire message omits them. `seq` is server-assigned in
 * practice — callers pass the value the buffer hands them.
 */
export function makeStreamEnvelope(
  parts: MakeStreamEnvelopeInput,
): StreamEnvelope {
  const envelope: StreamEnvelope = {
    renderId: parts.renderId,
    channel: parts.channel,
    mode: parts.mode,
    payload: parts.payload,
  };
  if (parts.complete !== undefined) envelope.complete = parts.complete;
  if (parts.seq !== undefined) envelope.seq = parts.seq;
  const stamp = resolveSchemaVersion(parts);
  if (stamp !== undefined) envelope.schemaVersion = stamp;
  return envelope;
}

/**
 * Build an {@link ErrorPayload} for the `{type: 'error'}` wire frame.
 *
 * Does NOT stamp `schemaVersion` — `ErrorPayload` is the wire-level
 * error envelope (free-form `code: string`), not an envelope that
 * opts into the forward-compat stamp (see {@link ActionEnvelope} /
 * {@link StreamEnvelope} / {@link ContractErrorPayload}). Keeping
 * `ErrorPayload` stamp-free preserves byte-equivalence with every
 * existing server-side error emission that pre-dates the central
 * builders.
 *
 * The builder exists so first-party subscribe / handshake paths emit
 * canonical codes (e.g. `UPGRADE_REQUIRED`) via a single helper
 * instead of spreading `{code, message}` object literals. `details`
 * is filtered when `undefined` so the serialized frame matches the
 * pre-builder `{code, message}` shape byte-for-byte.
 */
export function makeErrorPayload(parts: MakeErrorPayloadInput): ErrorPayload {
  const payload: ErrorPayload = {
    code: parts.code,
    message: parts.message,
  };
  if (parts.details !== undefined) payload.details = parts.details;
  return payload;
}

/**
 * Build a {@link ContractErrorPayload} with `schemaVersion` stamped
 * to {@link PROTOCOL_SCHEMA_VERSION} unless the caller overrides.
 *
 * Filters `undefined` optional fields so the emitted payload keeps
 * byte-equivalence with the pre-refactor renderChannel router
 * code.
 */
export function makeContractErrorPayload(
  parts: MakeContractErrorPayloadInput,
): ContractErrorPayload {
  const stamp = resolveSchemaVersion(parts);
  const payload: ContractErrorPayload = {
    toolName: parts.toolName,
    error: parts.error,
    timestamp: parts.timestamp,
    ...(parts.actionName !== undefined ? { actionName: parts.actionName } : {}),
    ...(parts.sourceAction !== undefined
      ? { sourceAction: parts.sourceAction }
      : {}),
    ...(stamp !== undefined ? { schemaVersion: stamp } : {}),
  };
  return payload;
}
