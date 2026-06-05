/**
 * postMessage envelope shapes for the host ↔ iframe stream channel.
 *
 * Scoped under the vendor-extension namespace
 * `ui/extensions/ggui/*`. The MCP Apps spec reserves `ui/*` for
 * future first-class additions; vendor extensions live under
 * `ui/extensions/<vendor>/<method>` so they don't collide.
 *
 * Two directions, four methods:
 *
 *   iframe → host
 *     - `stream-subscribe`   announce a channel on mount / resubscribe
 *     - `stream-unsubscribe` drop a channel
 *
 *   host → iframe
 *     - `stream-frame`       deliver one payload from WS or poll
 *     - `stream-error`       subscription failed (auth / tool missing)
 *
 * All four envelopes follow the JSON-RPC notification convention used
 * elsewhere in MCP Apps: `{jsonrpc: '2.0', method, params}`. No `id`
 * because these are notifications — neither party expects a reply.
 *
 * Targeting: per-iframe routing is browser-enforced by addressing the
 * specific `iframe.contentWindow.postMessage(...)` recipient. No
 * per-frame filter code on either side.
 *
 * @public
 */

import type { JsonObject, JsonValue, StreamEnvelope } from '@ggui-ai/protocol';

/**
 * iframe → host: announce a channel subscription. Sent on every mount
 * + on every reconnect after a temporary disconnect. Re-sending is
 * server-side idempotent (the host's subscription manager replaces
 * in place; the `ChannelSubscriptionState` on the ggui server is also
 * idempotent — see channel-transport.ts).
 *
 * `tool` is the `streamSpec[channel].source.tool` name. The host's
 * routing logic uses this + `serverCapabilities.streamWebSocketLocalTools`
 * to pick WS-subscribe vs `tools/call`-poll per channel.
 *
 * `mode` mirrors `streamSpec[channel].mode` — replay buffering and
 * delivery semantics are owned by the server / iframe; the host just
 * forwards.
 *
 * `args` are merged into every `tools/call` (poll path) and into the
 * `channel_subscribe` frame's `args` field (WS path). Match
 * `streamSpec[channel].args` verbatim.
 */
export interface StreamSubscribeNotification {
  readonly jsonrpc: '2.0';
  readonly method: 'ui/extensions/ggui/stream-subscribe';
  readonly params: {
    readonly sessionId: string;
    readonly channel: string;
    readonly tool: string;
    readonly args?: JsonObject;
    readonly mode?: StreamEnvelope['mode'];
    /**
     * Optional per-channel poll cadence override. Mirrors
     * `streamSpec[channel].pollIntervalMs`. When absent, the host
     * picks its default (see `DEFAULT_HOST_POLL_INTERVAL_MS`).
     */
    readonly pollIntervalMs?: number;
  };
}

/**
 * iframe → host: drop a subscription. Rare — most iframes leave
 * subscriptions in place across re-renders and let
 * iframe-element removal trigger cleanup via the host's lifecycle.
 *
 * The host MUST tolerate unsubscribe for a channel that was never
 * subscribed (idempotent).
 */
export interface StreamUnsubscribeNotification {
  readonly jsonrpc: '2.0';
  readonly method: 'ui/extensions/ggui/stream-unsubscribe';
  readonly params: {
    readonly sessionId: string;
    readonly channel: string;
  };
}

/**
 * host → iframe: one payload frame for a subscribed channel.
 *
 * `payload` is the tool's output, validated against
 * `streamSpec[channel].schema` server-side (WS path) or trusted as
 * the tool's return value (poll path). Iframe-runtime's bus emits
 * this to `useStream(channel)` consumers.
 *
 * `seq` is optional but recommended — lets the iframe detect
 * out-of-order delivery (which shouldn't happen but is cheap to
 * verify). When the host can't supply a stable seq (e.g., poll
 * path), it MAY omit the field.
 *
 * `completed: true` signals the subscription has ended naturally
 * (stream completed). The iframe MAY drop the subscription locally
 * — the host does the same.
 */
export interface StreamFrameNotification {
  readonly jsonrpc: '2.0';
  readonly method: 'ui/extensions/ggui/stream-frame';
  readonly params: {
    readonly sessionId: string;
    readonly channel: string;
    readonly payload: JsonValue;
    readonly seq?: number;
    readonly completed?: boolean;
  };
}

/**
 * host → iframe: subscription failed (auth rejected, tool not found,
 * server error, etc.). The iframe MAY surface this in a
 * channel-specific error state via `useStream(channel).error`.
 *
 * `code` is one of a small enumerated set so the iframe can branch
 * without parsing prose. Hosts that introduce new failure modes
 * SHOULD extend this enum and bump the wire docs.
 */
export interface StreamErrorNotification {
  readonly jsonrpc: '2.0';
  readonly method: 'ui/extensions/ggui/stream-error';
  readonly params: {
    readonly sessionId: string;
    readonly channel: string;
    readonly code:
      | 'tool_not_found'
      | 'auth_rejected'
      | 'transport_failed'
      | 'subscription_dropped'
      | 'internal_error';
    readonly message: string;
  };
}

/** Discriminated union for any envelope on this channel. */
export type GguiStreamExtensionEnvelope =
  | StreamSubscribeNotification
  | StreamUnsubscribeNotification
  | StreamFrameNotification
  | StreamErrorNotification;

/**
 * Type guards. Centralized so iframe-runtime + host-streams agree
 * on the recognition logic. Strict — every required field MUST be
 * present + correctly typed.
 */
export function isStreamExtensionEnvelope(
  value: unknown,
): value is GguiStreamExtensionEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v['jsonrpc'] !== '2.0') return false;
  const method = v['method'];
  if (typeof method !== 'string') return false;
  return (
    method === 'ui/extensions/ggui/stream-subscribe' ||
    method === 'ui/extensions/ggui/stream-unsubscribe' ||
    method === 'ui/extensions/ggui/stream-frame' ||
    method === 'ui/extensions/ggui/stream-error'
  );
}

/**
 * Recognize a frame from the host (iframe-side consumer). Use this
 * before downcasting to `StreamFrameNotification.params`.
 */
export function isStreamFrameNotification(
  value: unknown,
): value is StreamFrameNotification {
  if (!isStreamExtensionEnvelope(value)) return false;
  return value.method === 'ui/extensions/ggui/stream-frame';
}

/**
 * Recognize a subscribe announcement from the iframe (host-side
 * consumer).
 */
export function isStreamSubscribeNotification(
  value: unknown,
): value is StreamSubscribeNotification {
  if (!isStreamExtensionEnvelope(value)) return false;
  return value.method === 'ui/extensions/ggui/stream-subscribe';
}
