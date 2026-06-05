import type { ConnectionStatus, WebSocketMessage } from '@ggui-ai/protocol/transport/websocket';
import { CLIENT_SUPPORTED_VERSIONS } from '@ggui-ai/protocol';
import { EventBuffer } from './EventBuffer';

/**
 * Configuration for {@link WebSocketManager}.
 */
export interface WebSocketManagerOptions {
  url: string;
  /** GguiSession ID — optional for start-invoke flow (platform assigns render). */
  renderId?: string;
  appId: string;
  onMessage: (message: WebSocketMessage) => void;
  onStatusChange: (status: ConnectionStatus) => void;
  onError?: (error: Error) => void;
}

/** Interval between heartbeat pings (30 seconds) */
const PING_INTERVAL_MS = 30_000;

/**
 * Manages WebSocket connection lifecycle with automatic reconnection
 * and heartbeat pings to prevent idle timeouts.
 */
export class WebSocketManager {
  private ws: WebSocket | null = null;
  private buffer = new EventBuffer();
  private options: WebSocketManagerOptions;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(options: WebSocketManagerOptions) {
    this.options = options;
  }

  /**
   * Open the WebSocket connection to the ggui platform.
   *
   * If renderId is provided, auto-subscribes on connect.
   * If not (start-invoke flow), connects with appId only — call
   * {@link subscribeToRender} after receiving the render assignment.
   */
  connect(): void {
    if (this.disposed) return;

    const { url, renderId, appId, onStatusChange } = this.options;
    onStatusChange('connecting');

    const wsUrl = renderId
      ? `${url}?renderId=${renderId}&appId=${appId}`
      : `${url}?appId=${appId}`;
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      if (this.disposed) return;
      this.reconnectAttempts = 0;
      if (renderId) {
        // Subscribe immediately when renderId is known.
        // `supportedVersions` opts into the protocol-version
        // handshake; servers that don't read the field silently
        // ignore it (older servers pass through unchanged).
        this.ws?.send(JSON.stringify({
          type: 'subscribe',
          payload: {
            renderId,
            appId,
            supportedVersions: [...CLIENT_SUPPORTED_VERSIONS],
          },
        }));
      }
      onStatusChange('connected');
      this.flushBuffer();
      this.startPing();
    };

    this.ws.onmessage = (event) => {
      if (this.disposed) return;
      try {
        const message: WebSocketMessage = JSON.parse(event.data);
        // Ignore pong responses from server
        if (message.type === 'pong') return;
        this.options.onMessage(message);
      } catch {
        // Ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      if (this.disposed) return;
      this.stopPing();
      onStatusChange('disconnected');
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // The close event will fire after error, triggering reconnect
      this.ws?.close();
    };
  }

  /**
   * Subscribe to a render after the platform assigns one.
   * Used in the start-invoke flow where renderId isn't known at connect time.
   */
  subscribeToRender(renderId: string): void {
    this.options.renderId = renderId;
    if (this.ws?.readyState === WebSocket.OPEN) {
      // Include `supportedVersions` to opt into the protocol-version
      // handshake on the deferred-subscribe path too; older servers
      // ignore the field.
      this.ws.send(JSON.stringify({
        type: 'subscribe',
        payload: {
          renderId,
          appId: this.options.appId,
          supportedVersions: [...CLIENT_SUPPORTED_VERSIONS],
        },
      }));
    }
  }

  /**
   * Send a message through the WebSocket connection.
   *
   * If the connection is not open, the message is buffered and will
   * be sent automatically once the connection is re-established.
   *
   * @param message - The WebSocket message to send
   */
  send(message: WebSocketMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      this.buffer.add(message);
    }
  }

  /**
   * Close the WebSocket connection and clean up all resources.
   *
   * Stops heartbeat pings, cancels any pending reconnection attempts,
   * and marks the manager as disposed so no further connections are made.
   */
  disconnect(): void {
    this.disposed = true;
    this.stopPing();
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  private flushBuffer(): void {
    const messages = this.buffer.flush();
    messages.forEach((msg) => this.send(msg));
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.options.onStatusChange('disconnected');
      this.options.onError?.(
        new Error(`Max reconnection attempts reached (${this.maxReconnectAttempts})`)
      );
      return;
    }

    this.options.onStatusChange('reconnecting');
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect();
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}
