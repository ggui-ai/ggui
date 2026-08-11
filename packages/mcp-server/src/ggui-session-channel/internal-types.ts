/**
 * Internal shared types for the live-channel handler modules. NOT part
 * of the package's public surface — everything publishable is exported
 * (or re-exported) from `../ggui-session-channel.ts`.
 */

import type { AuthResult, BufferedStreamEnvelope } from "@ggui-ai/mcp-server-core";
import type { JsonObject } from "@ggui-ai/protocol";
import type { WebSocketMessage } from "@ggui-ai/protocol/transport/websocket";
import type { WebSocket } from "ws";

/**
 * Transport-neutral write surface for one subscriber's outbound plane.
 * The fan-out walks (`props_update` / `render` / `drain_ack` / external
 * broadcasts), the live-tail pump, and the subscribe tail all write
 * through this seam so a subscriber can ride WS (`createWsSink`) or SSE
 * (`SseSink` in `../api-renders-stream-route.ts`) without per-frame
 * transport branching.
 */
export interface SubscriberSink {
  /** WS: `ws.readyState === OPEN`; SSE: `!res.writableEnded && !res.destroyed`. */
  isOpen(): boolean;
  /**
   * Write one wire frame. `resumeId` is the durable-cursor stamp for
   * ledger-backed replay frames: SSE emits it as the `id:` field ahead
   * of `data:` (so the browser's `Last-Event-ID` lands on the
   * GguiSessionEvent ledger cursor); WS ignores it — WS resume rides
   * `SubscribePayload.sinceSequence` instead.
   */
  write(frame: WebSocketMessage, opts?: { readonly resumeId?: string }): void;
  /**
   * Terminate the transport. WS maps `service_restart` → close 1012
   * (reconnect immediately — same server family is still up) and
   * `session_expired` → close 1008 (policy violation — do not blind-
   * reconnect); SSE ends the response, letting `EventSource`
   * auto-reconnect hit the HTTP pre-gate for the authoritative verdict.
   */
  end(reason: "service_restart" | "session_expired"): void;
}

/**
 * Fields shared by every subscriber regardless of transport (one
 * client, one render). Held live in the channel's flat subscriber set;
 * torn down on transport close or explicit `close` message.
 */
interface SubscriberBase {
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
   * the StreamFanout. `unregister(sub)` is the single point that
   * does this teardown.
   */
  readonly iter: AsyncIterator<BufferedStreamEnvelope>;
  /**
   * Active `channel_subscribe` polling loops for this subscriber.
   * Keyed by `${sessionId}:${channelName}` so a reconnect that
   * re-subscribes to the same (render, channel) pair replaces the
   * existing timer rather than minting a duplicate (idempotent
   * semantics on the wire). Torn down en masse by `unregister(sub)`
   * on transport close.
   *
   * Populated by the `channel_subscribe` handler when the composing
   * host wired a `streamWebSocketLocalTools` allowlist; empty
   * otherwise. SSE subscribers have no inbound channel, so theirs
   * stays empty structurally.
   */
  readonly channelSubs: Map<string, ChannelSubscriptionState>;
  /** Outbound write surface — the ONLY transport coupling on the fan-out path. */
  readonly sink: SubscriberSink;
}

/**
 * WebSocket-attached subscriber. The `ws` handle stays for the inbound
 * / control planes (socket-router dispatch, action acks, subscribe
 * rejects) which remain WS-only — SSE has no inbound channel.
 */
export interface WsSubscriber extends SubscriberBase {
  readonly transport: "ws";
  readonly ws: WebSocket;
}

/**
 * SSE-attached subscriber (`GET /api/sessions/:sessionId/stream`),
 * registered via `GguiSessionChannelServer.attachExternalSubscriber`.
 * Outbound-only: it shares the fan-out planes with WS subscribers but
 * never appears in the ws→subscriber reverse index.
 */
export interface SseSubscriber extends SubscriberBase {
  readonly transport: "sse";
}

/** A single connected subscriber, discriminated on `transport`. */
export type Subscriber = WsSubscriber | SseSubscriber;

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
