/**
 * Reserved channel namespace for server-emitted streams on the live channel.
 *
 * Agents may NOT declare channels whose names start with `_ggui:` in
 * their `streamSpec`. The namespace is reserved for system
 * channels the server emits directly — bypassing the agent's declared
 * streamSpec because these channels are not part of the agent-authored
 * contract.
 *
 * Concrete reservations today:
 *
 *   - {@link PREVIEW_CHANNEL} — provisional A2UI assembly stream
 *     emitted during fresh-gen `ggui_render` flows. The integration
 *     surface (A2UI message types, catalog, validators) lives in the
 *     dedicated boundary package `@ggui-ai/preview-a2ui`; this module
 *     owns only the protocol-level naming rule so `@ggui-ai/protocol`
 *     stays free of A2UI-shaped types. Payload validation for this
 *     channel is delivered via the INJECTION pattern documented on
 *     {@link BUILTIN_RESERVED_VALIDATORS} — the server composes the
 *     A2UI validator into `validateStreamData`'s
 *     `extraReservedValidators` parameter.
 *   - {@link CONTRACT_ERROR_CHANNEL} — canonical error envelope
 *     surface for runtime contract violations. A server emits a
 *     {@link ContractErrorPayload} when a tool-mediated contract
 *     obligation fails (e.g., a tool return violates the schema the
 *     contract declares for it).
 *     Payload is a PROTOCOL-OWNED shape, so the structural validator
 *     ships inside this module as a built-in (see
 *     {@link validateContractErrorPayload} +
 *     {@link BUILTIN_RESERVED_VALIDATORS}).
 *
 * Why here and not in `types/live-channel.ts`: `live-channel.ts` describes
 * WIRE envelope shapes (`StreamEnvelope`, `SubscribePayload`). This
 * file describes a NAMING POLICY that the contract-structure validator
 * enforces. Separate concerns — easier to audit the boundary.
 */
import type { ContractErrorPayload } from '../types/data-contract';
import type { ContractViolation, ValidationResult } from './contract-validator';

/** Prefix that marks a channel as server-owned (reserved from agents). */
export const RESERVED_CHANNEL_PREFIX = '_ggui:';

/**
 * Reserved channel for provisional A2UI assembly streams emitted by
 * the server during fresh-gen `ggui_render` flows. The agent never
 * authors messages on this channel; the renderer subscribes implicitly
 * and dispatches the A2UI payload through its preview surface.
 */
export const PREVIEW_CHANNEL = '_ggui:preview';

/**
 * Reserved channel for canonical contract-error envelopes. Body shape
 * is `ContractErrorPayload` (see `types/data-contract.ts`).
 * Agent-authored `streamSpec` MUST NOT declare this channel —
 * structural validation rejects it alongside every other
 * reserved-prefix name.
 *
 * If future work adds richer contract observability, each new name
 * joins this module with its own constant and the
 * {@link KNOWN_RESERVED_CHANNELS} set below.
 */
export const CONTRACT_ERROR_CHANNEL = '_ggui:contract-error';

/**
 * Reserved channel for canvas-mode render
 * lifecycle envelopes — handshake / render / consume lifecycle signals
 * that drive the ggui-animator's state machine.
 *
 * Body shape: `CanvasLifecyclePayload` (discriminated on `kind`). The
 * server emits; canvas iframes (subscribed render-wide) consume.
 * Inline iframes (pinned to a single render) do not receive
 * envelopes on this channel — delivery is gated by subscription scope.
 *
 * Agent-authored `streamSpec` MUST NOT declare this channel; the
 * structural validator rejects it alongside every other reserved-
 * prefix name.
 */
export const LIFECYCLE_CHANNEL = '_ggui:lifecycle';

