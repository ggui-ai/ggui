import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketManager } from './WebSocketManager';
import { CLIENT_SUPPORTED_VERSIONS } from '@ggui-ai/protocol';
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
    // Simulate async connection
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

    manager.connect();

    expect(onStatusChange).toHaveBeenCalledWith('connecting');

    // Advance timer to trigger connection
    await vi.advanceTimersByTimeAsync(1);

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

    // Access the mock to verify
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

    // Send before connecting
    const message: WebSocketMessage = { type: 'ping', payload: { test: true } };
    manager.send(message);

    // Now connect
    manager.connect();
    await vi.advanceTimersByTimeAsync(1);

    // Message should have been flushed
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

    // Simulate disconnect
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

    // Advance another 30 seconds
    vi.advanceTimersByTime(30_000);
    expect(ws.sentMessages.length).toBe(initialMessageCount + 2);
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

  it('opts into the protocol-version handshake on auto-subscribe', async () => {
    // SPEC §11.2.2 — the client declares its accepted versions on
    // every subscribe. Server without the handshake wired silently
    // ignores the field (legacy-pass-through).
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
    const subscribeFrame = ws.sentMessages.find((raw) =>
      raw.includes('"type":"subscribe"'),
    );
    expect(subscribeFrame).toBeDefined();
    const parsed = JSON.parse(subscribeFrame!) as {
      type: string;
      payload: { supportedVersions: string[] };
    };
    expect(parsed.payload.supportedVersions).toEqual([
      ...CLIENT_SUPPORTED_VERSIONS,
    ]);
  });

  it('opts into the handshake on deferred subscribeToRender too', async () => {
    // start-invoke flow connects with appId only; sessionId arrives
    // later via `subscribeToRender`. Both paths must stamp
    // `supportedVersions` so the server sees the declaration
    // regardless of connection mode.
    const onMessage = vi.fn();
    const onStatusChange = vi.fn();

    const manager = new WebSocketManager({
      url: 'wss://example.com',
      appId: 'app_456',
      onMessage,
      onStatusChange,
    });

    manager.connect();
    await vi.advanceTimersByTimeAsync(1);

    manager.subscribeToRender('render_deferred');

    // @ts-expect-error - accessing private property for test
    const ws = manager.ws as MockWebSocket;
    const subscribeFrame = ws.sentMessages.find((raw) =>
      raw.includes('render_deferred'),
    );
    expect(subscribeFrame).toBeDefined();
    const parsed = JSON.parse(subscribeFrame!) as {
      type: string;
      payload: { sessionId: string; supportedVersions: string[] };
    };
    expect(parsed.type).toBe('subscribe');
    expect(parsed.payload.sessionId).toBe('render_deferred');
    expect(parsed.payload.supportedVersions).toEqual([
      ...CLIENT_SUPPORTED_VERSIONS,
    ]);
  });
});
