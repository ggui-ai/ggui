/**
 * Animator state machine.
 *
 * Pure-function reducer driving the ggui-animator pill's state. Inputs:
 *   - live-channel `_ggui:lifecycle` envelopes (handshake_started,
 *     handshake_completed, push_started, consume_polling)
 *   - the existing `push` envelope (stack item appended) → content
 *   - the existing `drain_ack` envelope (consume drained) → exit listening
 *   - canvas-local events (navStack changes, mount, error overlay)
 *
 * Output: the next `AnimatorState`. No DOM, no timers, no side effects.
 * Visual presentation (pill / navbar) lives in `animator-pill.tsx`.
 * Subscription wiring lives in `animator-host.tsx`. Timer-based
 * flicker suppression lives in the host with a small queue +
 * clearTimeout helper.
 *
 * The machine has five primary states plus a `content` state with
 * substates and error/offline overlays.
 */

import type {
  ConsumePollingPayload,
  HandshakeCompletedPayload,
  HandshakeStartedPayload,
  PushStartedPayload,
} from '@ggui-ai/protocol';

// =============================================================================
// State shape
// =============================================================================

export type AnimatorContentSubstate =
  | { readonly kind: 'idle' }
  | { readonly kind: 'handshake'; readonly intent: string }
  | { readonly kind: 'constructing'; readonly intent: string; readonly stackItemId: string }
  | { readonly kind: 'listening'; readonly stackItemId: string };

export type AnimatorState =
  | { readonly kind: 'ready' }
  | {
      readonly kind: 'handshake';
      readonly handshakeId: string;
      readonly intent: string;
    }
  | {
      readonly kind: 'constructing';
      readonly stackItemId: string;
      readonly intent: string;
    }
  | { readonly kind: 'listening'; readonly stackItemId: string }
  | {
      readonly kind: 'content';
      readonly activeItemId: string;
      readonly substate: AnimatorContentSubstate;
    }
  | {
      readonly kind: 'error';
      readonly message: string;
      readonly recoveryTo: AnimatorState;
    }
  | { readonly kind: 'offline' };

export const INITIAL_STATE: AnimatorState = { kind: 'ready' };

// =============================================================================
// Events
// =============================================================================

/**
 * Discriminated union of every event the reducer accepts. The host
 * fans these in from live-channel + canvas-local sources. Wire types
 * (HandshakeStartedPayload etc.) are reused verbatim so the reducer
 * doesn't introduce a parallel type vocabulary.
 */
export type AnimatorEvent =
  | { readonly kind: 'handshake_started'; readonly payload: HandshakeStartedPayload }
  | { readonly kind: 'handshake_completed'; readonly payload: HandshakeCompletedPayload }
  | { readonly kind: 'push_started'; readonly payload: PushStartedPayload }
  | { readonly kind: 'consume_polling'; readonly payload: ConsumePollingPayload }
  // The existing `push` WS envelope translates to this canvas-local event.
  | {
      readonly kind: 'stack_item_appended';
      readonly stackItemId: string;
    }
  // The existing `drain_ack` envelope translates to this.
  | {
      readonly kind: 'action_drained';
      readonly stackItemId: string;
    }
  // The existing `pop` envelope (or back-navigation) translates to this.
  | {
      readonly kind: 'stack_emptied';
    }
  // _ggui:contract-error overlay.
  | {
      readonly kind: 'contract_error';
      readonly message: string;
    }
  // 3s timeout on error → restore previous state.
  | { readonly kind: 'error_dismissed' }
  // Live-channel disconnect.
  | { readonly kind: 'transport_offline' }
  | { readonly kind: 'transport_online' };

// =============================================================================
// Reducer
// =============================================================================

/**
 * Compute the next animator state for an event. Pure function.
 *
 * Decision-log refs (from canvas-mode-decisions.md):
 *
 *   - Substate priority on `content`: constructing > handshake > listening > idle.
 *   - drain_ack is the close signal for listening (no separate
 *     `consume_polling: closed` envelope today).
 *   - Listening during agent reasoning: stay in `ready` post-drain_ack.
 *     Honest signal; don't fake activity the server can't observe.
 */
export function transition(state: AnimatorState, event: AnimatorEvent): AnimatorState {
  // Error + offline overlays — apply first, regardless of current state.
  if (event.kind === 'contract_error') {
    return {
      kind: 'error',
      message: event.message,
      recoveryTo: state.kind === 'error' ? state.recoveryTo : state,
    };
  }
  if (event.kind === 'error_dismissed') {
    if (state.kind === 'error') return state.recoveryTo;
    return state;
  }
  if (event.kind === 'transport_offline') {
    if (state.kind === 'offline') return state;
    return { kind: 'offline' };
  }
  if (event.kind === 'transport_online') {
    if (state.kind === 'offline') return INITIAL_STATE;
    return state;
  }

  // From `content`: substate transitions instead of replacing the outer state.
  if (state.kind === 'content') {
    switch (event.kind) {
      case 'handshake_started':
        return {
          ...state,
          substate: { kind: 'handshake', intent: event.payload.intent },
        };
      case 'handshake_completed':
        // Drop to idle — `push_started` arrives next when gen is expected.
        return { ...state, substate: { kind: 'idle' } };
      case 'push_started':
        return {
          ...state,
          substate: {
            kind: 'constructing',
            intent: event.payload.intent,
            stackItemId: event.payload.stackItemId,
          },
        };
      case 'consume_polling':
        return {
          ...state,
          substate: {
            kind: 'listening',
            stackItemId: event.payload.stackItemId,
          },
        };
      case 'stack_item_appended':
        // New item arrived (e.g. push completed). activeItem moves;
        // substate drops to idle.
        return {
          kind: 'content',
          activeItemId: event.stackItemId,
          substate: { kind: 'idle' },
        };
      case 'action_drained':
        // Listening close signal. Drop substate to idle if it was
        // listening for THIS item; otherwise no-op (out-of-order drain
        // for a popped item).
        if (state.substate.kind === 'listening' && state.substate.stackItemId === event.stackItemId) {
          return { ...state, substate: { kind: 'idle' } };
        }
        return state;
      case 'stack_emptied':
        return INITIAL_STATE;
    }
  }

  // From any non-content state: outer state transitions.
  switch (event.kind) {
    case 'handshake_started':
      return {
        kind: 'handshake',
        handshakeId: event.payload.handshakeId,
        intent: event.payload.intent,
      };
    case 'handshake_completed':
      // Only honor completion that matches the current handshake's id —
      // a stale completion (from a race) doesn't displace newer state.
      if (state.kind !== 'handshake') return state;
      if (state.handshakeId !== event.payload.handshakeId) return state;
      // genExpected pre-warms `constructing`? The `push_started`
      // envelope carries the authoritative stackItemId + intent —
      // wait for it.
      return INITIAL_STATE;
    case 'push_started':
      return {
        kind: 'constructing',
        stackItemId: event.payload.stackItemId,
        intent: event.payload.intent,
      };
    case 'consume_polling':
      return { kind: 'listening', stackItemId: event.payload.stackItemId };
    case 'stack_item_appended':
      return {
        kind: 'content',
        activeItemId: event.stackItemId,
        substate: { kind: 'idle' },
      };
    case 'action_drained':
      // Drained while in listening for THIS item → drop to ready.
      // Otherwise no-op.
      if (state.kind === 'listening' && state.stackItemId === event.stackItemId) {
        return INITIAL_STATE;
      }
      return state;
    case 'stack_emptied':
      return INITIAL_STATE;
  }
}
