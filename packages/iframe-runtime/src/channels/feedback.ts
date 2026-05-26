/**
 * `feedback` channel handler — no-op stub.
 *
 * Legacy `feedback` frame: older servers emitted this as the round-trip
 * half of the retired `tool:<name>` client-tool RPC path. Silently
 * ignored under the `clientCapabilities` reframe; kept as a recognized
 * type until the WS message union drops `'feedback'`. Registering a
 * no-op handler is what keeps the registry's dispatch from logging
 * "no handler for type 'feedback'" warnings — the silence is
 * intentional, the handler documents that.
 */

import type { ChannelHandler } from '@ggui-ai/live-channel';
import type { JsonObject } from '@ggui-ai/protocol';

export function createFeedbackHandler(): ChannelHandler<JsonObject> {
  return {
    type: 'feedback',
    onMessage: () => {
      /* no-op — legacy stub */
    },
  };
}
