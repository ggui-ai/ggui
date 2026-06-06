/**
 * WebSocket transport envelope — the wire-framing layer for the live channel.
 *
 * The live channel is the live plane between core-mcp and the user.
 * This file defines HOW that plane is framed on a WebSocket: the
 * dispatch discriminator (`WebSocketMessageType`), the discriminated
 * union envelope (`WebSocketMessage`), and the client-side connection-
 * lifecycle enum (`ConnectionStatus`).
 *
 * The CONTRACT payload shapes (what each variant carries —
 * `SubscribePayload`, `AckPayload`, `StreamEnvelope`, etc.) live in
 * `../types/live-channel`. Renaming the envelope or swapping in an
 * alternate transport (e.g., a binary-framed variant, or SSE fallback)
 * would not change the payload contract; that asymmetry is why the
 * split exists.
 *
 * This module is exported as a subpath — `@ggui-ai/protocol/transport/
 * websocket` — so only transport implementors (hosted Lambda handlers,
 * OSS `/ws` server, web/RN WebSocketManager, connector ws-connection)
 * pay its type/build cost. Consumers that only need contract payloads
 * stay on the root import.
 */
import type { ActionEnvelope } from '../types/events';
import type { JsonObject } from '../types/data-contract';
import type {
  SubscribePayload,
  ClosePayload,
  AckPayload,
  ErrorPayload,
  RenderPayload,
  StreamEnvelope,
  StreamPayload,
  ProgressPayload,
  AgentMsgPayload,
  PropsUpdatePayload,
  UrlPayload,
  SystemPayload,
  InternalProgressPayload,
  ChannelSubscribePayload,
  ChannelUnsubscribePayload,
  ChannelPayloadFrame,
  ChannelErrorPayload,
  DrainAckPayload,
} from '../types/live-channel';
import type { HostContextObservedPayload } from '../types/host-context';
import type { GguiSessionEvent } from '../types/render-event';

/**
 * WebSocket message types for client-server communication.
 * Each type maps to a specific payload shape in the {@link WebSocketMessage} discriminated union.
 */
export type WebSocketMessageType =
  | 'action' // Client → Server: ActionEnvelope (canonical inbound)
  | 'subscribe' // Client → Server: Subscribe to render
  | 'close' // Client → Server: Close render
  | 'feedback' // Client → Server: UI feedback (love/dislike/other)
  | 'ping' // Client → Server: Heartbeat ping
  | 'pong' // Server → Client: Heartbeat pong response
  | 'ack' // Server → Client: Event acknowledged
  | 'error' // Server → Client: Error response
  | 'render' // Server → Client: Agent render event
  | 'data' // Server → Client: Agent data push (no regeneration)
  | 'stream' // Server → Client: Agent streaming text chunk
  | 'progress' // Server → Client: Generation progress
  | 'agent-msg' // Server → Client: Agent message (thinking or chat)
  | 'props_update' // Server → Client: Props replaced on existing component
  | 'url' // Server → Client: Short URL notification
  | 'system' // Server → Client: System-level events (auth, credentials)
  | 'internal:progress' // Generator → Server: Progress update (internal)
  // ─── Channel-level subscribe (per-channel `streamSpec[*].source.tool` fan-out) ───
  | 'channel_subscribe' // Client → Server: subscribe to a streamSpec channel; server polls source.tool
  | 'channel_unsubscribe' // Client → Server: cancel a channel_subscribe (idempotent)
  | 'channel_payload' // Server → Client: source.tool result for a subscribed channel
  | 'channel_error' // Server → Client: subscribe rejected / poll failed / tool errored
  // ─── Action-drain ack ───
  | 'drain_ack' // Server → Client: ggui_consume popped an ActionEnvelope; iframe cancels its claim timer
  // ─── Canvas-mode host-context capture ───
  | 'host_context_observed' // Client → Server: iframe echoes McpUiHostContext from ui/initialize + on host-context-changed
  // ─── R7 GguiSessionEvent ledger replay ───
  | 'render_event'; // Server → Client: one GguiSessionEvent from the per-render ledger; emitted on subscribe-time replay when SubscribePayload.sinceSequence is set

