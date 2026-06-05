import type { JsonValue } from './data-contract';

/**
 * Event types that flow from user to agent
 */
export type EventType =
  // Data events
  | 'data:submit'
  | 'data:change'
  // Lifecycle events (render-level)
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
 * optional `tool` hint mirrors the active render's
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
   * MCP tool name mirrored from the active render's
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
 *   - `appId` — the server resolves it from the render; client-claimed
 *     values are ignored for enforcement.
 *   - `user` / `userId` / `deviceInfo` / `interfaceContext` — diagnostic
 *     metadata captured at subscribe time, not per-delivery.
 *   - `componentId` / `contractHash` — diagnostic; no enforcement
 *     consumer.
 *   - `timestamp` — the server uses its own clock for ordering + log
 *     emission; client-supplied timestamps aren't authoritative.
 *   - `correlationId` — the doctrine names this for agent-push ↔ user
 *     action pairing; `sessionId` covers the narrow case today.
 *
 * Required fields map to existing enforcement concerns; optional fields
 * are doctrine-aligned forward-compat additions that cost nothing on the
 * wire when omitted.
 */
export interface ActionEnvelope<TPayload = JsonValue> {
  /**
   * GguiSession identity. Server enforces subscriber-render binding —
   * envelopes whose sessionId doesn't match the ws subscriber's bound
   * render are rejected (SESSION_MISMATCH).
   */
  sessionId: string;
  /**
   * Action / event type. Gated by the active render's
   * `actionSpec` declarations.
   */
  type: EventType;
  /**
   * Payload for the action. For `type: 'data:submit'` this carries the
   * {@link ActionEventValue} shape (`{action, data?, tool?}`) where
   * `data` is validated against the render's
   * `actionSpec[action].schema`. For non-data:submit types the payload
   * is free-form — no schema enforcement.
   */
  payload?: TPayload;
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
