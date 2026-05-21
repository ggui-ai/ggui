/**
 * useChannelStream — internal seam for consuming a single channel's
 * {@link StreamEnvelope} sequence on React Native.
 *
 * Mirrors the web hook (`@ggui-ai/react/src/hooks/useChannelStream.ts`)
 * shape — `{ envelopes, complete }` snapshot reset on channel change
 * — but subscribes through the cross-platform `preview-bridge`
 * emitter instead of a DOM `window` CustomEvent. That's the single
 * difference in the signature-internals; callers see the same shape.
 *
 * Scope (V1):
 *   - Internal-only seam for `ProvisionalRenderer` on RN to consume
 *     the reserved `_ggui:preview` channel.
 *   - Not exported from the package root; widening the public API
 *     is a later-slice decision once the renderer proves out on
 *     native.
 *   - Does NOT know A2UI / preview semantics. Downstream components
 *     parse and reduce however they need.
 */
import { useEffect, useState } from 'react';
import type { StreamEnvelope } from '@ggui-ai/protocol';
import { subscribePreviewBridge } from '../internal/preview-bridge';

/**
 * Snapshot returned each render. `envelopes` preserves arrival order;
 * `complete` is a sticky latch — once any envelope carries
 * `complete: true`, the flag stays true for the remainder of the
 * subscription.
 */
export interface ChannelStreamState {
  readonly envelopes: ReadonlyArray<StreamEnvelope>;
  readonly complete: boolean;
}

const EMPTY_STATE: ChannelStreamState = {
  envelopes: [],
  complete: false,
};

/**
 * Subscribe to a single live-channel channel. State resets when
 * `channelName` changes — the previous subscription is torn down by
 * the effect cleanup and the new one starts at empty state.
 *
 * @internal
 */
export function useChannelStream(channelName: string): ChannelStreamState {
  const [state, setState] = useState<ChannelStreamState>(EMPTY_STATE);

  useEffect(() => {
    // Reset on channel change. The effect's cleanup removes the
    // previous listener below, so this snapshot replacement is
    // purely the React-state-side of the switch.
    setState(EMPTY_STATE);

    const dispose = subscribePreviewBridge((envelope) => {
      if (envelope.channel !== channelName) return;
      setState((prev) => ({
        envelopes: [...prev.envelopes, envelope],
        complete: prev.complete || envelope.complete === true,
      }));
    });

    return dispose;
  }, [channelName]);

  return state;
}
