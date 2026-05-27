/**
 * Client-side contract validation — symmetry with the server's enforcement
 * path.
 *
 * The server (`cloud/amplify/functions/websocket-handlers/message/handle-event.ts`
 * + `@ggui-ai/mcp-server`'s `/ws`) is the authoritative enforcement point
 * for live-channel contract. The client MUST NOT assume the server will
 * reject misbehaving traffic silently — but it SHOULD fail early +
 * symmetrically when the agreed contract is known client-side, for two
 * reasons:
 *
 *   1. Developer UX: catching a malformed `useAction(name)(payload)` at
 *      the dispatch site surfaces the bug next to the offending line,
 *      not later as a server rejection.
 *   2. Save a round-trip when the violation is locally knowable.
 *
 * The validators here are THIN wrappers over `@ggui-ai/protocol`'s
 * `validateActionData` / `validateStreamData` / `validatePropsData`.
 * They don't invent a second contract model — they adapt the SAME
 * protocol functions to the three client-side boundary points:
 *
 *   - outbound action (symmetric to server inbound action)
 *   - inbound stream / data (symmetric to server outbound fan-out)
 *   - inbound props update (new for client — server already validates
 *     on emit; client revalidation is defense-in-depth on receipt)
 *
 * `ClientContractViolationError` is the single error class the client
 * surfaces via the session `onError` callback. The `direction` field
 * disambiguates send-side vs receive-side violations for debugging.
 */
import {
  isKnownReservedChannel,
  makeActionEnvelope,
  validateActionData,
  validateActionEnvelope,
  validatePropsData,
  validateStreamData,
  type ActionEnvelope,
  type ActionSpec,
  type ContractViolation,
  type EventType,
  type JsonObject,
  type JsonValue,
  type PropsSpec,
  type ReservedChannelValidator,
  type StreamSpec,
  type ValidationResult,
} from '@ggui-ai/protocol';

/** Which boundary the violation was detected at. */
export type ClientContractDirection =
  | 'outbound-action'
  | 'inbound-stream'
  | 'inbound-props';

/**
 * Thrown (or surfaced via `onError`) when a client-side contract check
 * fails. Distinct from the server's `ContractViolationError` — this one
 * carries a `direction` field so React devs can tell which client
 * boundary rejected the payload.
 */
export class ClientContractViolationError extends Error {
  readonly direction: ClientContractDirection;
  readonly violations: ContractViolation[];

  constructor(
    direction: ClientContractDirection,
    violations: ContractViolation[],
    hint?: string,
  ) {
    super(
      hint
        ? `Client contract violation (${direction}): ${hint}`
        : `Client contract violation (${direction})`,
    );
    this.name = 'ClientContractViolationError';
    this.direction = direction;
    this.violations = violations;
  }
}

/**
 * Validate an outbound user action before sending it over the channel.
 *
 * Equivalent to the server-side `assertActionContract` call on the
 * inbound ingress path — same schema checks, same rejection semantics.
 * The client wraps `(actionName, data)` into the `ActionEventValue`
 * envelope the server expects and runs the protocol's shared
 * validator.
 *
 * Returns `{valid: true}` when no `actionSpec` is declared (permissive
 * matches the server's "no contract = nothing to enforce" behavior).
 */
export function validateOutboundActionPayload(
  actionSpec: ActionSpec | undefined,
  actionName: string,
  data: unknown,
): ValidationResult {
  if (!actionSpec) return { valid: true, violations: [] };
  return validateActionData({ action: actionName, data }, actionSpec);
}

/**
 * Validate an inbound stream delivery's payload against the declared
 * channel schema before applying it to component state.
 *
 * Signature matches {@link StreamEnvelope} — channel name + payload
 * are the explicit wire fields. If the server's defense-in-depth
 * fires, the payload already shouldn't reach the client; this check
 * fires when client-known state drifts (e.g. the server's session
 * snapshot of streamSpec differs from what the client negotiated).
 *
 * Reserved-channel handling (Item 4 injection pattern):
 *
 *   - Known reserved channels (`_ggui:*` — see
 *     {@link isKnownReservedChannel}) validate even when
 *     `streamSpec === undefined`, because the payload shape is
 *     server-owned (or injected). Runs through `validateStreamData`'s
 *     two-tier lookup: extras first, then BUILTIN
 *     (`_ggui:contract-error` ships a protocol-owned validator), then
 *     fall-through to valid.
 *   - User channels retain the permissive behavior — no streamSpec =
 *     no contract to enforce on inbound.
 */
