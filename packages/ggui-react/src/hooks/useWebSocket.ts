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
   * Wraps into `{type: 'action', payload: envelope}`.
   */
  sendAction: (envelope: ActionEnvelope) => void;
  /** Send a raw WebSocket message (for invoke, generate, etc.) */
  send: (message: WebSocketMessage) => void;
  lastError: Error | null;
}

/**
 * Hook that manages a WebSocket connection to the ggui platform.
 *
 * Creates a {@link WebSocketManager} instance, connects on mount, and
 * disconnects on unmount. Reconnects automatically when the `url`,
 * `sessionId`, or `appId` change.
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
    // Don't connect if URL is not provided
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
    manager.connect();

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
            ...(envelope.stackIndex !== undefined
              ? { stackIndex: envelope.stackIndex }
              : {}),
            ...(envelope.stackItemId !== undefined
              ? { stackItemId: envelope.stackItemId }
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
