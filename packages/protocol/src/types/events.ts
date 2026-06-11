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
 * synchronous server-side dispatch.
 *
 * @typeParam TData - Type of the action payload (defaults to `unknown`).
 */
export interface ActionEventValue<TData = unknown> {
  /** Action ID from the contract (e.g., "submit", "archive"). */
  action: string;
  /** Action payload (e.g., form data). */
  data: TData;
  /**
   * MCP tool name populated SERVER-SIDE from the render's
   * `actionSpec[action].nextStep` when the consume event is built.
   * Absent when the action has no `nextStep` — the agent decides the
   * next tool freely from broader context.
   *
   * Advisory hint, not binding: the agent sees it on `ggui_consume`
   * and decides whether to honor it on its next turn.
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

