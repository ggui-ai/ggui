/**
 * Outbound send / fan-out family for the live channel — the wire-write
 * primitives every handler module shares (`send`, `sendError`,
 * `sendChannelError`) plus the public fan-out surfaces
 * (`sendToGguiSession`, `notifyGguiSessionCommit`, `sendPropsUpdate`,
 * `sendDrainAck`, `externalBroadcast`) the channel server object
 * delegates to.
 *
 * The behavior contracts for the public surfaces (validation posture,
 * replay-buffer stamping, best-effort delivery) are documented on the
 * `GguiSessionChannelServer` interface in `../ggui-session-channel.ts`;
 * inline comments here cover impl-level decisions only.
 */

import type {
  GguiSessionStore,
  GguiSessionStreamBuffer,
  StreamEnvelopeInput,
  StreamFanout,
} from "@ggui-ai/mcp-server-core";
import { assertStreamContract } from "@ggui-ai/mcp-server-handlers/renders";
import type {
  ErrorPayload,
  GguiSession,
  JsonObject,
  ReservedChannelValidator,
  StreamSpec,
} from "@ggui-ai/protocol";
import type { WebSocketMessage } from "@ggui-ai/protocol/transport/websocket";
import type { WebSocket } from "ws";
import type { Logger } from "../logger.js";
import type { Subscriber } from "./internal-types.js";

/** Channel-scoped error codes carried on `channel_error` frames. */
export type ChannelErrorCode =
  | "CHANNEL_UNKNOWN"
  | "CHANNEL_NOT_LOCAL"
  | "SESSION_NOT_FOUND"
  | "SUBSCRIBE_UNAUTHORIZED"
  | "POLL_FAILED";

export interface OutboundDeps {
  readonly logger: Logger;
  /** GguiSession backing store — streamSpec lookups for fan-out validation. */
  readonly renderStore: GguiSessionStore;
  /** Replay buffer — owns seq assignment + bounded replay storage. */
  readonly streamBuffer: GguiSessionStreamBuffer;
  /** Live-tail pub/sub seam for stream-envelope fan-out. */
  readonly streamFanout: StreamFanout;
  /**
   * Flat set of all live WS subscribers — shared with the
   * subscriber-lifecycle module (which owns membership); read-only
   * here. Direct-to-WS frames (`props_update`, `render`, `drain_ack`,
   * external broadcasts) iterate + filter by `sessionId`.
   */
  readonly wsSubscribers: ReadonlySet<Subscriber>;
  /**
   * Reserved-channel payload validators threaded from
   * `GguiSessionChannelOptions.extraReservedValidators` — consulted by
   * `assertStreamContract` ahead of the protocol built-ins.
   */
  readonly extraReservedValidators?: ReadonlyMap<string, ReservedChannelValidator>;
}

/** The send/fan-out helpers, bound to one channel instance. */
export interface Outbound {
  /** Low-level wire write — skips closed sockets, warn-logs send failures. */
  send(ws: WebSocket, msg: WebSocketMessage): void;
  /** Emit an `error` frame with the canonical payload shape. */
  sendError(
    ws: WebSocket,
    code: string,
    message: string,
    requestId?: string,
    details?: ErrorPayload["details"]
  ): void;
  /**
   * Emit a `channel_error` frame to a specific subscriber. Used by the
   * `channel_subscribe` handler for both subscribe-time rejections
   * (`CHANNEL_UNKNOWN`, `CHANNEL_NOT_LOCAL`, `SESSION_NOT_FOUND`,
   * `SUBSCRIBE_UNAUTHORIZED`) AND poll-time failures (`POLL_FAILED`).
   *
   * Direct-to-WS, not via fanOut — channel_error frames are
   * per-subscriber and not stored in the replay buffer. A new
   * subscriber on the same render will re-subscribe and discover the
   * same error itself.
   */
  sendChannelError(
    ws: WebSocket,
    sessionId: string,
    channelName: string,
    code: ChannelErrorCode,
    message: string,
    requestId?: string,
    details?: ErrorPayload["details"]
  ): void;
  /** Impl behind {@link GguiSessionChannelServer.sendToGguiSession}. */
  sendToGguiSession(delivery: StreamEnvelopeInput): Promise<{ seq: number }>;
  /** Impl behind {@link GguiSessionChannelServer.notifyGguiSessionCommit}. */
  notifyGguiSessionCommit(sessionId: string, render: GguiSession, matchType?: string): void;
  /** Impl behind {@link GguiSessionChannelServer.sendPropsUpdate}. */
  sendPropsUpdate(sessionId: string, props: JsonObject): Promise<void>;
  /** Impl behind {@link GguiSessionChannelServer.sendDrainAck}. */
  sendDrainAck(args: {
    readonly sessionId: string;
    readonly appId: string;
    readonly eventId: string;
    readonly drainedAt: string;
  }): void;
  /** Impl behind {@link GguiSessionChannelServer.externalBroadcast}. */
  externalBroadcast(sessionId: string, frame: WebSocketMessage): void;
}