/**
 * Closed set of RECOGNIZED reserved channel names. Emissions and
 * delivery validation consult this set — NOT the broader prefix
 * predicate — so a typo inside the reserved namespace
 * (`_ggui:preveiw`) cannot silently pass validation the way the
 * unbounded prefix check did. A typo now falls through to the normal
 * "unknown channel" rejection, surfacing the bug at its source instead
 * of turning it into a silent no-op delivery.
 *
 * Adding a new reserved channel requires two edits: add the constant
 * above, and add it to this set. The audit rule for future reviewers
 * is "if a constant in this file is not in {@link KNOWN_RESERVED_CHANNELS},
 * it is not a recognized delivery target".
 */
export const KNOWN_RESERVED_CHANNELS: ReadonlySet<string> = new Set([
  PREVIEW_CHANNEL,
  CONTRACT_ERROR_CHANNEL,
  LIFECYCLE_CHANNEL,
]);

/**
 * Returns `true` when `name` falls inside the server-owned reserved
 * NAMESPACE (prefix `_ggui:`). Used exclusively by
 * {@link validateContractStructure} to reject agent-authored
 * `streamSpec` entries that try to declare ANY channel in the reserved
 * namespace — regardless of whether the server currently recognizes
 * the specific name. Broader than {@link isKnownReservedChannel} by
 * design.
 */
export function isReservedChannelName(name: string): boolean {
  return name.startsWith(RESERVED_CHANNEL_PREFIX);
}

/**
 * Returns `true` when `name` is a RECOGNIZED reserved channel the
 * server-side runtime emits on today (see
 * {@link KNOWN_RESERVED_CHANNELS}). Narrower than
 * {@link isReservedChannelName} by design — a typo inside the reserved
 * prefix (`_ggui:preveiw`) returns `false` here, which is the whole
 * point: delivery validators and reserved-channel storage policies
 * consult THIS predicate so typos surface as normal "unknown channel"
 * rejections instead of silent no-op passes.
 */
export function isKnownReservedChannel(name: string): boolean {
  return KNOWN_RESERVED_CHANNELS.has(name);
}

// ───────────────────────────────────────────────────────────────────
// Reserved-channel payload validators (Item 4 / injection pattern)
// ───────────────────────────────────────────────────────────────────

/**
 * Validator signature for reserved-channel payload shape checks.
 *
 * Reserved-channel payload validation is split into TWO pools, joined
 * at delivery time by {@link validateStreamData}:
 *
 *   1. `BUILTIN_RESERVED_VALIDATORS` — the PROTOCOL-OWNED payloads.
 *      Shipped in `@ggui-ai/protocol` because the protocol defines the
 *      shape (`ContractErrorPayload` is authored here; the validator
 *      belongs here too). Always active, no composition needed.
 *   2. `extraReservedValidators` — INJECTION POINT for payloads whose
 *      shape the protocol does NOT own. Primary consumer today:
 *      `_ggui:preview` carries an A2UI-shaped `ServerMessage` from
 *      `@ggui-ai/preview-a2ui`. The A2UI boundary package exports the
 *      schema; hosting implementations compose a
 *      {@link ReservedChannelValidator} adapter and pass it in.
 *
 * This split is the Protocol #6 (vendor-neutral separation)
 * preservation: `@ggui-ai/protocol` ships zero imports of
 * `@ggui-ai/preview-a2ui`, so third-party implementations that don't
 * adopt A2UI can still build on the protocol without pulling in a
 * preview-specific dep graph. Servers that DO use A2UI (the ggui
 * first-party `@ggui-ai/mcp-server`) inject the validator at
 * composition time.
 */
export type ReservedChannelValidator = (
  payload: unknown,
) => ValidationResult;