export function validateInboundStreamPayload(
  streamSpec: StreamSpec | undefined,
  channelName: string,
  payload: unknown,
  extraReservedValidators?: ReadonlyMap<string, ReservedChannelValidator>,
): ValidationResult {
  if (isKnownReservedChannel(channelName)) {
    return validateStreamData(channelName, payload, streamSpec ?? {}, extraReservedValidators);
  }
  if (!streamSpec) return { valid: true, violations: [] };
  return validateStreamData(channelName, payload, streamSpec, extraReservedValidators);
}

/**
 * Build an {@link ActionEnvelope} from explicit fields. Filters
 * `undefined` optionals so the serialized wire message omits them
 * (matches the protocol's "absent field = default" convention).
 *
 * This is the canonical construction helper used by the repo-local
 * session emitters (`@ggui-ai/react` and `@ggui-ai/react-native`).
 * Both `GguiSession` implementations route every outbound action
 * through `buildActionEnvelope` + {@link validateOutboundActionEnvelope}
 * + `sendAction`. Third-party live-channel clients should use the same
 * helper (or replicate its zero-undefined shape) so server-side
 * enforcement and client-side early-failure agree on one contract.
 *
 * Post-Item-1 this wrapper delegates to the protocol-internal
 * {@link makeActionEnvelope} central builder. Kept as a named export
 * so the two repo-local SDK emitters keep their existing import
 * shape; the internal body is a thin re-shape of
 * `makeActionEnvelope`'s single object parameter.
 */
export function buildActionEnvelope<TPayload = JsonValue>(params: {
  renderId: string;
  type: EventType;
  payload?: TPayload;
  clientSeq?: number;
  /**
   * Explicit override — when omitted, the builder stamps
   * `PROTOCOL_SCHEMA_VERSION`. Override only when a test or a
   * cross-version consumer needs to emit a specific wire generation.
   */
  schemaVersion?: string;
}): ActionEnvelope<TPayload> {
  // Forward to the central builder. The input shape is identical, so
  // passing `params` through preserves the "explicit schemaVersion vs
  // key absent" distinction on which the builder relies.
  return makeActionEnvelope<TPayload>(params);
}

/**
 * Validate an outbound {@link ActionEnvelope} before sending it over
 * the channel. Thin wrapper around the protocol's
 * {@link validateActionEnvelope} that returns the same
 * {@link ValidationResult} — callers decide whether to surface a
 * {@link ClientContractViolationError} (direction
 * `'outbound-action'`) or handle inline.
 *
 * Semantics mirror the server's inbound enforcement: non-data:submit
 * types skip the payload check; missing actionSpec is permissive.
 *
 * This is symmetric with {@link validateOutboundActionPayload} but
 * operates on the flat envelope shape rather than
 * `(actionName, data)`. Both helpers delegate to the same protocol
 * validator — no parallel contract model.
 */
export function validateOutboundActionEnvelope(
  actionSpec: ActionSpec | undefined,
  envelope: ActionEnvelope,
): ValidationResult {
  return validateActionEnvelope(envelope, actionSpec);
}

/**
 * Validate a `props_update` payload against the target render's
 * `propsSpec` before applying.
 *
 * Server-side `assertPropsContract` runs on the ingress path into
 * `ggui_update`, so a well-behaved mutation handler never produces a
 * violating `props_update`. This client-side check catches
 * spec-versioning drift and acts as a defense-in-depth for renders
 * whose spec the client cached from a prior `ggui_render` call.
 */
export function validateInboundPropsPayload(
  propsSpec: PropsSpec | undefined,
  props: JsonObject,
): ValidationResult {
  if (!propsSpec) return { valid: true, violations: [] };
  return validatePropsData(props, propsSpec);
}
