import type { JsonValue } from './data-contract';

/**
 * Event types that flow from user to agent
 */
export type EventType =
  // Data events
  | 'data:submit'
  | 'data:change'
  // Lifecycle events
  | 'lifecycle:session_start'
  | 'lifecycle:session_end'
  | 'lifecycle:stack_push'
  | 'lifecycle:stack_pop'
  | 'lifecycle:focus'
  | 'lifecycle:blur'
  // Interaction events
  | 'interaction:click'
  | 'interaction:hover'
  | 'interaction:scroll'
  // Error events
  | 'error:validation'
  | 'error:connection';

/**
 * Payload shape for `data:submit` events emitted by `useAction()`.
 *
 * Actions ALWAYS drive turns — every action emits an event the agent
 * reacts to on its next turn through `ggui_consume`. There is no
 * synchronous server-side dispatch in agent-mediated deployments. The
 * optional `tool` hint mirrors the active stack item's
 * `actionSpec[action].nextStep` so consumers (the WS-direct
 * `wiredActionRouter` for agent-less `ggui serve` deployments, and
 * telemetry on agent-mediated deployments) see which tool the agent
 * intends to call next without re-looking-up the contract.
 *
 * @typeParam TData - Type of the action payload (defaults to `unknown`).
 */
export interface ActionEventValue<TData = unknown> {
  /** Action ID from the contract (e.g., "submit", "archive"). */
  action: string;
  /** Action payload (e.g., form data). */
  data: TData;
  /**
   * MCP tool name mirrored from the active stack item's
   * `actionSpec[action].nextStep` (when the author declared one).
   * Absent when the action has no `nextStep` — the agent decides the
   * next tool freely from broader context.
   *
   * Consumer behavior:
   *   - Agent-mediated deployments: read by the agent on `ggui_consume`
   *     as a hint; agent decides whether to honor it.
   *   - WS-direct agent-less deployments (`ggui serve`): the
   *     `wiredActionRouter` fires this tool synchronously when present.
   *
   * **Disagreement policy:** if both the envelope's `tool` and the
   * server's `actionSpec[action].nextStep` are present and disagree,
   * the **client-populated value wins** (client is the source of truth
   * for what the user actually saw).
   */
  tool?: string;
}

/**
 * Inbound live-channel envelope — the body of a `type: 'action'`
 * WebSocket message.
 *
 * Symmetric companion to the outbound {@link StreamEnvelope}. Flat,
 * narrow, and limited to fields the server actually enforces or
 * diagnostic fields real consumers populate today.
 *
 * Fields that are NOT on this envelope, and why:
 *   - `appId` — the server resolves it from the session; client-claimed
 *     values are ignored for enforcement.
 *   - `user` / `userId` / `deviceInfo` / `interfaceContext` — diagnostic
 *     session metadata captured at subscribe time, not per-delivery.
 *   - `componentId` / `contractHash` — diagnostic; no enforcement
 *     consumer.
 *   - `timestamp` — the server uses its own clock for ordering + log
 *     emission; client-supplied timestamps aren't authoritative.
 *   - `correlationId` — the doctrine names this for agent-push ↔ user
 *     action pairing; `stackItemId` covers the narrow case today.
 *
 * Required fields map to existing enforcement concerns; optional fields
 * are doctrine-aligned forward-compat additions that cost nothing on the
 * wire when omitted.
 */