/**
 * Structural validator for {@link ContractErrorPayload} — the body the
 * server emits on `_ggui:contract-error`. PROTOCOL-OWNED shape; ships
 * as a built-in (see {@link BUILTIN_RESERVED_VALIDATORS}).
 *
 * Semantics:
 *   - Payload MUST be a non-null object (arrays rejected).
 *   - Required fields: `toolName: string`, `error.code: string`,
 *     `error.message: string`, `timestamp: string`.
 *   - Optional fields: `error.causedBy: string`, `schemaVersion: string`.
 *   - `error.code` accepts ANY string — the {@link ContractErrorCode}
 *     type is extensibly-closed per Item 2 (`(string & {})` branch),
 *     so forward-compat codes like `BOOTSTRAP_FAILED` /
 *     `RATE_LIMIT_EXCEEDED` MUST NOT be rejected at this layer.
 *
 * Returns `{valid: true, violations: []}` on conformance. Reject sets
 * `valid: false` with one violation per missing-or-mistyped field.
 */
export function validateContractErrorPayload(
  payload: unknown,
): ValidationResult {
  const violations: ContractViolation[] = [];

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return {
      valid: false,
      violations: [
        {
          field: 'payload',
          message: `${CONTRACT_ERROR_CHANNEL} payload must be a non-null object`,
          expected: 'object',
          received: payload === null ? 'null' : Array.isArray(payload) ? 'array' : typeof payload,
        },
      ],
    };
  }

  const p = payload as Partial<ContractErrorPayload> & Record<string, unknown>;

  // ── Required: toolName ──
  if (typeof p.toolName !== 'string') {
    violations.push({
      field: 'toolName',
      message: "Required field 'toolName' must be a string",
      expected: 'string',
      received: p.toolName === undefined ? 'undefined' : typeof p.toolName,
    });
  }

  // ── Required: error.code + error.message ──
  if (typeof p.error !== 'object' || p.error === null || Array.isArray(p.error)) {
    violations.push({
      field: 'error',
      message: "Required field 'error' must be a non-null object",
      expected: 'object',
      received: p.error === undefined ? 'undefined' : p.error === null ? 'null' : Array.isArray(p.error) ? 'array' : typeof p.error,
    });
  } else {
    const err = p.error as Record<string, unknown>;
    if (typeof err.code !== 'string') {
      // Accepts any string — ContractErrorCode is extensibly-closed per
      // Item 2. Rejecting by name-set here would force a version bump
      // every time a new code ships.
      violations.push({
        field: 'error.code',
        message: "Required field 'error.code' must be a string",
        expected: 'string',
        received: err.code === undefined ? 'undefined' : typeof err.code,
      });
    }
    if (typeof err.message !== 'string') {
      violations.push({
        field: 'error.message',
        message: "Required field 'error.message' must be a string",
        expected: 'string',
        received: err.message === undefined ? 'undefined' : typeof err.message,
      });
    }
    if (err.causedBy !== undefined && typeof err.causedBy !== 'string') {
      violations.push({
        field: 'error.causedBy',
        message: "Optional field 'error.causedBy' must be a string when present",
        expected: 'string',
        received: typeof err.causedBy,
      });
    }
  }

  // ── Required: timestamp ──
  if (typeof p.timestamp !== 'string') {
    violations.push({
      field: 'timestamp',
      message: "Required field 'timestamp' must be a string (ISO 8601)",
      expected: 'string',
      received: p.timestamp === undefined ? 'undefined' : typeof p.timestamp,
    });
  }

  // ── Optional: schemaVersion ──
  if (p.schemaVersion !== undefined && typeof p.schemaVersion !== 'string') {
    violations.push({
      field: 'schemaVersion',
      message: "Optional field 'schemaVersion' must be a string when present",
      expected: 'string',
      received: typeof p.schemaVersion,
    });
  }

  return { valid: violations.length === 0, violations };
}

/**
 * The PROTOCOL-OWNED reserved-channel validator registry.
 *
 * Only channels whose payload shape is authored inside
 * `@ggui-ai/protocol` appear here. `_ggui:preview` is intentionally
 * ABSENT — its payload is A2UI-shaped (authored in
 * `@ggui-ai/preview-a2ui`), and shipping a validator for it in this
 * package would couple the protocol to a preview-specific dep graph,
 * breaking Protocol #6 (vendor-neutral separation).
 *
 * Hosting implementations that compose preview support inject their
 * own `_ggui:preview` validator via
 * `validateStreamData(..., extraReservedValidators)` — lookup order:
 * extras first, then this built-in map, then fall-through to valid.
 *
 * Readonly `ReadonlyMap` so consumers can't mutate the global registry.
 */
