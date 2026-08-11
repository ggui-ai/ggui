/**
 * Per-socket message routing + WS lifecycle wiring for the live
 * channel — the `connection` handler (with the per-socket inbound
 * ordering chain), the pre-subscribe identity / cookie bindings, the
 * `onMessage` type dispatcher, and the observation-message ingress
 * (`host_context_observed`) it routes.
 */

import type { GguiSessionPatch, GguiSessionStore } from "@ggui-ai/mcp-server-core";
import type { AuthResult } from "@ggui-ai/mcp-server-core";
import type { WebSocketMessage } from "@ggui-ai/protocol/transport/websocket";
import type { IncomingMessage } from "node:http";
import type { WebSocket, WebSocketServer } from "ws";
import type { Logger } from "../logger.js";
import type { ActionIngress } from "./action-ingress.js";
import type { ChannelSubscriptions } from "./channel-subscriptions.js";
import type { UpgradeBindings, WsSubscriber } from "./internal-types.js";
import type { Outbound } from "./outbound.js";
import type { SubscribeHandlers } from "./subscribe.js";
import type { SubscriberLifecycle } from "./subscriber-lifecycle.js";

/**
 * Monotonic counters for pre-subscribe cap-driven closures/refusals.
 * The channel server owns the object (so its health getter can read a
 * live snapshot) and hands the same reference to the router, which
 * increments a field on every enforced cap. See {@link PreSubscribeCaps}.
 */
export interface PreSubscribeRejectionCounters {
  /** Oversized pre-subscribe frames rejected (1009). */
  payload: number;
  /** Pre-subscribe sockets closed for exceeding the idle window (1008). */
  idle: number;
  /** Upgrades refused for exceeding the pre-subscribe connection ceiling (1013). */
  connection: number;
}

/**
 * Resolved pre-subscribe cap thresholds (ggui#444). Each bounds only
 * what a NOT-YET-SUBSCRIBED (unauthenticated / unregistered) socket can
 * consume — a socket that has completed a valid `subscribe` is a
 * legitimate long-lived subscriber and is exempt from all three. A
 * value of `0` disables that cap.
 */
export interface PreSubscribeCaps {
  /** Per-frame byte ceiling on pre-subscribe frames. 0 = disabled. */
  readonly maxPayloadBytes: number;
  /** Idle window (ms) a socket has to complete a valid subscribe. 0 = disabled. */
  readonly idleMs: number;
  /** Concurrent pending (pre-subscribe) socket ceiling. 0 = disabled. */
  readonly maxConnections: number;
}

export interface SocketRouterDeps {
  readonly logger: Logger;
  /** GguiSession backing store — observation-message patches persist here. */
  readonly renderStore: GguiSessionStore;
  /**
   * ws → subscriber reverse index — the dispatcher's per-frame lookup.
   * WS-only by construction (the lifecycle module populates it for
   * `transport: 'ws'` subscribers only); SSE subscribers have no
   * inbound socket to route.
   */
  readonly subscribersByWs: WeakMap<WebSocket, WsSubscriber>;
  readonly send: Outbound["send"];
  readonly sendError: Outbound["sendError"];
  readonly unregister: SubscriberLifecycle["unregister"];
  readonly handleSubscribe: SubscribeHandlers["handleSubscribe"];
  readonly handleInboundAction: ActionIngress["handleInboundAction"];
  readonly handleChannelSubscribe: ChannelSubscriptions["handleChannelSubscribe"];
  readonly handleChannelUnsubscribe: ChannelSubscriptions["handleChannelUnsubscribe"];
  /** Resolved pre-subscribe cap thresholds (ggui#444). */
  readonly preSubscribeCaps: PreSubscribeCaps;
  /** Shared monotonic counters incremented on each enforced cap. */
  readonly preSubscribeRejections: PreSubscribeRejectionCounters;
}

/**
 * Wire the channel's `connection` handling onto `wss`. Reads the
 * upgrade-time identity / cookie bindings the upgrade phase stashed on
 * the request (see {@link UpgradeBindings}) and serializes inbound
 * frame processing per socket.
 */
