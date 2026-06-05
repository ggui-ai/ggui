import { AppState, type AppStateStatus } from 'react-native';
import type { ConnectionStatus, WebSocketMessage } from '@ggui-ai/protocol/transport/websocket';
import { CLIENT_SUPPORTED_VERSIONS } from '@ggui-ai/protocol';
import { EventBuffer } from './EventBuffer';

/**
 * Minimal network state shape compatible with `@react-native-community/netinfo`.
 */
export interface NetInfoState {
  isConnected: boolean | null;
  isInternetReachable: boolean | null;
}

/**
 * Configuration for the mobile-aware {@link WebSocketManager}.
 */
export interface WebSocketManagerOptions {
  url: string;
  sessionId: string;
  appId: string;
  onMessage: (message: WebSocketMessage) => void;
  onStatusChange: (status: ConnectionStatus) => void;
  onError?: (error: Error) => void;
  /** Optional NetInfo.addEventListener for proactive network monitoring */
  netInfoSubscribe?: (listener: (state: NetInfoState) => void) => () => void;
  /** Optional AsyncStorage-compatible storage for event buffer persistence */
  storage?: {
    getItem: (key: string) => Promise<string | null>;
    setItem: (key: string, value: string) => Promise<void>;
    removeItem: (key: string) => Promise<void>;
  };
}

/** Interval between heartbeat pings (30 seconds) */
const PING_INTERVAL_MS = 30_000;

/**
 * Mobile-aware WebSocket manager.
 *
 * Extends the base WebSocket lifecycle with:
 * - AppState monitoring (disconnect on background, reconnect on foreground)
 * - NetInfo monitoring (proactive disconnect/reconnect on network changes)
 * - Exponential backoff reconnection with max-attempt error notification
 * - Heartbeat pings to prevent idle connection timeouts (paused when backgrounded)
 * - Event buffering during disconnects (with optional persistence)
 */
export class WebSocketManager {
  private ws: WebSocket | null = null;
  private buffer = new EventBuffer();
  private options: WebSocketManagerOptions;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private appStateSubscription: { remove: () => void } | null = null;
  private netInfoUnsubscribe: (() => void) | null = null;
  private currentAppState: AppStateStatus = AppState.currentState;
  private isNetworkAvailable = true;

  constructor(options: WebSocketManagerOptions) {
    this.options = options;
    if (options.storage) {
      this.buffer.setStorage(options.storage);
    }
  }

  /**
   * Open the WebSocket connection to the ggui platform.
   *
   * Loads any persisted buffered events, sends a `subscribe` message on
   * open, flushes the buffer, and starts heartbeat pings. Also begins
   * monitoring AppState and NetInfo for automatic disconnect/reconnect.
   */
  async connect(): Promise<void> {
    // Load any persisted buffered events on first connect
    await this.buffer.loadPersisted();

    const { url, sessionId, appId, onStatusChange } = this.options;
    onStatusChange('connecting');

    const wsUrl = `${url}?sessionId=${sessionId}&appId=${appId}`;
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      onStatusChange('connected');

      // Send subscribe message to register for render updates.
      // `supportedVersions` opts into the protocol-version handshake;
      // servers that don't read the field silently ignore it (older
      // servers pass through unchanged).
      this.ws?.send(JSON.stringify({
        type: 'subscribe',
        payload: {
          sessionId,
          appId,
          supportedVersions: [...CLIENT_SUPPORTED_VERSIONS],
        },
      }));

      this.flushBuffer();
      this.startPing();
    };

    this.ws.onmessage = (event) => {
      try {
        const message: WebSocketMessage = JSON.parse(event.data as string);
        // Ignore pong responses from server
        if (message.type === 'pong') return;
        this.options.onMessage(message);
      } catch {
        // Ignore malformed messages — server may send non-JSON (e.g. ping frames)
      }
    };

    this.ws.onclose = () => {
      this.stopPing();
      onStatusChange('disconnected');
      // Only auto-reconnect if app is in foreground and network is available
      if (this.currentAppState === 'active' && this.isNetworkAvailable) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };

    // Monitor app state for background/foreground transitions
    this.startAppStateMonitoring();
    // Monitor network state for proactive disconnect/reconnect
    this.startNetInfoMonitoring();
  }

  /**
   * Send a message through the WebSocket connection.
   *
   * If the connection is not open, the message is buffered (with
   * optional persistence) and will be sent on reconnect.
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
   * Stops heartbeat pings, AppState monitoring, NetInfo monitoring,
   * and cancels any pending reconnection attempts.
   */
  disconnect(): void {
    this.stopPing();
    this.stopAppStateMonitoring();
    this.stopNetInfoMonitoring();
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
      this.connect().catch(() => {
        // Reconnect failures are handled by onclose → scheduleReconnect
      });
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

  private startAppStateMonitoring(): void {
    this.appStateSubscription = AppState.addEventListener('change', this.handleAppStateChange);
  }

  private stopAppStateMonitoring(): void {
    this.appStateSubscription?.remove();
    this.appStateSubscription = null;
  }

  private startNetInfoMonitoring(): void {
    if (!this.options.netInfoSubscribe) return;
    this.netInfoUnsubscribe = this.options.netInfoSubscribe(this.handleNetInfoChange);
  }

  private stopNetInfoMonitoring(): void {
    this.netInfoUnsubscribe?.();
    this.netInfoUnsubscribe = null;
  }

  private handleNetInfoChange = (state: NetInfoState): void => {
    const wasAvailable = this.isNetworkAvailable;
    this.isNetworkAvailable = !!(state.isConnected && state.isInternetReachable !== false);

    if (wasAvailable && !this.isNetworkAvailable) {
      // Network lost — close socket proactively, stop reconnect attempts and pings
      this.stopPing();
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;
      }
      this.ws?.close();
      this.ws = null;
      this.options.onStatusChange('disconnected');
    } else if (!wasAvailable && this.isNetworkAvailable) {
      // Network restored — reconnect if app is in foreground
      if (this.currentAppState === 'active') {
        this.reconnectAttempts = 0;
        this.connect().catch(() => {
          // Connection failure triggers onclose → scheduleReconnect
        });
      }
    }
  };

  private handleAppStateChange = (nextAppState: AppStateStatus): void => {
    const wasBackground = this.currentAppState !== 'active';
    const isNowActive = nextAppState === 'active';

    if (wasBackground && isNowActive) {
      // App came to foreground — reconnect if disconnected and network available
      if (this.isNetworkAvailable && (!this.ws || this.ws.readyState !== WebSocket.OPEN)) {
        this.reconnectAttempts = 0;
        this.connect().catch(() => {
          // Connection failure triggers onclose → scheduleReconnect
        });
      }
    } else if (this.currentAppState === 'active' && nextAppState !== 'active') {
      // App going to background — disconnect and stop pings to save battery
      // Events are buffered and will be flushed on reconnect
      this.stopPing();
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;
      }
      this.ws?.close();
      this.ws = null;
    }

    this.currentAppState = nextAppState;
  };
}
