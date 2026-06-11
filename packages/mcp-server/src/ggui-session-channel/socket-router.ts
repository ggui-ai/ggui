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
import type { Subscriber, UpgradeBindings } from "./internal-types.js";
import type { Outbound } from "./outbound.js";
import type { SubscribeHandlers } from "./subscribe.js";
import type { SubscriberLifecycle } from "./subscriber-lifecycle.js";

export interface SocketRouterDeps {
  readonly logger: Logger;
  /** GguiSession backing store — observation-message patches persist here. */
  readonly renderStore: GguiSessionStore;
  /** ws → subscriber reverse index — the dispatcher's per-frame lookup. */
  readonly subscribersByWs: WeakMap<WebSocket, Subscriber>;
  readonly send: Outbound["send"];
  readonly sendError: Outbound["sendError"];
  readonly unregister: SubscriberLifecycle["unregister"];
  readonly handleSubscribe: SubscribeHandlers["handleSubscribe"];
  readonly handleInboundAction: ActionIngress["handleInboundAction"];
  readonly handleChannelSubscribe: ChannelSubscriptions["handleChannelSubscribe"];
  readonly handleChannelUnsubscribe: ChannelSubscriptions["handleChannelUnsubscribe"];
}

/**
 * Wire the channel's `connection` handling onto `wss`. Reads the
 * upgrade-time identity / cookie bindings the upgrade phase stashed on
 * the request (see {@link UpgradeBindings}) and serializes inbound
 * frame processing per socket.
 */
export function attachSocketRouter(wss: WebSocketServer, deps: SocketRouterDeps): void {
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
    sub: Subscriber | undefined,
    payload: { readonly sessionId?: string },
    messageType: string,
    requestId?: string
  ): sub is Subscriber {
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
        return;
      }
      case "ping":
        deps.send(ws, {
          type: "pong",
          payload: {},
          ...(message.requestId ? { requestId: message.requestId } : {}),
        });
        return;
      case "close":
        // Explicit close from client — unregister + close the socket.
        if (sub) deps.unregister(ws);
        ws.close(1000, "client_close");
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
      deps.unregister(ws);
      pendingIdentity.delete(ws);
    });

    ws.on("error", (err) => {
      deps.logger.warn("render_channel_socket_error", { error: String(err) });
    });
  });
}