export function createOutbound(deps: OutboundDeps): Outbound {
  function send(ws: WebSocket, msg: WebSocketMessage): void {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      deps.logger.warn("render_channel_send_failed", { error: String(err) });
    }
  }

  function sendError(
    ws: WebSocket,
    code: string,
    message: string,
    requestId?: string,
    details?: ErrorPayload["details"]
  ): void {
    send(ws, {
      type: "error",
      payload: { code, message, ...(details !== undefined ? { details } : {}) },
      ...(requestId ? { requestId } : {}),
    });
  }

  function sendChannelError(
    ws: WebSocket,
    sessionId: string,
    channelName: string,
    code: ChannelErrorCode,
    message: string,
    requestId?: string,
    details?: ErrorPayload["details"]
  ): void {
    send(ws, {
      type: "channel_error",
      payload: {
        sessionId,
        channelName,
        code,
        message,
        ...(details !== undefined ? { details } : {}),
      },
      ...(requestId ? { requestId } : {}),
    });
  }

  /**
   * Stamp a delivery through the replay buffer and fan it out to every
   * subscriber of the render, honoring the per-subscriber replay
   * cursor. Backs the public `sendToGguiSession` entry point.
   *
   * Caller is responsible for validating `delivery.payload` against
   * the active streamSpec BEFORE calling — the fan-out here trusts
   * its input. Reserved-channel deliveries (e.g. `_ggui:lifecycle`)
   * bypass the streamSpec check upstream via
   * `assertStreamContract`.
   */
  async function fanOut(
    delivery: StreamEnvelopeInput,
    activeStreamSpec: StreamSpec | undefined
  ): Promise<{ seq: number }> {
    const { envelope } = await deps.streamBuffer.record(delivery, activeStreamSpec);
    // Publish to the seam — InProcessStreamFanout walks its subscriber
    // queues synchronously inside publish(), so no real async hop. The
    // pump loop on each WS subscriber yields the envelope, applies the
    // per-sub replay-cursor filter, and sends to the WS. Fire-and-forget
    // because publish() never throws on the in-process impl, and an
    // external pubsub-fanout failure here would already be persisted to
    // the GguiSessionStreamBuffer for replay-recovery on reconnect.
    void deps.streamFanout.publish({ sessionId: envelope.sessionId, envelope });
    return { seq: envelope.seq };
  }

  async function sendToGguiSession(delivery: StreamEnvelopeInput): Promise<{ seq: number }> {
    // Outbound fan-out enforcement (defense-in-depth parity with
    // hosted `handle-data.ts`). Re-validates the delivery's payload
    // against the render's streamSpec BEFORE delivery — so a future
    // OSS mutation handler that bypasses the emit-side check can't
    // fan out malformed data to subscribers. Throws
    // ContractViolationError{tool:'ggui_emit'} on violation;
    // caller decides what to do (log, rethrow, wrap).
    const stored = await deps.renderStore.get(delivery.sessionId);
    const activeEntry = stored?.render;
    const streamSpec =
      activeEntry !== undefined && activeEntry.type !== "mcpApps" && activeEntry.type !== "system"
        ? activeEntry.streamSpec
        : undefined;
    assertStreamContract(
      streamSpec,
      delivery.channel,
      delivery.payload,
      deps.extraReservedValidators
    );
    return fanOut(delivery, streamSpec);
  }

  function notifyGguiSessionCommit(
    sessionId: string,
    render: GguiSession,
    matchType?: string
  ): void {
    // Best-effort fan-out to every live subscriber bound to this
    // render. NOT routed through the replay buffer — see the
    // `notifyGguiSessionCommit` JSDoc on the public interface for why
    // fresh subscribers rely on `ack.render` instead of a replay frame.
    // NOT routed through StreamFanout either — `type: 'render'` is a
    // distinct WebSocket message type. Filter the flat WS-subscriber
    // set by sessionId; N is typically 1-2 (multi-tab render sharing).
    const payload = matchType !== undefined ? { session: render, matchType } : { session: render };
    for (const sub of deps.wsSubscribers) {
      if (sub.sessionId !== sessionId) continue;
      send(sub.ws, { type: "render", payload });
    }
  }

  /**
   * Best-effort + orphan-tolerant per the docstring on the public
   * `sendPropsUpdate` method.
   */
  async function sendPropsUpdate(sessionId: string, props: JsonObject): Promise<void> {
    let stored;
    try {
      stored = await deps.renderStore.get(sessionId);
    } catch (err) {
      deps.logger.warn("render_channel_props_update_lookup_failed", {
        sessionId,
        error: String(err),
      });
      return;
    }
    if (!stored) {
      deps.logger.warn("render_channel_props_update_orphan", {
        sessionId,
      });
      return;
    }
    // Filter the flat WS-subscriber set by sessionId; same posture as
    // `notifyGguiSessionCommit`. `send()` already silently skips closed sockets
    // and logs (but doesn't throw on) per-subscriber send failures, so
    // the calling handler can't be made to fail by a dead WebSocket.
    for (const sub of deps.wsSubscribers) {
      if (sub.sessionId !== sessionId) continue;
      send(sub.ws, {
        type: "props_update",
        payload: { sessionId, props },
      });
    }
  }

  function sendDrainAck({
    sessionId,
    appId,
    eventId,
    drainedAt,
  }: {
    readonly sessionId: string;
    readonly appId: string;
    readonly eventId: string;
    readonly drainedAt: string;
  }): void {
    // Server-side fan-out for the action-drain ack.
    // Filter the flat WS-subscriber set by sessionId (same posture
    // as `sendPropsUpdate`). No persistence; subscribers that
    // missed the frame fall back to their 10s claim timer, which
    // the atomic pop resolves cleanly.
    for (const sub of deps.wsSubscribers) {
      if (sub.sessionId !== sessionId) continue;
      send(sub.ws, {
        type: "drain_ack",
        payload: { sessionId, appId, eventId, drainedAt },
      });
    }
  }

  function externalBroadcast(sessionId: string, frame: WebSocketMessage): void {
    // Walk the flat subscriber set; filter to matching sessionId.
    // `send()` already guards closed sockets and logs (but doesn't
    // throw on) per-subscriber failures, so the caller (an external
    // pubsub on-message handler) can't be made to fail by a dead
    // WebSocket. No GguiSessionStore lookup — the publisher already
    // validated; this seam is the cross-process delivery path, not
    // the re-validation point.
    for (const sub of deps.wsSubscribers) {
      if (sub.sessionId !== sessionId) continue;
      send(sub.ws, frame);
    }
  }

  return {
    send,
    sendError,
    sendChannelError,
    sendToGguiSession,
    notifyGguiSessionCommit,
    sendPropsUpdate,
    sendDrainAck,
    externalBroadcast,
  };
}
