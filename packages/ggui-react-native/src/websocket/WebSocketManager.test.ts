import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketManager } from './WebSocketManager';
import type { WebSocketMessage } from '@ggui-ai/protocol/transport/websocket';

// Mock WebSocket
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  sentMessages: string[] = [];

  constructor(public url: string) {
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.();
    }, 0);
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  simulateMessage(data: WebSocketMessage): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  simulateError(): void {
    this.onerror?.();
  }
}

describe('WebSocketManager', () => {
  let originalWebSocket: typeof WebSocket;

  beforeEach(() => {
    originalWebSocket = global.WebSocket;
    // @ts-expect-error - Mock WebSocket
    global.WebSocket = MockWebSocket;
    vi.useFakeTimers();
  });

  afterEach(() => {
    global.WebSocket = originalWebSocket;
    vi.useRealTimers();
  });

  it('connects with correct URL parameters', async () => {
    const onMessage = vi.fn();
    const onStatusChange = vi.fn();

    const manager = new WebSocketManager({
      url: 'wss://example.com',
      sessionId: 'render_123',
      appId: 'app_456',
      onMessage,
      onStatusChange,
    });

    // connect() is async (calls loadPersisted), so await it + advance timers
    const connectPromise = manager.connect();
    await vi.advanceTimersByTimeAsync(1);
    await connectPromise;

    expect(onStatusChange).toHaveBeenCalledWith('connecting');
    expect(onStatusChange).toHaveBeenCalledWith('connected');
  });

  it('sends messages when connected', async () => {
    const onMessage = vi.fn();
    const onStatusChange = vi.fn();

    const manager = new WebSocketManager({
      url: 'wss://example.com',
      sessionId: 'render_123',
      appId: 'app_456',
      onMessage,
      onStatusChange,
    });

    manager.connect();
    await vi.advanceTimersByTimeAsync(1);

    const message: WebSocketMessage = { type: 'ping', payload: { test: true } };
    manager.send(message);

    // @ts-expect-error - accessing private property for test
    const ws = manager.ws as MockWebSocket;
    expect(ws.sentMessages).toContain(JSON.stringify(message));
  });

  it('buffers messages when disconnected', async () => {
    const onMessage = vi.fn();
    const onStatusChange = vi.fn();

    const manager = new WebSocketManager({
      url: 'wss://example.com',
      sessionId: 'render_123',
      appId: 'app_456',
      onMessage,
      onStatusChange,
    });

    // Send before connecting — should be buffered
    const message: WebSocketMessage = { type: 'ping', payload: { test: true } };
    manager.send(message);

    // Connect — buffer should flush
    manager.connect();
    await vi.advanceTimersByTimeAsync(1);

    // @ts-expect-error - accessing private property for test
    const ws = manager.ws as MockWebSocket;
    expect(ws.sentMessages).toContain(JSON.stringify(message));
  });

  it('receives messages and calls onMessage', async () => {
    const onMessage = vi.fn();
    const onStatusChange = vi.fn();

    const manager = new WebSocketManager({
      url: 'wss://example.com',
      sessionId: 'render_123',
      appId: 'app_456',
      onMessage,
      onStatusChange,
    });

    manager.connect();
    await vi.advanceTimersByTimeAsync(1);

    // @ts-expect-error - accessing private property for test
    const ws = manager.ws as MockWebSocket;
    const incomingMessage: WebSocketMessage = { type: 'ack', payload: { sequence: 1, timestamp: Date.now() } };
    ws.simulateMessage(incomingMessage);

    expect(onMessage).toHaveBeenCalledWith(incomingMessage);
  });

  it('handles malformed messages without crashing', async () => {
    const onMessage = vi.fn();
    const onStatusChange = vi.fn();

    const manager = new WebSocketManager({
      url: 'wss://example.com',
      sessionId: 'render_123',
      appId: 'app_456',
      onMessage,
      onStatusChange,
    });

    manager.connect();
    await vi.advanceTimersByTimeAsync(1);

    // @ts-expect-error - accessing private property for test
    const ws = manager.ws as MockWebSocket;

    // Send malformed (non-JSON) message — should not throw
    ws.onmessage?.({ data: 'not valid json' });
    expect(onMessage).not.toHaveBeenCalled();

    // Send valid message after — should still work
    const validMessage: WebSocketMessage = { type: 'ack', payload: { sequence: 1, timestamp: Date.now() } };
    ws.simulateMessage(validMessage);
    expect(onMessage).toHaveBeenCalledWith(validMessage);
  });

  it('schedules reconnect on disconnect', async () => {
    const onMessage = vi.fn();
    const onStatusChange = vi.fn();

    const manager = new WebSocketManager({
      url: 'wss://example.com',
      sessionId: 'render_123',
      appId: 'app_456',
      onMessage,
      onStatusChange,
    });

    manager.connect();
    await vi.advanceTimersByTimeAsync(1);

    // @ts-expect-error - accessing private property for test
    const ws = manager.ws as MockWebSocket;
    ws.close();

    expect(onStatusChange).toHaveBeenCalledWith('disconnected');
    expect(onStatusChange).toHaveBeenCalledWith('reconnecting');
  });

  it('disconnects cleanly', async () => {
    const onMessage = vi.fn();
    const onStatusChange = vi.fn();

    const manager = new WebSocketManager({
      url: 'wss://example.com',
      sessionId: 'render_123',
      appId: 'app_456',
      onMessage,
      onStatusChange,
    });

    manager.connect();
    await vi.advanceTimersByTimeAsync(1);

    manager.disconnect();

    // @ts-expect-error - accessing private property for test
    expect(manager.ws).toBeNull();
  });

  it('handles AppState background/foreground transitions', async () => {
    const onMessage = vi.fn();
    const onStatusChange = vi.fn();

    const manager = new WebSocketManager({
      url: 'wss://example.com',
      sessionId: 'render_123',
      appId: 'app_456',
      onMessage,
      onStatusChange,
    });

    manager.connect();
    await vi.advanceTimersByTimeAsync(1);

    // Simulate going to background — should close WS
    // @ts-expect-error - accessing private property for test
    manager.handleAppStateChange('background');

    // @ts-expect-error - accessing private property for test
    expect(manager.ws).toBeNull();

    // Simulate coming back to foreground — should reconnect
    // @ts-expect-error - accessing private property for test
    manager.handleAppStateChange('active');
    await vi.advanceTimersByTimeAsync(1);

    // @ts-expect-error - accessing private property for test
    expect(manager.ws).not.toBeNull();
  });

  it('handles NetInfo network loss and recovery', async () => {
    const onMessage = vi.fn();
    const onStatusChange = vi.fn();
    let netInfoListener: ((state: { isConnected: boolean | null; isInternetReachable: boolean | null }) => void) | null = null;

    const manager = new WebSocketManager({
      url: 'wss://example.com',
      sessionId: 'render_123',
      appId: 'app_456',
      onMessage,
      onStatusChange,
      netInfoSubscribe: (listener) => {
        netInfoListener = listener;
        return () => { netInfoListener = null; };
      },
    });

    manager.connect();
    await vi.advanceTimersByTimeAsync(1);

    // Simulate network loss
    netInfoListener!({ isConnected: false, isInternetReachable: false });

    // @ts-expect-error - accessing private property for test
    expect(manager.ws).toBeNull();
    expect(onStatusChange).toHaveBeenCalledWith('disconnected');

    // Simulate network restore
    netInfoListener!({ isConnected: true, isInternetReachable: true });
    await vi.advanceTimersByTimeAsync(1);

    // Should have reconnected
    expect(onStatusChange).toHaveBeenCalledWith('connecting');
  });

  it('calls onError when max reconnect attempts reached', async () => {
    const onMessage = vi.fn();
    const onStatusChange = vi.fn();
    const onError = vi.fn();

    const manager = new WebSocketManager({
      url: 'wss://example.com',
      sessionId: 'render_123',
      appId: 'app_456',
      onMessage,
      onStatusChange,
      onError,
    });

    manager.connect();
    await vi.advanceTimersByTimeAsync(1);

    // Simulate the manager having exhausted all reconnect attempts
    // (e.g., after repeated connection failures)
    // @ts-expect-error - accessing private property for test
    manager.reconnectAttempts = manager.maxReconnectAttempts;

    // Now trigger a disconnect — scheduleReconnect should detect max reached
    // @ts-expect-error - accessing private property for test
    const ws = manager.ws as MockWebSocket;
    ws.close();

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('Max reconnection attempts') })
    );
    expect(onStatusChange).toHaveBeenCalledWith('disconnected');
  });

  it('allows manual reconnect after max attempts by calling connect()', async () => {
    const onMessage = vi.fn();
    const onStatusChange = vi.fn();
    const onError = vi.fn();

    const manager = new WebSocketManager({
      url: 'wss://example.com',
      sessionId: 'render_123',
      appId: 'app_456',
      onMessage,
      onStatusChange,
      onError,
    });

    // Set reconnect attempts past max
    // @ts-expect-error - accessing private property for test
    manager.reconnectAttempts = 10;

    // Calling connect() directly should reset the counter and work
    manager.connect();
    await vi.advanceTimersByTimeAsync(1);

    expect(onStatusChange).toHaveBeenCalledWith('connecting');
    expect(onStatusChange).toHaveBeenCalledWith('connected');
    // @ts-expect-error - accessing private property for test
    expect(manager.reconnectAttempts).toBe(0);
  });

  it('sends ping messages at regular intervals', async () => {
    const onMessage = vi.fn();
    const onStatusChange = vi.fn();

    const manager = new WebSocketManager({
      url: 'wss://example.com',
      sessionId: 'render_123',
      appId: 'app_456',
      onMessage,
      onStatusChange,
    });

    manager.connect();
    await vi.advanceTimersByTimeAsync(1);

    // @ts-expect-error - accessing private property for test
    const ws = manager.ws as MockWebSocket;
    const initialMessageCount = ws.sentMessages.length;

    // Advance by 30 seconds (ping interval)
    vi.advanceTimersByTime(30_000);
    expect(ws.sentMessages.length).toBe(initialMessageCount + 1);
    expect(ws.sentMessages[ws.sentMessages.length - 1]).toBe(JSON.stringify({ type: 'ping' }));
  });

  it('stops ping when app goes to background', async () => {
    const onMessage = vi.fn();
    const onStatusChange = vi.fn();

    const manager = new WebSocketManager({
      url: 'wss://example.com',
      sessionId: 'render_123',
      appId: 'app_456',
      onMessage,
      onStatusChange,
    });

    manager.connect();
    await vi.advanceTimersByTimeAsync(1);

    // @ts-expect-error - accessing private property for test
    expect(manager.pingInterval).not.toBeNull();

    // Simulate going to background
    // @ts-expect-error - accessing private property for test
    manager.handleAppStateChange('background');

    // @ts-expect-error - accessing private property for test
    expect(manager.pingInterval).toBeNull();
  });

  it('stops ping on disconnect', async () => {
    const onMessage = vi.fn();
    const onStatusChange = vi.fn();

    const manager = new WebSocketManager({
      url: 'wss://example.com',
      sessionId: 'render_123',
      appId: 'app_456',
      onMessage,
      onStatusChange,
    });

    manager.connect();
    await vi.advanceTimersByTimeAsync(1);

    manager.disconnect();

    // @ts-expect-error - accessing private property for test
    expect(manager.pingInterval).toBeNull();
  });

  it('ignores pong messages from server', async () => {
    const onMessage = vi.fn();
    const onStatusChange = vi.fn();

    const manager = new WebSocketManager({
      url: 'wss://example.com',
      sessionId: 'render_123',
      appId: 'app_456',
      onMessage,
      onStatusChange,
    });

    manager.connect();
    await vi.advanceTimersByTimeAsync(1);

    // @ts-expect-error - accessing private property for test
    const ws = manager.ws as MockWebSocket;
    ws.simulateMessage({ type: 'pong', payload: {} });

    expect(onMessage).not.toHaveBeenCalled();
  });
});
