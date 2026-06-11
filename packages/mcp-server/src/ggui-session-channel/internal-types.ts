/**
 * Internal shared types for the live-channel handler modules. NOT part
 * of the package's public surface — everything publishable is exported
 * (or re-exported) from `../ggui-session-channel.ts`.
 */

import type { AuthResult, BufferedStreamEnvelope } from "@ggui-ai/mcp-server-core";
import type { JsonObject } from "@ggui-ai/protocol";
import type { WebSocket } from "ws";

/**
 * A single connected subscriber (one client, one render). Held live in
 * the per-channel subscriber map; torn down on socket close or explicit
 * `close` message.
 */
export interface Subscriber {
  readonly ws: WebSocket;
  readonly sessionId: string;
  readonly appId: string;
  readonly identity: AuthResult;
  readonly connectedAt: number;
  /**
   * Largest outbound `seq` the initial replay (or subscribe snapshot)
   * covered for this subscriber. Live fan-out skips envelopes with
   * `seq <= replayCompletedSeq` to prevent double delivery — those
   * were (or will be) delivered via the replay phase.
   *
   * For fresh subscribers (no `fromSeq`), this is the stream cursor
   * at subscribe time; they never see the pre-existing buffer, only
   * new deliveries.
   */
  readonly replayCompletedSeq: number;
  /**
   * Per-subscriber live-tail iterator from `streamFanout.subscribe`.
   * Owned by the subscriber for its full lifetime; ending it (via
   * `iter.return()`) terminates the pump loop AND unregisters from
   * the StreamFanout. `unregister(ws)` is the single point that
   * does this teardown.
   */
  readonly iter: AsyncIterator<BufferedStreamEnvelope>;
  /**
   * Active `channel_subscribe` polling loops for this subscriber.
   * Keyed by `${sessionId}:${channelName}` so a reconnect that
   * re-subscribes to the same (render, channel) pair replaces the
   * existing timer rather than minting a duplicate (idempotent
   * semantics on the wire). Torn down en masse by `unregister(ws)` on
   * WS close.
   *
   * Populated by the `channel_subscribe` handler when the composing
   * host wired a `streamWebSocketLocalTools` allowlist; empty
   * otherwise.
   */
  readonly channelSubs: Map<string, ChannelSubscriptionState>;
}

/**
 * Per-(subscriber, sessionId, channelName) polling-loop state.
 * Created on `channel_subscribe` accept, torn down on `channel_unsubscribe`
 * / WS close / re-subscribe-replace.
 *
 * Server-side polling of `streamSpec[ch].source.tool` for the
 * subset of tools the operator listed on `streamWebSocketLocalTools`.
 * Channels whose `source.tool` isn't in the allowlist are rejected
 * with `CHANNEL_NOT_LOCAL` so the iframe falls back to direct polling
 * over the MCP host proxy.
 */
export interface ChannelSubscriptionState {
  /** Server-clamped poll cadence in ms (within configured floor/ceiling). */
  readonly pollIntervalMs: number;
  /** Source tool name resolved from `streamSpec[channelName].source.tool`. */
  readonly toolName: string;
  /** GguiSession this subscription is bound to (for fan-out scoping). */
  readonly sessionId: string;
  /** Channel name (key into `streamSpec`). */
  readonly channelName: string;
  /**
   * Merged args used on each poll call. Layered as `{...source.args,
   * ...client.args}` so client wins on key collisions — matches the
   * docstring on `ChannelSubscribePayload.args`.
   */
  readonly args: JsonObject;
  /**
   * Channel-scoped monotonic counter stamped into every
   * `channel_payload` frame's `seq`. Starts at 1 and advances per
   * successful poll for client-side gap detection.
   */
  seq: number;
  /** Active `setInterval` handle — cleared on teardown. */
  readonly timer: ReturnType<typeof setInterval>;
}

/**
 * Upgrade-time piggyback slots on the Node request object — the
 * standard ws per-request pattern. The upgrade phase resolves identity
 * (and, for console-cookie upgrades, the bound render/app) BEFORE the
 * WebSocket exists, stashes them on the request, and the `connection`
 * handler picks them up to seed the pre-subscribe bindings.
 */
export interface UpgradeBindings {
  __gguiIdentity?: AuthResult;
  __gguiCookieBound?: { sessionId: string; appId: string };
}
