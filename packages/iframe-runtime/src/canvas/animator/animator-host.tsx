/**
 * Animator host.
 *
 * Wires the pure animator state-machine to its real-world inputs:
 *
 *   - live-channel `_ggui:lifecycle` envelopes (handshake_started,
 *     handshake_completed, push_started, consume_polling)
 *   - the `push` / `pop` / `drain_ack` envelopes
 *   - `_ggui:contract-error` envelopes
 *   - transport online/offline events
 *
 * Renders `<AnimatorPill>` with the current state. Sub-component, so
 * the canvas shell mounts one of these alongside the active stack-item
 * mount.
 *
 * Subscription wiring:
 *   - The shell passes an `events` stream (an EventEmitter-shaped
 *     handle, or just a React-friendly state) into the host. The
 *     host's job is purely "feed events into the reducer + render the
 *     pill." Subscription plumbing lives at the shell layer where
 *     live-channel wiring is already established.
 *
 * Flicker suppression (Decision 4 in decisions.md):
 *   - When handshake_started fires, the host waits 150ms before
 *     showing the `handshake` state visually. If handshake_completed
 *     arrives within that window, the visible state never enters
 *     `handshake` — avoids the flicker on cached handshakes.
 *   - Implemented via a small ref+setTimeout dance in the host;
 *     state-machine itself stays pure.
 */

import { useEffect, useReducer, useRef, type ReactNode } from 'react';
import { AnimatorPill } from './animator-pill.js';
import {
  INITIAL_STATE,
  transition,
  type AnimatorEvent,
  type AnimatorState,
} from './state-machine.js';

export interface AnimatorEventStream {
  /**
   * Subscribe to events. Returns an unsubscribe function. Callers MUST
   * call unsubscribe in their effect-cleanup path.
   */
  readonly subscribe: (listener: (event: AnimatorEvent) => void) => () => void;
}

export interface AnimatorHostProps {
  readonly events: AnimatorEventStream;
  readonly layout: 'centered' | 'navbar';
  readonly readyLabel?: string;
  /**
   * Optional handshake-flicker suppression window in ms. Defaults to
   * 150 per the design doc; tests inject 0 to disable suppression.
   */
  readonly handshakeFlickerMs?: number;
}

export function AnimatorHost({
  events,
  layout,
  readyLabel,
  handshakeFlickerMs = 150,
}: AnimatorHostProps): ReactNode {
  const [state, dispatch] = useReducer(transition, INITIAL_STATE);

  // Handshake-flicker suppression. Hold pending `handshake_started`
  // events for `handshakeFlickerMs` before dispatching; if a matching
  // `handshake_completed` arrives in the window, discard both.
  const pendingHandshakeRef = useRef<{
    handshakeId: string;
    timer: ReturnType<typeof setTimeout>;
    event: AnimatorEvent;
  } | null>(null);

  useEffect(() => {
    const unsubscribe = events.subscribe((event) => {
      if (handshakeFlickerMs > 0 && event.kind === 'handshake_started') {
        // Cancel any previously-pending handshake (rare; defensive).
        if (pendingHandshakeRef.current) {
          clearTimeout(pendingHandshakeRef.current.timer);
        }
        const handshakeId = event.payload.handshakeId;
        const timer = setTimeout(() => {
          // Fire deferred dispatch.
          dispatch(event);
          pendingHandshakeRef.current = null;
        }, handshakeFlickerMs);
        pendingHandshakeRef.current = { handshakeId, timer, event };
        return;
      }

      if (event.kind === 'handshake_completed' && pendingHandshakeRef.current) {
        // Completion arrived before the visible window opened — cancel
        // the pending dispatch entirely. The state machine never sees
        // either event, so the visual stays at its prior state (avoids
        // a flicker through `handshake`).
        if (
          pendingHandshakeRef.current.handshakeId === event.payload.handshakeId
        ) {
          clearTimeout(pendingHandshakeRef.current.timer);
          pendingHandshakeRef.current = null;
          return;
        }
      }

      dispatch(event);
    });
    return () => {
      unsubscribe();
      if (pendingHandshakeRef.current) {
        clearTimeout(pendingHandshakeRef.current.timer);
        pendingHandshakeRef.current = null;
      }
    };
  }, [events, handshakeFlickerMs]);

  return <AnimatorPill state={state} layout={layout} readyLabel={readyLabel} />;
}

/**
 * Test-only: drive the animator host with a synthetic events stream
 * built from an array of events. The host's `useEffect` subscribes
 * once; pushing more events post-mount requires a real stream impl.
 * Exported for the canvas-shell integration test in.
 *
 * @internal
 */
export function createSyntheticEventsStream(): {
  readonly stream: AnimatorEventStream;
  readonly emit: (event: AnimatorEvent) => void;
} {
  let listener: ((event: AnimatorEvent) => void) | null = null;
  return {
    stream: {
      subscribe(l) {
        listener = l;
        return () => {
          if (listener === l) listener = null;
        };
      },
    },
    emit(event) {
      if (listener) listener(event);
    },
  };
}

export type { AnimatorState };
