/**
 * Canonical outbound ActionEnvelope emission — RN SDK.
 *
 * Complements `GguiSession.contract.test.tsx` (inbound enforcement)
 * with the outbound migration sister: verifies that actions fired
 * via the render-prop `api.action(data)` produce canonical
 * `type: 'action'` frames carrying ActionEnvelope shape.
 *
 * Scope limits (honest):
 *   - RN has no WireProvider / useAction hook, so there's no
 *     scoped-by-action-name dispatch. `api.action(data)` emits the
 *     whole `data` as the envelope payload — contract validation
 *     only fires when an actionSpec is resolvable from the stack.
 *   - The full actionSpec-validated outbound path lands with the
 *     WireProvider port (separate slice; tracked in
 *     `project_rn_contract_symmetry.md`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { create, act, type ReactTestRenderer } from 'react-test-renderer';
import type { WebSocketMessage } from '@ggui-ai/protocol/transport/websocket';
import type {
  ActionEnvelope,
  StackItem,
} from '@ggui-ai/protocol';
import { GguiProvider } from './GguiProvider';
import { GguiSession, type SessionApi } from './GguiSession';

// ── MockWebSocket ────────────────────────────────────────────────

const sockets: MockWebSocket[] = [];

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
  sentMessages: WebSocketMessage[] = [];

  constructor(public url: string) {
    sockets.push(this);
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.();
    });
  }

  send(data: string): void {
    try {
      this.sentMessages.push(JSON.parse(data) as WebSocketMessage);
    } catch {
      /* ignore malformed */
    }
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  simulateMessage(message: WebSocketMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

// ── Fixtures ────────────────────────────────────────────────────

function makeStackItem(): StackItem {
  return {
    id: 'page-0',
    componentCode: '/* stub */',
    createdAt: new Date().toISOString(),
    // No actionSpec — RN's action(data) path falls back to permissive
    // emission when no contract is declared (server remains
    // authoritative).
  };
}

async function bootSession(): Promise<{
  socket: MockWebSocket;
  apiRef: { current: SessionApi | null };
  tree: ReactTestRenderer;
}> {
  const apiRef: { current: SessionApi | null } = { current: null };

  function Child({ api }: { api: SessionApi }) {
    apiRef.current = api;
    return null;
  }

  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <GguiProvider appId="test-app" wsEndpoint="wss://example.test">
        <GguiSession sessionId="sess-test">
          {(api) => <Child api={api} />}
        </GguiSession>
      </GguiProvider>,
    );
  });

  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  const socket = sockets[sockets.length - 1];
  if (!socket) throw new Error('MockWebSocket was not constructed');

  await act(async () => {
    socket.simulateMessage({
      type: 'ack',
      payload: {
        sequence: 0,
        timestamp: Date.now(),
        stack: [makeStackItem()],
      },
    });
  });

  return { socket, apiRef, tree };
}

// ── Tests ────────────────────────────────────────────────────────

describe('canonical action envelope emission — RN', () => {
  let originalWebSocket: typeof WebSocket;

  beforeEach(() => {
    sockets.length = 0;
    originalWebSocket = global.WebSocket;
    // @ts-expect-error - Mock WebSocket
    global.WebSocket = MockWebSocket;
  });
  afterEach(() => {
    global.WebSocket = originalWebSocket;
    vi.restoreAllMocks();
  });

  it("emits a `type: 'action'` message carrying ActionEnvelope shape when api.action fires", async () => {
    const { socket, apiRef } = await bootSession();
    expect(apiRef.current).not.toBeNull();

    await act(async () => {
      apiRef.current!.action({ text: 'hello' });
    });

    const actionFrames = socket.sentMessages.filter((m) => m.type === 'action');
    expect(actionFrames).toHaveLength(1);

    const frame = actionFrames[0];
    if (frame.type !== 'action') throw new Error('narrowing');
    const envelope: ActionEnvelope = frame.payload;

    expect(envelope.sessionId).toBe('sess-test');
    expect(envelope.type).toBe('data:submit');
    expect(envelope.stackIndex).toBe(0);
    expect(envelope.stackItemId).toBe('page-0');
    expect(typeof envelope.clientSeq).toBe('number');
    // No actionSpec on the fixture — payload is the raw data (permissive
    // path). Full actionSpec-wrapped shape exercises when WireProvider
    // port lands; the shape here remains canonical envelope all the same.
    expect(envelope.payload).toEqual({ text: 'hello' });
  });

  it('clientSeq increments monotonically across multiple submissions', async () => {
    const { socket, apiRef } = await bootSession();

    await act(async () => {
      apiRef.current!.action({ text: 'one' });
    });
    await act(async () => {
      apiRef.current!.action({ text: 'two' });
    });
    await act(async () => {
      apiRef.current!.action({ text: 'three' });
    });

    const actionFrames = socket.sentMessages.filter((m) => m.type === 'action');
    expect(actionFrames).toHaveLength(3);
    const seqs = actionFrames.map((m) => {
      if (m.type !== 'action') throw new Error('narrowing');
      return m.payload.clientSeq;
    });
    expect(seqs[0]).toBeGreaterThan(0);
    expect(seqs[1]).toBeGreaterThan(seqs[0]!);
    expect(seqs[2]).toBeGreaterThan(seqs[1]!);
  });

});