export interface ActionEnvelope<TPayload = JsonValue> {
  /**
   * Session identity. Server enforces subscriber-session binding —
   * envelopes whose sessionId doesn't match the ws subscriber's bound
   * session are rejected (SESSION_MISMATCH).
   */
  sessionId: string;
  /**
   * Action / event type. Gated by the active stack item's
   * `subscription.events` allowlist (falling back to
   * `DEFAULT_SUBSCRIPTION`).
   */
  type: EventType;
  /**
   * Payload for the action. For `type: 'data:submit'` this carries the
   * {@link ActionEventValue} shape (`{action, data?, tool?}`) where
   * `data` is validated against the stack item's
   * `actionSpec[action].schema`. For non-data:submit types the payload
   * is free-form — no schema enforcement.
   */
  payload?: TPayload;
  /**
   * Stack item the action originated from. Authoritative for contract
   * lookup when present. Server falls back to
   * `session.currentStackIndex` when absent — that fallback lets
   * agents that have popped forward between emit and ingress still
   * process legitimate in-flight actions.
   */
  stackIndex?: number;
  /**
   * Stable stack-item identifier. Forward-compat with the
   * three-channel-topology doctrine's `correlationId` semantics — when
   * `stackItemId` is present and matches a stack item's `id`, server MAY
   * prefer stackItemId-based contract lookup over positional stackIndex.
   */
  stackItemId?: string;
  /**
   * Client-monotonic sequence number for at-least-once dedup. Declared
   * shape; no server enforcement today (no inbound dedup infrastructure
   * yet). Clients SHOULD populate when their transport can replay
   * (e.g., reconnect-with-backfill); server SHOULD dedup by
   * `(sessionId, clientSeq)` when dedup lands.
   */
  clientSeq?: number;
  /**
   * Protocol schema version stamped by the producer. Pre-launch:
   * advisory — consumers MUST NOT reject on mismatch. A future
   * launch-cutover change tightens policy to `UPGRADE_REQUIRED` when
   * the received major diverges from the client's known major.
   *
   * See `PROTOCOL_SCHEMA_VERSION` for the current value.
   */
  schemaVersion?: string;
}

/**
 * Event subscription configuration.
 *
 * @deprecated Pre-actionSpec event-filtering model. Today's flow:
 * every action emits a `data:submit` event the agent receives via
 * `ggui_consume`; non-`data:submit` event types are vestigial. Kept
 * only for older WS clients that still send `subscribe` with these
 * filters — new code MUST NOT consult this type.
 */
export interface EventSubscription {
  /** Global event types to subscribe to */
  events: EventType[];
  /** Per-component overrides for event filtering and streaming */
  components?: Record<string, {
    /** Whether to stream real-time change events for this component */
    stream?: boolean;
    /** Component-specific event types (overrides global list) */
    events?: EventType[];
  }>;
}

/**
 * Default subscription when agent doesn't specify.
 *
 * @deprecated See {@link EventSubscription}.
 */
export const DEFAULT_SUBSCRIPTION: EventSubscription = {
  events: ['data:submit', 'lifecycle:session_end'],
};

// ── System Events (MCP Credential Proxy) ──

/**
 * Emitted when an MCP server requires OAuth credentials that the user
 * has not yet granted. The frontend should display a consent prompt
 * linking to {@link consentUrl}.
 */
export interface McpAuthRequiredEvent {
  type: 'system';
  action: 'auth_required';
  /** Identifier of the external service (e.g. `'github'`, `'slack'`) */
  serviceId: string;
  /** Human-readable service name shown in the consent UI */
  displayName: string;
  /** OAuth scopes being requested (optional — omitted when the service uses fixed scopes) */
  scopes?: string[];
  /** URL the user should visit to grant consent */
  consentUrl: string;
  /** Explanatory message for the user (e.g. "GitHub access is required to list repositories") */
  message: string;
}

/**
 * Emitted after the user completes (or denies) the OAuth consent flow.
 * The frontend should dismiss the consent prompt and, if `status` is
 * `'ready'`, retry the operation that triggered the auth request.
 */
export interface McpCredentialReadyEvent {
  type: 'system';
  action: 'credential_ready';
  /** Identifier of the external service that was authorized */
  serviceId: string;
  /** Whether the credential is now available or the user denied access */
  status: 'ready' | 'denied';
}

/** Union of all system events emitted by the MCP credential proxy */
export type McpCredentialSystemEvent = McpAuthRequiredEvent | McpCredentialReadyEvent;
