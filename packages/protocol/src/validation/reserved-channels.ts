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
 *   - {@link LIFECYCLE_CHANNEL} — generation-progress lifecycle
 *     envelopes the server emits for session-wide subscribers.
 *     Payload is a PROTOCOL-OWNED shape, so the structural validator
 *     ships inside this module as a built-in (see
 *     {@link validateGguiLifecyclePayload} +
 *     {@link BUILTIN_RESERVED_VALIDATORS}).
 *
 * Why here and not in `types/live-channel.ts`: `live-channel.ts` describes
 * WIRE envelope shapes (`StreamEnvelope`, `SubscribePayload`). This
 * file describes a NAMING POLICY that the contract-structure validator
 * enforces. Separate concerns — easier to audit the boundary.
 */
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
 * Reserved channel for generation-progress lifecycle envelopes —
 * handshake / render / consume lifecycle signals that drive
 * client-side progress indicators.
 *
 * Body shape: `GguiLifecyclePayload` (discriminated on `kind`). The
 * server emits; session-wide subscribers consume. Iframes pinned to a
 * single GguiSession do not receive envelopes on this channel —
 * delivery is gated by subscription scope.
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
 *      shape (`GguiLifecyclePayload` is authored here; the validator
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
  [LIFECYCLE_CHANNEL, validateGguiLifecyclePayload],
  // PREVIEW_CHANNEL intentionally absent — injected at composition time.
]);

/**
 * Structural validator for {@link LIFECYCLE_CHANNEL} payloads. The
 * wire shape is the closed discriminated union
 * {@link GguiLifecyclePayload}; we narrow on `kind` and check the
 * required fields per variant. Defines the failure mode the protocol
 * bar requires for reserved channels.
 *
 * Rejects:
 *   - non-object / null / array payloads
 *   - missing or non-string `kind`
 *   - unknown `kind` values (closed union — new kinds bump protocol)
 *   - missing or wrong-typed variant-specific fields
 */
export function validateGguiLifecyclePayload(
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