export const BUILTIN_RESERVED_VALIDATORS: ReadonlyMap<
  string,
  ReservedChannelValidator
> = new Map([
  [CONTRACT_ERROR_CHANNEL, validateContractErrorPayload],
  [LIFECYCLE_CHANNEL, validateCanvasLifecyclePayload],
  // PREVIEW_CHANNEL intentionally absent — injected at composition time.
]);

/**
 * Structural validator for {@link LIFECYCLE_CHANNEL} payloads. The
 * wire shape is the closed discriminated union
 * {@link CanvasLifecyclePayload}; we narrow on `kind` and check the
 * required fields per variant. Defines the failure mode the protocol
 * bar requires for reserved channels.
 *
 * Rejects:
 *   - non-object / null / array payloads
 *   - missing or non-string `kind`
 *   - unknown `kind` values (closed union — new kinds bump protocol)
 *   - missing or wrong-typed variant-specific fields
 */
export function validateCanvasLifecyclePayload(
  payload: unknown,
): ValidationResult {
  const violations: ContractViolation[] = [];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return {
      valid: false,
      violations: [
        {
          field: 'payload',
          message: `${LIFECYCLE_CHANNEL} payload must be a non-null object`,
          expected: 'object',
          received: payload === null ? 'null' : Array.isArray(payload) ? 'array' : typeof payload,
        },
      ],
    };
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.kind !== 'string') {
    return {
      valid: false,
      violations: [
        {
          field: 'kind',
          message: "Required field 'kind' must be a string",
          expected: 'string',
          received: p.kind === undefined ? 'undefined' : typeof p.kind,
        },
      ],
    };
  }
  const requireString = (field: string): void => {
    if (typeof p[field] !== 'string') {
      violations.push({
        field,
        message: `Required field '${field}' must be a string`,
        expected: 'string',
        received: p[field] === undefined ? 'undefined' : typeof p[field],
      });
    }
  };
  switch (p.kind) {
    case 'handshake_started':
      requireString('handshakeId');
      requireString('intent');
      break;
    case 'handshake_completed':
      requireString('handshakeId');
      if (
        p.outcome !== 'accepted' &&
        p.outcome !== 'amended' &&
        p.outcome !== 'declined' &&
        p.outcome !== 'cached'
      ) {
        violations.push({
          field: 'outcome',
          message: "Required field 'outcome' must be 'accepted' | 'amended' | 'declined' | 'cached'",
          expected: "'accepted' | 'amended' | 'declined' | 'cached'",
          received: p.outcome === undefined ? 'undefined' : String(p.outcome),
        });
      }
      if (typeof p.genExpected !== 'boolean') {
        violations.push({
          field: 'genExpected',
          message: "Required field 'genExpected' must be a boolean",
          expected: 'boolean',
          received: p.genExpected === undefined ? 'undefined' : typeof p.genExpected,
        });
      }
      break;
    case 'render_started':
      requireString('sessionId');
      requireString('intent');
      break;
    case 'consume_polling':
      requireString('sessionId');
      if (p.state !== 'open') {
        violations.push({
          field: 'state',
          message: "Required field 'state' must be 'open'",
          expected: "'open'",
          received: p.state === undefined ? 'undefined' : String(p.state),
        });
      }
      break;
    default:
      violations.push({
        field: 'kind',
        message: `Unknown lifecycle kind '${p.kind}'. Closed union; new kinds bump protocol version.`,
        expected: "'handshake_started' | 'handshake_completed' | 'render_started' | 'consume_polling'",
        received: p.kind,
      });
  }
  return { valid: violations.length === 0, violations };
}
