/**
 * Canvas-mode lifecycle envelopes.
 *
 * Carried over the reserved `_ggui:lifecycle` channel via `data`
 * WebSocket messages. The server emits at four lifecycle moments;
 * canvas iframes consume (via the animator host) to drive their
 * pill state machine:
 *
 *   - `handshake_started` / `handshake_completed`: bracket each
 *     `ggui_handshake` call so the animator can render "negotiating"
 *     during the gap.
 *   - `push_started`: emitted at the gen gate of `ggui_push`, before
 *     the final `push` envelope lands. Drives the animator's
 *     `constructing` state. The eventual `push` envelope (existing
 *     wire type) signals completion → animator transitions to
 *     `content`.
 *   - `consume_polling`: signals that `ggui_consume` opened a long-
 *     poll. The animator's `listening` state. The complementary
 *     "close" signal is the existing `drain_ack` envelope (consume
 *     drained an action) — no separate "closed" lifecycle kind is
 *     needed.
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
 *     channel. It does NOT describe the animator state machine that
 *     consumes them (lives in `@ggui-ai/iframe-runtime/canvas/animator`).
 *   - This module is `data` only — no functions, no reducers. Pure
 *     types so the protocol bundle stays tiny.
 */

import type { JsonObject } from './data-contract';

/**
 * Emitted when the server starts processing a `ggui_handshake` call.
 * Animator transitions from current state into `handshake` (or its
 * `content`-substate equivalent).
 */
export interface HandshakeStartedPayload extends JsonObject {
  readonly kind: 'handshake_started';
  readonly handshakeId: string;
  /** Agent's intent string — animator may surface this as a label. */
  readonly intent: string;
}

/**
 * Emitted when the server finishes a `ggui_handshake` call. Animator
 * either drops back to `ready`/`content` (no gen expected) or
 * pre-warms to `constructing` if `genExpected: true` so the
 * transition from handshake → constructing doesn't flicker.
 */
export interface HandshakeCompletedPayload extends JsonObject {
  readonly kind: 'handshake_completed';
  readonly handshakeId: string;
  /** Negotiator outcome — informational; animator may surface. */
  readonly outcome: 'accepted' | 'amended' | 'declined' | 'cached';
  /**
   * Whether a cold gen is about to follow this handshake. When true,
   * the canvas may pre-warm the `constructing` state to suppress a
   * `handshake → ready → constructing` flicker.
   */
  readonly genExpected: boolean;
}

/**
 * Emitted when the server starts a `ggui_push` cold-gen (or
 * blueprint-cache hit). The eventual `push` envelope on the existing
 * wire signals completion.
 */
export interface RenderStartedPayload extends JsonObject {
  readonly kind: 'render_started';
  /** The render id the eventual `render` envelope will carry. */
  readonly renderId: string;
  /** Echoed for the animator label ("Building: <intent>"). */
  readonly intent: string;
}

/**
 * Emitted when `ggui_consume` opens a long-poll (after the action
 * pipe is found empty). Animator transitions to `listening`. The
 * complementary "close" signal is the existing `drain_ack` envelope.
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
  /** Render id whose action pipe is being polled. */
  readonly renderId: string;
}

/**
 * Closed discriminated union of every canvas-mode lifecycle payload.
 * New kinds bump the protocol version; consumers narrow on `kind`
 * with exhaustive switch.
 */
export type CanvasLifecyclePayload =
  | HandshakeStartedPayload
  | HandshakeCompletedPayload
  | RenderStartedPayload
  | ConsumePollingPayload;
