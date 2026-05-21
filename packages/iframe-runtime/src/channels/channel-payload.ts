/**
 * `channel_payload` + `channel_error` handlers — forward to the
 * per-channel transport router (`channel-transport.ts`).
 *
 * The router owns the streamSpec subscription registry (which channels
 * are WS-subscribed vs iframe-polling). Forwarding here is a thin
 * passthrough — the router parses the frame contents against its
 * subscription map and dispatches to the matching consumer.
 *
 * Factored out of `handleTriadMessage` as part of the B3a handler
 * extraction.
 */

import type { ChannelHandler } from '@ggui-ai/channel-client';
import type {
  ChannelErrorPayload,
  ChannelPayloadFrame,
} from '@ggui-ai/protocol';

import type { ChannelTransportRouter } from '../channel-transport.js';

export interface ChannelRouterHandlerDeps {
  readonly getChannelTransport: () => ChannelTransportRouter;
}

export function createChannelPayloadHandler(
  deps: ChannelRouterHandlerDeps,
): ChannelHandler<ChannelPayloadFrame> {
  return {
    type: 'channel_payload',
    onMessage: (payload) => {
      deps.getChannelTransport().handleWsFrame({
        type: 'channel_payload',
        payload,
      });
    },
  };
}

export function createChannelErrorHandler(
  deps: ChannelRouterHandlerDeps,
): ChannelHandler<ChannelErrorPayload> {
  return {
    type: 'channel_error',
    onMessage: (payload) => {
      deps.getChannelTransport().handleWsFrame({
        type: 'channel_error',
        payload,
      });
    },
  };
}
