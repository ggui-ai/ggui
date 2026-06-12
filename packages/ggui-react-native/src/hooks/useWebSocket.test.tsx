/**
 * useWebSocket (RN) tests — closes the formerly one-sided coverage gap
 * vs `@ggui-ai/react`'s `hooks/useWebSocket.test.ts`.
 *
 * Platform delta vs the web suite: rendering goes through
 * `react-test-renderer` with a probe component (this package carries
 * no `@testing-library/react`), and the mount path exercises the RN
 * manager's async `connect()`. Coverage additionally pins the
 * `sendAction` schemaVersion re-stamp that both SDK hooks share.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { create, act, type ReactTestRenderer } from 'react-test-renderer';
import type { ActionEnvelope } from '@ggui-ai/protocol';
import type { WebSocketMessage } from '@ggui-ai/protocol/transport/websocket';
import { useWebSocket, type UseWebSocketReturn } from './useWebSocket';

// Mock WebSocket — records sent frames per instance.
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  sentMessages: string[] = [];

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
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
}

function Probe({
  capture,
}: {
  capture: { current: UseWebSocketReturn | null };
}): React.ReactElement {
  const api = useWebSocket({
    url: 'wss://example.com',
    sessionId: 'session_123',
    appId: 'app_456',
  });
  capture.current = api;
  return React.createElement('Probe', { 'data-status': api.status });
}

/** Parsed action frames sent on the latest socket. */
function sentActionFrames(): Array<{ type: string; payload: ActionEnvelope }> {
  const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
  if (!ws) return [];
  return ws.sentMessages
    .map((raw) => JSON.parse(raw) as { type: string; payload: ActionEnvelope })
    .filter((frame) => frame.type === 'action');
}

describe('useWebSocket (react-native)', () => {
  let originalWebSocket: typeof WebSocket;
  let tree: ReactTestRenderer | null = null;
  const capture: { current: UseWebSocketReturn | null } = { current: null };

  beforeEach(() => {
    originalWebSocket = global.WebSocket;
    // @ts-expect-error -- installing the test mock over the global
    global.WebSocket = MockWebSocket;
    MockWebSocket.instances = [];
    capture.current = null;
    vi.useFakeTimers();
  });

  afterEach(() => {
    tree?.unmount();
    tree = null;
    global.WebSocket = originalWebSocket;
    vi.useRealTimers();
  });

  async function mountAndConnect(): Promise<void> {
    await act(async () => {
      tree = create(React.createElement(Probe, { capture }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
  }

  it('connects and updates status', async () => {
    await act(async () => {
      tree = create(React.createElement(Probe, { capture }));
    });
    expect(capture.current?.status).toBe('connecting');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(capture.current?.status).toBe('connected');
  });

  it('sendAction stamps schemaVersion when the envelope omits it', async () => {
    await mountAndConnect();

    const envelope: ActionEnvelope = {
      sessionId: 'session_123',
      type: 'data:submit',
      payload: { action: 'submit', data: { text: 'hi' } },
      clientSeq: 1,
    };
    act(() => {
      capture.current?.sendAction(envelope);
    });

    const frames = sentActionFrames();
    expect(frames).toHaveLength(1);
    const sent = frames[0]!.payload;
    expect(sent.sessionId).toBe('session_123');
    expect(sent.type).toBe('data:submit');
    expect(sent.clientSeq).toBe(1);
    expect(sent.payload).toEqual({ action: 'submit', data: { text: 'hi' } });
    // The re-stamp (shared with the web hook) fills the version in.
    expect(typeof sent.schemaVersion).toBe('string');
    expect((sent.schemaVersion as string).length).toBeGreaterThan(0);
  });

  it('sendAction preserves an explicit schemaVersion', async () => {
    await mountAndConnect();

    const envelope: ActionEnvelope = {
      sessionId: 'session_123',
      type: 'data:submit',
      payload: { action: 'submit' },
      schemaVersion: 'draft-from-caller',
    };
    act(() => {
      capture.current?.sendAction(envelope);
    });

    const frames = sentActionFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]!.payload.schemaVersion).toBe('draft-from-caller');
  });

  it('send passes raw WebSocket messages through', async () => {
    await mountAndConnect();

    act(() => {
      capture.current?.send({ type: 'ping', payload: {} });
    });

    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
    const raw = ws.sentMessages.map((m) => JSON.parse(m) as { type: string });
    expect(raw.some((f) => f.type === 'ping')).toBe(true);
  });

  it('sets lastError when an error frame arrives', async () => {
    await mountAndConnect();
    expect(capture.current?.lastError).toBeNull();

    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
    act(() => {
      ws.simulateMessage({
        type: 'error',
        payload: { code: 'TEST_ERROR', message: 'boom' },
      });
    });
    expect(capture.current?.lastError?.message).toBe('boom');
  });

  it('disconnects on unmount', async () => {
    await mountAndConnect();
    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;

    await act(async () => {
      tree?.unmount();
      tree = null;
    });
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
  });
});
