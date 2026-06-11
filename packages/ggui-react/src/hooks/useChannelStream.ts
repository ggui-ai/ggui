/**
 * useChannelStream — internal seam for consuming a single channel's
 * {@link StreamEnvelope} sequence from within React.
 *
 * The hook subscribes to the ambient `<GguiRender>` `StreamBus` (via
 * {@link StreamBusContext}), filters deliveries by channel name, and
 * accumulates the matching envelopes in arrival order. Because the
 * bus buffers reserved (`_ggui:*`) channels in a bounded replay ring,
 * a consumer that mounts AFTER frames arrived — the `_ggui:preview`
 * provisional renderer, which attaches only after the subscribe ack's
 * session payload commits through React state — is caught up
 * synchronously instead of losing the early frames.
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
 *   - Non-reserved channels are NOT replayed (the bus buffers only
 *     `_ggui:*`); a late subscriber on an agent-declared channel sees
 *     only frames arriving after mount — server-side `streamSpec`
 *     replay policy owns that history.
 *
 * State shape is deliberately dumb — a flat, append-only list plus a
 * `complete` latch. Consumers reduce over the envelopes however they
 * need; the hook doesn't try to be clever about replace-by-id or any
 * other protocol semantics that don't exist in ggui core.
 *
 * Outside a `<GguiRender>` (no bus in context — standalone preview
 * mounts) the hook stays on the empty state: there is no live channel
 * in that configuration, so there are no frames to deliver. Matches
 * the standalone no-op `WireConfig` posture in `DynamicComponent`'s
 * `EnsureWireContext`.
 */
import { useContext, useEffect, useState } from 'react';
import type { StreamEnvelope } from '@ggui-ai/protocol';
import { StreamBusContext } from '../internal/stream-bus-context';

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
 * state whenever `channelName` (or the ambient bus) changes, mirroring
 * the renderer's expectation that switching channels means starting
 * from zero — reserved channels are then re-seeded from the bus's
 * replay ring, so the reset is lossless for `_ggui:*` consumers.
 *
 * @internal
 */
export function useChannelStream(channelName: string): ChannelStreamState {
  const bus = useContext(StreamBusContext);
  const [state, setState] = useState<ChannelStreamState>(EMPTY_STATE);

  useEffect(() => {
    // Reset when the target channel (or bus) changes. The previous
    // subscription was unmounted by the cleanup below; the new one
    // starts fresh — reserved-channel history replays synchronously
    // from the bus ring inside `subscribe()`.
    setState(EMPTY_STATE);

    if (bus === null) {
      return;
    }

    return bus.subscribe(channelName, (envelope) => {
      setState((prev) => ({
        envelopes: [...prev.envelopes, envelope],
        complete: prev.complete || envelope.complete === true,
      }));
    });
  }, [bus, channelName]);

  return state;
}
