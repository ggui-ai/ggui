/**
 * useChannelStream — internal seam for consuming a single channel's
 * {@link StreamEnvelope} sequence from within React.
 *
 * The hook listens for `BRIDGE_EVENTS.AGENT_DATA` CustomEvents
 * dispatched by {@link GguiRender} when the WebSocket delivers a
 * live-channel `data` message, filters them by channel name, and
 * accumulates the matching envelopes in arrival order.
 *
 * Scope (V1):
 *   - Internal-only seam for `ProvisionalRenderer` to consume the
 *     reserved `_ggui:preview` channel. Not exported from the public
 *     `@ggui-ai/react` index; widening the public API shape belongs
 *     to a later slice with its own design decision about whether
 *     agent-authored channels should flow through this primitive too.
 *   - Does NOT own any policy about WHAT the payload means. Downstream
 *     parsing (A2UI message validation, other schemas) happens in
 *     whichever component subscribes.
 *
 * State shape is deliberately dumb — a flat, append-only list plus a
 * `complete` latch. Consumers reduce over the envelopes however they
 * need; the hook doesn't try to be clever about replace-by-id or any
 * other protocol semantics that don't exist in ggui core.
 *
 * SSR safety: returns the empty state when `window` is undefined so
 * the hook doesn't crash during Next.js server-side rendering.
 * Subscribing to a CustomEvent requires a DOM; there's nothing
 * meaningful to do before hydration.
 */
import { useEffect, useState } from 'react';
import type { StreamEnvelope } from '@ggui-ai/protocol';
import { BRIDGE_EVENTS } from '@ggui-ai/protocol';

/**
 * The accumulated state of a single channel subscription, returned
 * each render. `envelopes` preserves arrival order; `complete` flips
 * once any envelope on the channel carries `complete: true` and stays
 * sticky for the remainder of the subscription.
 */
export interface ChannelStreamState {
  /** All envelopes received so far on this channel, in arrival order. */
  readonly envelopes: ReadonlyArray<StreamEnvelope>;
  /** `true` once an envelope with `complete: true` has been observed. */
  readonly complete: boolean;
}

const EMPTY_STATE: ChannelStreamState = {
  envelopes: [],
  complete: false,
};

/**
 * Subscribe to a single live-channel channel by name. The hook resets
 * state whenever `channelName` changes, mirroring the renderer's
 * expectation that switching channels means starting from zero.
 *
 * @internal
 */
export function useChannelStream(channelName: string): ChannelStreamState {
  const [state, setState] = useState<ChannelStreamState>(EMPTY_STATE);

  useEffect(() => {
    // Reset when the target channel changes. The previous subscription
    // was unmounted by the cleanup below; the new one starts fresh.
    setState(EMPTY_STATE);

    if (typeof window === 'undefined') {
      return;
    }

    const listener = (event: Event) => {
      const detail = (event as CustomEvent).detail as StreamEnvelope | undefined;
      if (!detail || detail.channel !== channelName) return;
      setState((prev) => ({
        envelopes: [...prev.envelopes, detail],
        complete: prev.complete || detail.complete === true,
      }));
    };

    window.addEventListener(BRIDGE_EVENTS.AGENT_DATA, listener);
    return () => window.removeEventListener(BRIDGE_EVENTS.AGENT_DATA, listener);
  }, [channelName]);

  return state;
}
