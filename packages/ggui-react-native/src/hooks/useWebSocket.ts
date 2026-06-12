/**
 * useWebSocket — React Native twin of `@ggui-ai/react`'s
 * `hooks/useWebSocket.ts`.
 *
 * Everything else mirrors the web hook, including the
 * `sendAction` schemaVersion re-stamp via `makeActionEnvelope`.
 *
 * Platform delta (every intentional divergence from the web copy):
 *
 *   - `manager.connect()` is async on RN (persisted-buffer load), so
 *     the mount effect attaches a `.catch` that surfaces connection
 *     failures via `lastError`; the web manager connects
 *     synchronously.
 *   - The underlying `WebSocketManager` is the mobile-aware variant
 *     (AppState / NetInfo monitoring, buffer persistence) — see
 *     `../websocket/WebSocketManager.ts`.
 *
 * Guarded by the structural twin gate in `../twin-parity.test.ts`
 * (`DOCUMENTED_DELTA_TWINS`): exported surface must match the web
 * copy.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import type {
  ConnectionStatus,
  WebSocketMessage,
} from '@ggui-ai/protocol/transport/websocket';
import type { ActionEnvelope } from '@ggui-ai/protocol';
import { makeActionEnvelope } from '@ggui-ai/protocol';
import { WebSocketManager } from '../websocket/WebSocketManager';

/**
 * Options for the {@link useWebSocket} hook.
 */
export interface UseWebSocketOptions {
  url: string;
  sessionId: string;
  appId: string;
  onMessage?: (message: WebSocketMessage) => void;
}

/**
 * Return value of the {@link useWebSocket} hook.
 */
export interface UseWebSocketReturn {
  status: ConnectionStatus;
  /**
   * Send a canonical inbound {@link ActionEnvelope} over the live channel.
   * Wraps into `{type: 'action', payload: envelope}`. Symmetric with
   * the web SDK's `sendAction`.
   */
  sendAction: (envelope: ActionEnvelope) => void;
  /** Send a raw WebSocket message (for invoke, generate, etc.) */
  send: (message: WebSocketMessage) => void;
  lastError: Error | null;
}

/**
 * Hook that manages a WebSocket connection to the ggui platform.
 *
 * Creates a mobile-aware {@link WebSocketManager} that handles AppState
 * monitoring (background/foreground transitions) and optional NetInfo
 * integration. Connects on mount, disconnects on unmount, and reconnects
 * when `url`, `sessionId`, or `appId` change.
 *
 * @param options - Connection configuration and message handler
 * @returns Connection status, envelope sender, raw sender, and last error
 */
export function useWebSocket(options: UseWebSocketOptions): UseWebSocketReturn {
  const { url, sessionId, appId, onMessage } = options;
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [lastError, setLastError] = useState<Error | null>(null);
  const managerRef = useRef<WebSocketManager | null>(null);

  // Stable ref for onMessage to avoid reconnections when callback identity changes
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    if (!url) {
      return;
    }

    const manager = new WebSocketManager({
      url,
      sessionId,
      appId,
      onMessage: (msg) => {
        if (msg.type === 'error') {
          setLastError(new Error((msg.payload as { message: string }).message));
        }
        onMessageRef.current?.(msg);
      },
      onStatusChange: setStatus,
      onError: (err) => setLastError(err),
    });

    managerRef.current = manager;
    manager.connect().catch((err) => {
      setLastError(err instanceof Error ? err : new Error('WebSocket connection failed'));
    });

    return () => {
      manager.disconnect();
      managerRef.current = null;
    };
  }, [url, sessionId, appId]);

  const sendAction = useCallback((envelope: ActionEnvelope) => {
    // Re-stamp via the central builder. Callers typically pass an
    // envelope already built by `buildActionEnvelope` (which stamps);
    // this path is the belt-and-suspenders for any third-party caller
    // that skipped the builder. Semantics: if `envelope.schemaVersion`
    // is a string, preserve it; if it's `undefined` (or the key is
    // absent), stamp the default.
    const restamped: ActionEnvelope =
      envelope.schemaVersion !== undefined
        ? envelope
        : makeActionEnvelope({
            sessionId: envelope.sessionId,
            type: envelope.type,
            ...(envelope.payload !== undefined
              ? { payload: envelope.payload }
              : {}),
            ...(envelope.clientSeq !== undefined
              ? { clientSeq: envelope.clientSeq }
              : {}),
          });
    managerRef.current?.send({
      type: 'action',
      payload: restamped,
    });
  }, []);

  const send = useCallback((message: WebSocketMessage) => {
    managerRef.current?.send(message);
  }, []);

  return { status, sendAction, send, lastError };
}
