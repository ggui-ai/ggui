/**
 * WebSocket transport envelope — the wire-framing layer for the live channel.
 *
 * The live channel is the live session plane between core-mcp and the
 * user. This file defines HOW that plane is framed on a WebSocket:
 * the dispatch discriminator
 * (`WebSocketMessageType`), the discriminated union envelope
 * (`WebSocketMessage`), and the client-side connection-lifecycle enum
 * (`ConnectionStatus`).
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
  GeneratePayload,
  PopPayload,
  ClosePayload,
  GetStackPayload,
  AckPayload,
  ErrorPayload,
  PushPayload,
  StreamEnvelope,
  StreamPayload,
  SessionPayload,
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

/**
 * WebSocket message types for client-server communication.
 * Each type maps to a specific payload shape in the {@link WebSocketMessage} discriminated union.
 */
export type WebSocketMessageType =
  | 'action' // Client → Server: ActionEnvelope (canonical inbound)
  | 'subscribe' // Client → Server: Subscribe to session
  | 'generate' // Client → Server: Request UI generation
  | 'pop' // Client → Server: Pop top card from stack
  | 'close' // Client → Server: Close session
  | 'get_stack' // Client → Server: Get stack info
  | 'feedback' // Client → Server: UI feedback (love/dislike/other)
  | 'ping' // Client → Server: Heartbeat ping
  | 'pong' // Server → Client: Heartbeat pong response
  | 'ack' // Server → Client: Event acknowledged
  | 'error' // Server → Client: Error response
  | 'push' // Server → Client: Agent push event
  | 'data' // Server → Client: Agent data push (no regeneration)
  | 'stream' // Server → Client: Agent streaming text chunk
  | 'session' // Server → Client: Session created by agent (start flow)
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
  // ─── Canvas-mode user navigation ───
  | 'canvas_navigated'; // Client → Server: user back-navigated; server updates activeStackItemId + may abort cold-gen for the popped item

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
 *     case 'push':
 *       msg.payload.stackItem; // PushPayload — auto-narrowed
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
  | (WsMessageBase & { type: 'generate'; payload: GeneratePayload })
  | (WsMessageBase & { type: 'pop'; payload: PopPayload })
  | (WsMessageBase & { type: 'close'; payload: ClosePayload })
  | (WsMessageBase & { type: 'get_stack'; payload: GetStackPayload })
  | (WsMessageBase & { type: 'feedback'; payload: JsonObject })
  | (WsMessageBase & { type: 'ping'; payload: JsonObject })
  | (WsMessageBase & { type: 'pong'; payload: JsonObject })
  | (WsMessageBase & { type: 'ack'; payload: AckPayload })
  | (WsMessageBase & { type: 'error'; payload: ErrorPayload })
  | (WsMessageBase & { type: 'push'; payload: PushPayload })
  | (WsMessageBase & { type: 'data'; payload: StreamEnvelope })
  | (WsMessageBase & { type: 'stream'; payload: StreamPayload })
  | (WsMessageBase & { type: 'session'; payload: SessionPayload })
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
  // persist it on `SessionRecord.hostContext` for agent visibility.
  | (WsMessageBase & { type: 'host_context_observed'; payload: HostContextObservedPayload })
  // Canvas-mode user navigation (Client → Server only).
  // The iframe-runtime fires this when the user back-navigates in the
  // canvas (popping a stack item from the local NavStackModel). The
  // server updates `session.activeStackItemId` to the new top and MAY
  // abort in-flight cold-gen for the previous active item.
  | (WsMessageBase & { type: 'canvas_navigated'; payload: CanvasNavigatedPayload });

/**
 * Payload for the canvas-mode `canvas_navigated` message. Emitted by
 * the iframe-runtime's CanvasShell when the user back-navigates — the
 * server uses `activeItemId` to update `session.activeStackItemId`
 * (for `ggui_consume`'s active-pipe resolution) and
 * `previousActiveItemId` to optionally abort the cold-gen
 * `AbortSignal` keyed on that stack item.
 */
export interface CanvasNavigatedPayload {
  /** Tenancy guard — server compares against subscriber binding. */
  readonly sessionId: string;
  /**
   * Stack-item id the canvas had as active immediately BEFORE the
   * navigation. Null when navigating from the empty state (no prior
   * active item).
   */
  readonly previousActiveItemId: string | null;
  /**
   * Stack-item id the canvas has as active immediately AFTER the
   * navigation. Null when the user popped to an empty navStack.
   */
  readonly activeItemId: string | null;
}

/**
 * WebSocket connection status. Client-side transport enum describing
 * the browser/Node ws.readyState lifecycle.
 */
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';
