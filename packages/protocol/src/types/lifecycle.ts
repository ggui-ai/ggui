/**
 * Generation-progress lifecycle envelopes.
 *
 * Carried over the reserved `_ggui:lifecycle` channel via `data`
 * WebSocket messages. The server emits at four lifecycle moments;
 * subscribed clients consume them to drive progress indicators:
 *
 *   - `handshake_started` / `handshake_completed`: bracket each
 *     `ggui_handshake` call so a progress UI can render "negotiating"
 *     during the gap.
 *   - `render_started`: emitted at the gen gate of `ggui_render`, before
 *     the final `render` envelope lands. Drives a "constructing"
 *     indicator. The eventual `render` envelope (existing wire type)
 *     signals completion → the indicator gives way to content.
 *   - `consume_polling`: signals that `ggui_consume` opened a long-
 *     poll — a "listening" indicator. The complementary "close"
 *     signal is the existing `drain_ack` envelope (consume drained an
 *     action) — no separate "closed" lifecycle kind is needed.
 *
 * Discriminated on `kind`. Adding a kind is a protocol-version bump,
 * not a silent extension — keeps the union closed so producers and
 * consumers agree on the surface.
 *
 * Every variant extends `JsonObject` so producers can hand the
 * payload directly to JsonValue-typed transport seams without an
 * unsafe cast.
 *
 * Boundary discipline:
 *   - This module describes ENVELOPE SHAPES carried on a reserved
 *     channel. It does NOT describe the progress-indicator state
 *     machine that consumes them — that is client-side presentation,
 *     outside the protocol.
 *   - This module is `data` only — no functions, no reducers. Pure
 *     types so the protocol bundle stays tiny.
 */

import type { JsonObject } from './data-contract';

/**
 * Emitted when the server starts processing a `ggui_handshake` call.
 * Progress UIs transition from their current state into a
 * "negotiating" indicator.
 */
export interface HandshakeStartedPayload extends JsonObject {
  readonly kind: 'handshake_started';
  readonly handshakeId: string;
  /** Agent's intent string — consumers may surface this as a label. */
  readonly intent: string;
}

/**
 * Emitted when the server finishes a `ggui_handshake` call. A progress
 * UI either drops back to its idle/content state (no gen expected) or
 * pre-warms its "constructing" indicator if `genExpected: true` so the
 * handshake → constructing transition doesn't flicker.
 */
export interface HandshakeCompletedPayload extends JsonObject {
  readonly kind: 'handshake_completed';
  readonly handshakeId: string;
  /** Negotiator outcome — informational; consumers may surface. */
  readonly outcome: 'accepted' | 'amended' | 'declined' | 'cached';
  /**
   * Whether a cold gen is about to follow this handshake. When true,
   * the consumer may pre-warm its "constructing" indicator to suppress
   * a `handshake → idle → constructing` flicker.
   */
  readonly genExpected: boolean;
}

/**
 * Emitted when the server starts a `ggui_render` cold-gen (or
 * blueprint-cache hit). The eventual `render` envelope on the existing
 * wire signals completion.
 */
export interface RenderStartedPayload extends JsonObject {
  readonly kind: 'render_started';
  /** The GguiSession id the eventual `render` envelope will carry. */
  readonly sessionId: string;
  /** Echoed for the progress label ("Building: <intent>"). */
  readonly intent: string;
}

/**
 * Emitted when `ggui_consume` opens a long-poll (after the action
 * pipe is found empty) — a "listening" indicator. The complementary
 * "close" signal is the existing `drain_ack` envelope.
 */
export interface ConsumePollingPayload extends JsonObject {
  readonly kind: 'consume_polling';
  /**
   * Always `'open'` today — the closing transition is signaled
   * by the existing `drain_ack` envelope (action consumed) and by the
   * absence of further `consume_polling` for the same render.
   * Reserved as a discriminator field rather than implicit so future
   * `'closed'` / `'timeout'` variants can layer in without a wire
   * shape change.
   */
  readonly state: 'open';
  /** GguiSession id whose action pipe is being polled. */
  readonly sessionId: string;
}

/**
 * Closed discriminated union of every generation-progress lifecycle
 * payload. New kinds bump the protocol version; consumers narrow on
 * `kind` with exhaustive switch.
 */
export type GguiLifecyclePayload =
  | HandshakeStartedPayload
  | HandshakeCompletedPayload
  | RenderStartedPayload
  | ConsumePollingPayload;
