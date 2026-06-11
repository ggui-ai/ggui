/**
 * `channel_subscribe` / source-poll family for the live channel —
 * server-side polling of `streamSpec[ch].source.tool` for the subset
 * of tools the operator listed on `streamWebSocketLocalTools`, fanned
 * to the subscriber as `channel_payload` frames. Includes the
 * symmetric `channel_unsubscribe` handler; WS close tears down any
 * remaining polling loops via the subscriber-lifecycle module.
 */

import type { GguiSessionStore } from "@ggui-ai/mcp-server-core";
import { sanitizeCausedBy } from "@ggui-ai/protocol";
import type { JsonObject, StreamSpec } from "@ggui-ai/protocol";
import type { WebSocketMessage } from "@ggui-ai/protocol/transport/websocket";
import type { WebSocket } from "ws";
import type { Logger } from "../logger.js";
import type { ChannelSubscriptionState, Subscriber } from "./internal-types.js";
import type { Outbound } from "./outbound.js";

/**
 * Default + boundary cadence for the channel-subscribe polling loop.
 * Server-authoritative: clients propose `pollIntervalMs` on
 * `channel_subscribe`, server clamps to [floorMs, ceilingMs] and
 * defaults to `defaultMs` when absent. Conservative defaults — operators
 * tune via {@link GguiSessionChannelLocalToolsOptions.pollCadence}.
 */
const DEFAULT_CHANNEL_POLL_FLOOR_MS = 1_000;
const DEFAULT_CHANNEL_POLL_CEILING_MS = 60_000;
const DEFAULT_CHANNEL_POLL_DEFAULT_MS = 10_000;

/**
 * Opt-in plumbing for the `channel_subscribe` polling loop. When this
 * field is set on `GguiSessionChannelOptions`, channel subscribes
 * whose `source.tool` is in {@link allowlist} are accepted and the
 * server begins polling. When absent, every `channel_subscribe`
 * returns `CHANNEL_NOT_LOCAL` so the iframe falls back to direct
 * polling via the MCP host proxy.
 */
export interface GguiSessionChannelLocalToolsOptions {
  /**
   * Whitelist of `source.tool` names this channel can poll. Must mirror
   * the value the host advertises on
   * `handshake.serverCapabilities.streamWebSocketLocalTools` so the
   * iframe + server agree on which channels use the WS fan-out path.
   * Tools NOT in this list are rejected with `CHANNEL_NOT_LOCAL` (the
   * iframe falls back to direct polling).
   */
  readonly allowlist: readonly string[];
  /**
   * Synchronous resolver invoked at poll time. Returns the tool's
   * structured output (validated against `streamSpec[ch].schema`
   * client-side; server-side schema validation is deferred to the
   * future `validateContract` slice). Implementations typically
   * delegate to the same in-process tool registry that backs `/mcp`.
   *
   * Throwing surfaces `POLL_FAILED` on the subscriber's
   * `channel_error` channel without canceling the poll loop —
   * transient tool failures are recoverable.
   */
  invoke(name: string, input: unknown): Promise<unknown>;
  /**
   * Optional poll cadence policy. `defaultMs` applies when the client
   * doesn't supply a `pollIntervalMs`; `floorMs`/`ceilingMs` clamp
   * client-supplied values. Defaults:
   * `{floorMs: 1000, ceilingMs: 60000, defaultMs: 10000}`.
   */
  readonly pollCadence?: {
    readonly floorMs?: number;
    readonly ceilingMs?: number;
    readonly defaultMs?: number;
  };
}

export interface ChannelSubscriptionsDeps {
  readonly logger: Logger;
  readonly renderStore: GguiSessionStore;
  /**
   * Channel-subscribe local-tool poll plumbing, straight from
   * `GguiSessionChannelOptions.streamWebSocketLocalTools`. Absent ⇒
   * all channel subscribes reject with `CHANNEL_NOT_LOCAL`.
   */
  readonly localTools: GguiSessionChannelLocalToolsOptions | undefined;
  /**
   * ws → subscriber reverse index — the zombie-timer guard reads it at
   * callback fire-time to self-clean intervals that outlived their
   * subscriber.
   */
  readonly subscribersByWs: WeakMap<WebSocket, Subscriber>;
  readonly send: Outbound["send"];
  readonly sendChannelError: Outbound["sendChannelError"];
}

export interface ChannelSubscriptions {
  /**
   * Handle a `channel_subscribe` message. Validates the request,
   * resolves the channel's `source.tool` against the configured
   * allowlist, and schedules a polling loop. Idempotent on
   * `${sessionId}:${channelName}` — a re-subscribe replaces any
   * existing interval rather than running two in parallel.
   */
  handleChannelSubscribe(
    ws: WebSocket,
    sub: Subscriber,
    message: WebSocketMessage & { type: "channel_subscribe" }
  ): Promise<void>;
  /**
   * Handle a `channel_unsubscribe` message. Idempotent: a no-op
   * unsubscribe on an unknown channelKey returns silently. WS close
   * implicitly unsubscribes every channel; this message is for
   * mid-session cancellation.
   */
  handleChannelUnsubscribe(
    ws: WebSocket,
    sub: Subscriber,
    message: WebSocketMessage & { type: "channel_unsubscribe" }
  ): void;
}

