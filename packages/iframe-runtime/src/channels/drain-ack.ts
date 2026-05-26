/**
 * `drain_ack` channel handler — factored out of `runtime.ts` into
 * the `@ggui-ai/live-channel` layer. The `onMessage` body fans the
 * payload out to the module-scoped `subscribeDrainAck` listener
 * registry so per-action state machines stay decoupled from how the
 * frame arrives on the wire.
 */

import type { ChannelHandler } from '@ggui-ai/live-channel';
import type { DrainAckPayload } from '@ggui-ai/protocol';

export interface DrainAckHandlerDeps {
  readonly dispatch: (payload: DrainAckPayload) => void;
}

export function createDrainAckHandler(
  deps: DrainAckHandlerDeps,
): ChannelHandler<DrainAckPayload> {
  return {
    type: 'drain_ack',
    onMessage: (payload) => {
      deps.dispatch(payload);
    },
  };
}