export function attachSocketRouter(wss: WebSocketServer, deps: SocketRouterDeps): void {
  const { preSubscribeCaps: caps, preSubscribeRejections: rejections } = deps;

  // --- Pre-subscribe cap state (ggui#444) -------------------------------
  //
  // These bound what a socket can consume BEFORE it completes a valid
  // `subscribe`. The distinguishing signal is `subscribersByWs.get(ws)`:
  // unset = pre-subscribe (bounded), set = registered subscriber
  // (exempt). All three caps target the pre-subscribe window only.

  /** Live count of PENDING (pre-subscribe) sockets — never counts subscribers. */
  let preSubscribeCount = 0;
  /** Sockets currently counted against {@link preSubscribeCount}. */
  const countedPending = new WeakSet<WebSocket>();
  /** Per-socket idle-timeout handle, cleared on subscribe or close. */
  const idleTimers = new WeakMap<WebSocket, ReturnType<typeof setTimeout>>();
  /**
   * Sockets already closed for the pre-subscribe payload cap. A single
   * abusive burst can deliver several oversized frames in one read
   * before `ws.close()` settles the connection (each already-parsed
   * frame still fires its own `message` event); without this guard
   * every one of them would re-run the payload branch and re-increment
   * `rejections.payload` for what is really one abusive socket. Holds
   * no resource of its own, so it needs no explicit cleanup — the
   * entry is collected once the socket is.
   */
  const payloadRejected = new WeakSet<WebSocket>();
  /**
   * Deduped cap-hit log keys. Capped so a flood cannot grow the set
   * without bound; after the cap, rejections still enforce + count —
   * they just stop logging. Mirrors the origin-rejection warn pattern.
   */
  const warnedCaps = new Set<string>();

  function warnCapOnce(event: string, fields: Record<string, number>): void {
    if (!warnedCaps.has(event) && warnedCaps.size < 100) {
      warnedCaps.add(event);
      deps.logger.warn(event, fields);
    }
  }

  /** Drop a socket out of the pending count exactly once. */
  function releasePending(ws: WebSocket): void {
    if (countedPending.has(ws)) {
      countedPending.delete(ws);
      preSubscribeCount -= 1;
    }
  }

  function clearIdleTimer(ws: WebSocket): void {
    const timer = idleTimers.get(ws);
    if (timer !== undefined) {
      clearTimeout(timer);
      idleTimers.delete(ws);
    }
  }

  /**
   * A socket that has become a registered subscriber is a legitimate
   * long-lived connection: disarm its idle timer and stop counting it
   * against the pre-subscribe ceiling. Idempotent.
   */
  function markSubscribed(ws: WebSocket): void {
    clearIdleTimer(ws);
    releasePending(ws);
  }

  /**
   * Tenancy guard for client-emitted observation messages
   * (`host_context_observed` today). Returns `false`
   * AND emits the appropriate error frame when:
   *
   *   - the socket has no bound subscriber (NOT_SUBSCRIBED)
   *   - payload.sessionId doesn't match the subscriber binding
   *     (SESSION_MISMATCH)
   *
   * Subscriber binding is the authoritative tenancy scope. The wire
   * payload's sessionId is belt-and-suspenders so the error message
   * can be specific; appId narrows transparently via the binding.
   */
  function checkSubscriberTenancy(
    ws: WebSocket,
    sub: WsSubscriber | undefined,
    payload: { readonly sessionId?: string },
    messageType: string,
    requestId?: string
  ): sub is WsSubscriber {
    if (!sub) {
      deps.sendError(
        ws,
        "NOT_SUBSCRIBED",
        `Send a 'subscribe' message first before '${messageType}'`,
        requestId
      );
      return false;
    }
    if (payload.sessionId !== sub.sessionId) {
      deps.sendError(
        ws,
        "SESSION_MISMATCH",
        `${messageType} payload id '${
          payload.sessionId ?? "<missing>"
        }' does not match subscriber render '${sub.sessionId}'`,
        requestId
      );
      return false;
    }
    return true;
  }

  /**
   * Persist an observation-message-driven render patch. Fire-and-
   * forget at the wire layer (no response frame); warn-logs persistence
   * errors so transient store failures stay observable without
   * disrupting the iframe. The iframe's local state is already in the
   * new shape; the next round-trip re-emits whatever the persistence
   * layer lost.
   */
  async function applyGguiSessionPatch(
    sessionId: string,
    appId: string,
    messageType: string,
    patch: GguiSessionPatch
  ): Promise<void> {
    try {
      await deps.renderStore.update(sessionId, patch);
    } catch (err) {
      deps.logger.warn("render_channel_observation_persist_failed", {
        messageType,
        sessionId,
        appId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function onMessage(ws: WebSocket, raw: string): Promise<void> {
    const sub = deps.subscribersByWs.get(ws);
    // Pre-subscribe per-frame payload cap. Bounds what a not-yet-
    // subscribed (unauthenticated / unregistered) socket can buffer per
    // frame. Subscribed sockets are exempt — their `action` frames have
    // no protocol-level max size and are governed only by the coarse,
    // global ws-level `maxPayload` memory backstop (see
    // DEFAULT_WS_MAX_PAYLOAD_BYTES for its sizing rationale), never this
    // tight handshake-sized ceiling. Measured before JSON.parse so a
    // giant frame is dropped without being interpreted.
    if (sub === undefined && caps.maxPayloadBytes > 0) {
      // Already closed this socket for this cap: a same-segment burst
      // can still deliver more already-parsed frames before
      // `ws.close()` settles the connection. Drop them silently — one
      // abusive socket is one rejection, not one per queued frame.
      if (payloadRejected.has(ws)) {
        return;
      }
      if (Buffer.byteLength(raw, "utf8") > caps.maxPayloadBytes) {
        payloadRejected.add(ws);
        rejections.payload += 1;
        warnCapOnce("render_channel_pre_subscribe_payload_rejected", {
          limitBytes: caps.maxPayloadBytes,
        });
        try {
          ws.close(1009, "pre_subscribe_payload_exceeded");
        } catch {
          /* best-effort: socket may already be closing */
        }
        return;
      }
    }
    let message: WebSocketMessage;
    try {
      message = JSON.parse(raw) as WebSocketMessage;
    } catch {
      deps.sendError(ws, "INVALID_JSON", "Message is not valid JSON");
      return;
    }
    if (!message || typeof message !== "object" || typeof message.type !== "string") {
      deps.sendError(ws, "INVALID_MESSAGE", "Message is missing a `type` discriminator");
      return;
    }

    switch (message.type) {
      case "subscribe": {
        // `subscribe` is the only message allowed before identity is
        // bound to a render. Identity was already resolved at upgrade
        // time; we just need to register the subscriber.
        const identity = pendingIdentity.get(ws);
        if (!identity) {
          deps.sendError(
            ws,
            "UNAUTHENTICATED",
            "No identity bound to this socket",
            message.requestId
          );
          return;
        }
        // Cookie-scope enforcement: when the upgrade was authenticated
        // via an console cookie, the subscribe payload MUST target
        // the render the cookie was issued for. A valid cookie for
        // render A can't be used to open render B.
        const cookieBound = pendingCookieBinding.get(ws);
        if (cookieBound) {
          if (message.payload.sessionId !== cookieBound.sessionId) {
            deps.sendError(
              ws,
              "DEVTOOL_COOKIE_SESSION_MISMATCH",
              `Embedded-ui cookie is bound to render '${cookieBound.sessionId}' but subscribe targets '${message.payload.sessionId}'`,
              message.requestId
            );
            return;
          }
          // `appId` is optional on the wire (SPEC §12.2): absent
          // resolves to the cookie's bound appId inside
          // `handleSubscribe` — only a PRESENT contradicting value is
          // a mismatch.
          if (message.payload.appId !== undefined && message.payload.appId !== cookieBound.appId) {
            deps.sendError(
              ws,
              "DEVTOOL_COOKIE_APP_MISMATCH",
              `Embedded-ui cookie is bound to app '${cookieBound.appId}' but subscribe targets '${message.payload.appId}'`,
              message.requestId
            );
            return;
          }
        }
        await deps.handleSubscribe(ws, identity, message, cookieBound);
        pendingIdentity.delete(ws);
        pendingCookieBinding.delete(ws);
        // A successful subscribe registers the subscriber (sets
        // `subscribersByWs`). Only then does the socket graduate out of
        // the pre-subscribe window: disarm its idle timer + free its
        // ceiling slot. A REJECTED subscribe leaves it pending, so it
        // stays bounded (and reapable) exactly as before.
        if (deps.subscribersByWs.get(ws) !== undefined) {
          markSubscribed(ws);
        }
        return;
      }
      case "ping":
        deps.send(ws, {
          type: "pong",
          payload: {},
          ...(message.requestId ? { requestId: message.requestId } : {}),
        });
        return;
      case "action":
        if (!sub) {
          deps.sendError(
            ws,
            "NOT_SUBSCRIBED",
            "Send a 'subscribe' message first before 'action'",
            message.requestId
          );
          return;
        }
        await deps.handleInboundAction(ws, sub, message);
        return;
      case "channel_subscribe":
        if (!sub) {
          deps.sendError(
            ws,
            "NOT_SUBSCRIBED",
            "Send a 'subscribe' message first before 'channel_subscribe'",
            message.requestId
          );
          return;
        }
        await deps.handleChannelSubscribe(ws, sub, message);
        return;
      case "channel_unsubscribe":
        if (!sub) {
          // No subscriber → nothing was subscribed → no-op silently.
          // Returning an error would leak "is this socket subscribed"
          // state for unauthenticated clients.
          return;
        }
        deps.handleChannelUnsubscribe(ws, sub, message);
        return;
      case "host_context_observed":
        // The iframe-runtime echoes its captured `McpUiHostContext`
        // after `ui/initialize` resolves and on every
        // `ui/notifications/host-context-changed` notification. Persist
        // on `GguiSession.hostContext` so `ggui_handshake` and
        // `ggui_consume` can surface it to the agent on subsequent
        // turns. Fire-and-forget on the client side; no response.
        if (!checkSubscriberTenancy(ws, sub, message.payload, message.type, message.requestId)) {
          return;
        }
        await applyGguiSessionPatch(sub.sessionId, sub.appId, message.type, {
          hostContext: message.payload.hostContext,
          lastActivityAt: Date.now(),
        });
        return;
      default:
        deps.sendError(
          ws,
          "UNSUPPORTED_MESSAGE",
          `Unsupported message type: ${String((message as WebSocketMessage).type)}`,
          message.requestId
        );
    }
  }

  /**
   * During the pre-subscribe window, a ws has a resolved identity but
   * no render-bound subscriber yet. We hold the identity here until
   * the first `subscribe` lands; once it does, the subscriber record
   * owns the identity and this entry is cleared.
   */
  const pendingIdentity = new WeakMap<WebSocket, AuthResult>();
  /**
   * Embedded-ui cookie binding established at upgrade. When present,
   * `handleSubscribe` enforces `subscribe.sessionId === bound.sessionId`
   * so a valid cookie can't be used to open a render it wasn't
   * issued for. Parallel to {@link pendingIdentity} — same lifetime,
   * same WeakMap rationale.
   */
  const pendingCookieBinding = new WeakMap<WebSocket, { sessionId: string; appId: string }>();

  wss.on("connection", (ws, req) => {
    // Pre-subscribe connection ceiling. Count only sockets that have
    // NOT yet completed a valid subscribe — legitimate subscriber
    // fan-out can be large and is never bounded here. Beyond the
    // ceiling the socket is cleanly closed (1013 "try again later")
    // without wiring any per-socket handlers or consuming a slot.
    if (caps.maxConnections > 0 && preSubscribeCount >= caps.maxConnections) {
      rejections.connection += 1;
      warnCapOnce("render_channel_pre_subscribe_connection_rejected", {
        limit: caps.maxConnections,
      });
      // This early-return path skips the normal per-socket wiring below,
      // so attach a minimal `error` listener first: a `ws` is an
      // EventEmitter and an unhandled `error` (a refused peer resetting
      // mid-close is the likely case here) would otherwise crash the
      // process — the abuse path must never take the server down.
      ws.on("error", (err) => {
        deps.logger.warn("render_channel_socket_error", { error: String(err) });
      });
      try {
        ws.close(1013, "pre_subscribe_connection_ceiling");
      } catch {
        /* best-effort: socket may already be closing */
      }
      return;
    }
    preSubscribeCount += 1;
    countedPending.add(ws);

    // Pre-subscribe idle timeout. A socket that never completes a valid
    // subscribe within the window is closed (1008). Armed here, cleared
    // in `markSubscribed` on a successful subscribe, so a subscribed
    // (long-idle / reconnecting) viewer is never reaped. `.unref()` so a
    // pending timer never keeps the process alive on its own.
    if (caps.idleMs > 0) {
      const timer = setTimeout(() => {
        idleTimers.delete(ws);
        if (deps.subscribersByWs.get(ws) === undefined) {
          rejections.idle += 1;
          warnCapOnce("render_channel_pre_subscribe_idle_closed", {
            idleMs: caps.idleMs,
          });
          try {
            ws.close(1008, "pre_subscribe_idle_timeout");
          } catch {
            /* best-effort: socket may already be closing */
          }
        }
      }, caps.idleMs);
      timer.unref?.();
      idleTimers.set(ws, timer);
    }

    // Bind the resolved identity from the upgrade phase. It was
    // attached to the request object in handleUpgrade.
    const identity = (req as IncomingMessage & UpgradeBindings).__gguiIdentity;
    if (identity) pendingIdentity.set(ws, identity);
    // Likewise for any cookie binding.
    const cookieBound = (req as IncomingMessage & UpgradeBindings).__gguiCookieBound;
    if (cookieBound) pendingCookieBinding.set(ws, cookieBound);

    // Per-socket inbound processing chain. The WebSocket wire is an
    // ORDERED frame stream, so inbound handling must observe arrival
    // order even though the handlers are async: without the chain, a
    // client that pipelines `subscribe` + `action` in one TCP segment
    // (both `message` events fire in the same macrotask) gets the
    // action handled while `handleSubscribe` is parked at its first
    // `await` — the socket has no bound subscriber yet, and a
    // correctly-ordered client is rejected with NOT_SUBSCRIBED.
    // Serializing per socket restores the wire's ordering on the
    // processing side; distinct sockets stay fully concurrent.
    let inboundChain: Promise<void> = Promise.resolve();
    ws.on("message", (raw) => {
      // `ws.on('message')` delivers Buffer/ArrayBuffer/Buffer[] depending
      // on frame type; normalize to string.
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      inboundChain = inboundChain.then(() =>
        onMessage(ws, text).catch((err) => {
          // Catch INSIDE the chain link so one failed message never
          // poisons the chain for subsequent frames.
          deps.logger.error("render_channel_message_failed", {
            error: String(err),
          });
        })
      );
    });

    ws.on("close", () => {
      // Resolve the subscriber bound to this socket (if any) before
      // tearing it down — `unregister` is subscriber-keyed now that
      // the lifecycle module is transport-neutral.
      const closedSub = deps.subscribersByWs.get(ws);
      if (closedSub) deps.unregister(closedSub);
      pendingIdentity.delete(ws);
      // A pending socket that closes before subscribing frees its idle
      // timer + ceiling slot. For a socket that already subscribed,
      // `markSubscribed` cleared both — these are then no-ops.
      clearIdleTimer(ws);
      releasePending(ws);
    });

    ws.on("error", (err) => {
      deps.logger.warn("render_channel_socket_error", { error: String(err) });
    });
  });
}