export function createChannelSubscriptions(deps: ChannelSubscriptionsDeps): ChannelSubscriptions {
  // Poll plumbing resolved once at composition so the
  // `channel_subscribe` handler doesn't pay the option-spread cost per
  // request.
  const localTools = deps.localTools;
  const localToolsAllowlist: ReadonlySet<string> = localTools
    ? new Set(localTools.allowlist)
    : new Set();
  const pollFloorMs = localTools?.pollCadence?.floorMs ?? DEFAULT_CHANNEL_POLL_FLOOR_MS;
  const pollCeilingMs = localTools?.pollCadence?.ceilingMs ?? DEFAULT_CHANNEL_POLL_CEILING_MS;
  const pollDefaultMs = localTools?.pollCadence?.defaultMs ?? DEFAULT_CHANNEL_POLL_DEFAULT_MS;

  /**
   * Clamp a client-supplied `pollIntervalMs` against the configured
   * floor / ceiling. Absent (or non-finite) ⇒ default. Server is
   * authoritative per the `ChannelSubscribePayload.pollIntervalMs`
   * docstring — clients propose, server clamps.
   */
  function clampPollInterval(supplied: number | undefined): number {
    if (typeof supplied !== "number" || !Number.isFinite(supplied)) {
      return pollDefaultMs;
    }
    if (supplied < pollFloorMs) return pollFloorMs;
    if (supplied > pollCeilingMs) return pollCeilingMs;
    return supplied;
  }

  /**
   * Run one poll of `state.toolName` and fan its result onto the
   * subscriber's WS as a `channel_payload`. Throws never escape — a
   * thrown invocation surfaces as a `channel_error{code:'POLL_FAILED'}`
   * but the polling loop keeps running so transient tool failures are
   * recoverable.
   *
   * Tool registry is guaranteed-present by the caller — channel
   * subscribes whose `source.tool` isn't in `localTools.allowlist`
   * never reach this function.
   */
  async function pollChannelOnce(sub: Subscriber, state: ChannelSubscriptionState): Promise<void> {
    if (!localTools) return;
    if (sub.ws.readyState !== sub.ws.OPEN) return;
    try {
      const output = await localTools.invoke(state.toolName, state.args);
      // Skip emission if the socket closed during the poll — closing-
      // raced timers fire at most once, and emitting onto a closing
      // socket is a `send_failed` warning at best.
      if (sub.ws.readyState !== sub.ws.OPEN) return;
      state.seq += 1;
      deps.send(sub.ws, {
        type: "channel_payload",
        payload: {
          sessionId: sub.sessionId,
          appId: sub.appId,
          channelName: state.channelName,
          seq: state.seq,
          ts: new Date().toISOString(),
          // Default mode for source-fed channels is `replace` — each
          // poll is a fresh snapshot, not a delta. Channels that need
          // append semantics declare `mode: 'append'` on streamSpec;
          // honoring that is the iframe-runtime's concern at fold
          // time. See `ChannelPayloadFrame.mode`.
          mode: "replace",
          payload: output as JsonObject,
        },
      });
    } catch (err) {
      if (sub.ws.readyState !== sub.ws.OPEN) return;
      deps.sendChannelError(
        sub.ws,
        sub.sessionId,
        state.channelName,
        "POLL_FAILED",
        err instanceof Error ? err.message : String(err),
        undefined,
        // causedBy slot — the raw stack is redacted (Bearer tokens,
        // query-param secrets, env-var dumps, 2 KB truncation) before
        // it reaches the wire; raw `err.stack` verbatim is a
        // credential-leak footgun.
        sanitizeCausedBy(err instanceof Error ? err.stack ?? err.message : String(err))
      );
      deps.logger.warn("render_channel_channel_poll_failed", {
        sessionId: sub.sessionId,
        appId: sub.appId,
        channelName: state.channelName,
        toolName: state.toolName,
        error: String(err),
      });
    }
  }

  async function handleChannelSubscribe(
    ws: WebSocket,
    sub: Subscriber,
    message: WebSocketMessage & { type: "channel_subscribe" }
  ): Promise<void> {
    const payload = message.payload;
    // sessionId match — the spoof guard at every wire-input boundary.
    // A subscriber bound to render A can't drive a subscribe for
    // render B even if they crafted the inbound payload.
    if (payload.sessionId !== sub.sessionId) {
      deps.sendChannelError(
        ws,
        payload.sessionId,
        payload.channelName,
        "SUBSCRIBE_UNAUTHORIZED",
        `Subscriber is bound to render '${sub.sessionId}' but channel_subscribe targets '${payload.sessionId}'`,
        message.requestId
      );
      return;
    }
    // Without an `streamWebSocketLocalTools` allowlist, no channel
    // can be subscribed locally. The iframe must fall back to direct
    // polling via the MCP host proxy.
    if (!localTools) {
      deps.sendChannelError(
        ws,
        payload.sessionId,
        payload.channelName,
        "CHANNEL_NOT_LOCAL",
        "This server has no streamWebSocketLocalTools allowlist; iframe must poll the source tool directly.",
        message.requestId
      );
      return;
    }

    // Phase B: a render IS the addressable unit. The prior
    // reverse-index lookup collapses — `renderStore.get` resolves
    // the render directly.
    const stored = await deps.renderStore.get(payload.sessionId);
    if (!stored || stored.id !== sub.sessionId) {
      deps.sendChannelError(
        ws,
        payload.sessionId,
        payload.channelName,
        "SESSION_NOT_FOUND",
        `GguiSession '${payload.sessionId}' not found on subscriber '${sub.sessionId}'`,
        message.requestId
      );
      return;
    }
    const render = stored.render;
    // Channel entry resolution. mcpApps / system variants have no
    // streamSpec so the field reads back as undefined — same code
    // path as a component variant without the channel declared.
    const streamSpec: StreamSpec | undefined =
      render.type === "mcpApps" || render.type === "system" ? undefined : render.streamSpec;
    const channelEntry = streamSpec?.[payload.channelName];
    if (!channelEntry || !channelEntry.source) {
      deps.sendChannelError(
        ws,
        payload.sessionId,
        payload.channelName,
        "CHANNEL_UNKNOWN",
        `streamSpec['${payload.channelName}'] not declared OR has no source.tool on render '${payload.sessionId}'`,
        message.requestId
      );
      return;
    }
    const sourceTool = channelEntry.source.tool;
    if (!localToolsAllowlist.has(sourceTool)) {
      deps.sendChannelError(
        ws,
        payload.sessionId,
        payload.channelName,
        "CHANNEL_NOT_LOCAL",
        `source.tool '${sourceTool}' is not in streamWebSocketLocalTools; iframe must poll directly`,
        message.requestId
      );
      return;
    }

    // Validation passed — schedule (or re-schedule) the polling loop.
    const channelKey = `${payload.sessionId}:${payload.channelName}`;
    // Idempotent replace: a reconnect that re-subscribes the same
    // (render, channel) pair gets a fresh timer + zeroed seq. The
    // client's gap-detection treats it as a new stream from the
    // server's perspective; client-side reconnect logic owns
    // continuity if the channel was declared `mode: 'append'`.
    const existing = sub.channelSubs.get(channelKey);
    if (existing) {
      clearInterval(existing.timer);
      sub.channelSubs.delete(channelKey);
    }

    const pollIntervalMs = clampPollInterval(payload.pollIntervalMs);
    // Layered args: source.args defines defaults; client args override
    // per ChannelSubscribePayload.args docstring.
    const mergedArgs: JsonObject = {
      ...(channelEntry.source.args ?? {}),
      ...(payload.args ?? {}),
    };

    // Resolve the channelKey lookup at callback fire-time. The
    // timer callback reads `sub.channelSubs.get(channelKey)` so
    // `state` doesn't have to be referenced through a closure
    // before it's actually inserted into the tracker. Also self-
    // cleans on the zombie-timer path: if the subscription was
    // already torn down (channel_unsubscribe / WS close / replace),
    // the lookup returns undefined and we clearInterval ourselves.
    const timer = setInterval(() => {
      const live = sub.channelSubs.get(channelKey);
      if (!live || !deps.subscribersByWs.has(sub.ws)) {
        clearInterval(timer);
        return;
      }
      void pollChannelOnce(sub, live);
    }, pollIntervalMs);

    const state: ChannelSubscriptionState = {
      pollIntervalMs,
      toolName: sourceTool,
      sessionId: payload.sessionId,
      channelName: payload.channelName,
      args: mergedArgs,
      seq: 0,
      timer,
    };
    sub.channelSubs.set(channelKey, state);
    deps.logger.info("render_channel_channel_subscribe", {
      sessionId: sub.sessionId,
      appId: sub.appId,
      channelName: payload.channelName,
      toolName: sourceTool,
      pollIntervalMs,
    });
    // Eager-poll — fire one invocation immediately so the iframe sees
    // an initial value without waiting `pollIntervalMs`. Matches the
    // user-expected "subscribe then see data" cadence; the interval
    // takes over from there.
    void pollChannelOnce(sub, state);
  }

  function handleChannelUnsubscribe(
    _ws: WebSocket,
    sub: Subscriber,
    message: WebSocketMessage & { type: "channel_unsubscribe" }
  ): void {
    const payload = message.payload;
    if (payload.sessionId !== sub.sessionId) {
      // No-op silently — the canonical "spoof guard" code path is in
      // channel_subscribe; unsubscribe gets no error frame to avoid
      // leaking cross-render existence.
      return;
    }
    const channelKey = `${payload.sessionId}:${payload.channelName}`;
    const existing = sub.channelSubs.get(channelKey);
    if (!existing) return;
    clearInterval(existing.timer);
    sub.channelSubs.delete(channelKey);
    deps.logger.info("render_channel_channel_unsubscribe", {
      sessionId: sub.sessionId,
      appId: sub.appId,
      channelName: payload.channelName,
    });
  }

  return { handleChannelSubscribe, handleChannelUnsubscribe };
}