/** Fields shared by all WebSocket message variants. */
interface WsMessageBase {
  requestId?: string;
}

/**
 * Discriminated union of all WebSocket messages.
 * The `type` field narrows `payload` automatically in switch/if blocks —
 * no type casts needed. Each variant pairs a `WebSocketMessageType` with
 * its corresponding payload interface.
 *
 * @example
 * ```typescript
 * function handle(msg: WebSocketMessage) {
 *   switch (msg.type) {
 *     case 'ack':
 *       msg.payload.sequence; // AckPayload — auto-narrowed
 *       break;
 *     case 'error':
 *       msg.payload.message; // ErrorPayload — auto-narrowed
 *       msg.payload.details; // JsonValue | undefined
 *       break;
 *     case 'render':
 *       msg.payload.render; // RenderPayload — auto-narrowed
 *       break;
 *     case 'data':
 *       msg.payload.payload; // StreamEnvelope.payload
 *       break;
 *   }
 * }
 * ```
 */
export type WebSocketMessage =
  | (WsMessageBase & { type: 'action'; payload: ActionEnvelope })
  | (WsMessageBase & { type: 'subscribe'; payload: SubscribePayload })
  | (WsMessageBase & { type: 'close'; payload: ClosePayload })
  | (WsMessageBase & { type: 'feedback'; payload: JsonObject })
  | (WsMessageBase & { type: 'ping'; payload: JsonObject })
  | (WsMessageBase & { type: 'pong'; payload: JsonObject })
  | (WsMessageBase & { type: 'ack'; payload: AckPayload })
  | (WsMessageBase & { type: 'error'; payload: ErrorPayload })
  | (WsMessageBase & { type: 'render'; payload: RenderPayload })
  | (WsMessageBase & { type: 'data'; payload: StreamEnvelope })
  | (WsMessageBase & { type: 'stream'; payload: StreamPayload })
  | (WsMessageBase & { type: 'progress'; payload: ProgressPayload })
  | (WsMessageBase & { type: 'agent-msg'; payload: AgentMsgPayload })
  | (WsMessageBase & { type: 'props_update'; payload: PropsUpdatePayload })
  | (WsMessageBase & { type: 'url'; payload: UrlPayload })
  | (WsMessageBase & { type: 'system'; payload: SystemPayload })
  | (WsMessageBase & { type: 'internal:progress'; payload: InternalProgressPayload })
  // Channel-level subscribe transport — per `streamSpec[*].source.tool` fan-out.
  | (WsMessageBase & { type: 'channel_subscribe'; payload: ChannelSubscribePayload })
  | (WsMessageBase & { type: 'channel_unsubscribe'; payload: ChannelUnsubscribePayload })
  | (WsMessageBase & { type: 'channel_payload'; payload: ChannelPayloadFrame })
  | (WsMessageBase & { type: 'channel_error'; payload: ChannelErrorPayload })
  // Action-drain ack (Server → Client only).
  | (WsMessageBase & { type: 'drain_ack'; payload: DrainAckPayload })
  // Canvas-mode host-context capture (Client → Server only).
  // The iframe-runtime extracts a `HostContextProjection` from the MCP
  // Apps `ui/initialize` response and echoes it here so the server can
  // persist it on `GguiSession.hostContext` for agent visibility.
  | (WsMessageBase & { type: 'host_context_observed'; payload: HostContextObservedPayload })
  // R7 — GguiSessionEvent ledger replay frame (Server → Client only).
  // Emitted before the live tail when SubscribePayload.sinceSequence
  // is set; one frame per ledger entry with `seq > sinceSequence`.
  // The payload IS the full GguiSessionEvent (seq + timestamp + type +
  // data). Consumers dispatch by `payload.type` to fold the wire-
  // frame-equivalent handler (render → render handler, props_update →
  // props_update handler, etc.) — the unification R7 lands.
  | (WsMessageBase & { type: 'render_event'; payload: GguiSessionEvent });

/**
 * WebSocket connection status. Client-side transport enum describing
 * the browser/Node ws.readyState lifecycle.
 */
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';
