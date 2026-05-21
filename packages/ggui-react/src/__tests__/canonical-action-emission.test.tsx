/**
 * ActionEnvelope emission — structural tests.
 *
 * Complements `client-contract-symmetry.test.tsx`, which asserts
 * valid-vs-invalid action semantics. This file asserts the WIRE SHAPE
 * of outbound messages: that the emitter produces the
 * {@link ActionEnvelope} form (`type: 'action'`) with the expected
 * fields (sessionId / type / payload / stackIndex / stackItemId / clientSeq).
 *
 * Structural locks that catch regressions:
 *   - every outbound submit is a `type: 'action'` message.
 *   - clientSeq increments monotonically across multiple submissions.
 *   - stackItemId is populated from the active stack item's id.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, act } from '@testing-library/react';
import type { WebSocketMessage } from '@ggui-ai/protocol/transport/websocket';
import type {
  ActionEnvelope,
  ActionSpec,
  StackItem,
} from '@ggui-ai/protocol';
import { useAction } from '@ggui-ai/wire';
import { GguiProvider } from '../components/GguiProvider';
import { GguiSession } from '../components/GguiSession';

// ── MockWebSocket (shared shape with client-contract-symmetry) ───────

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

// ── Fixtures ─────────────────────────────────────────────────────────

const ACTION_SPEC: ActionSpec = {
  submit: {
    label: 'Submit',
    schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
};

function makeStackItem(): StackItem {
  return {
    id: 'page-0',
    componentCode: '/* stub */',
    createdAt: new Date().toISOString(),
    actionSpec: ACTION_SPEC,
  };
}

function ActionFireHelper({
  onReady,
}: {
  onReady: (fire: (data: unknown) => void) => void;
}) {
  const fireSubmit = useAction<unknown>('submit');
  React.useEffect(() => {
    onReady(fireSubmit);
  }, [fireSubmit, onReady]);
  return null;
}

async function bootSession(): Promise<{
  socket: MockWebSocket;
  fire: (data: unknown) => void;
}> {
  let fire!: (data: unknown) => void;
  render(
    <GguiProvider appId="test-app" wsEndpoint="wss://example.test">
      <GguiSession sessionId="sess-test">
        <ActionFireHelper onReady={(f) => { fire = f; }} />
      </GguiSession>
    </GguiProvider>,
  );
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
  return { socket, fire };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('canonical action envelope emission — web', () => {
  let originalWebSocket: typeof WebSocket;

  beforeEach(() => {
    sockets.length = 0;
    originalWebSocket = global.WebSocket;
    global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });
  afterEach(() => {
    global.WebSocket = originalWebSocket;
  });

  it("emits a `type: 'action'` message carrying ActionEnvelope shape", async () => {
    const { socket, fire } = await bootSession();

    await act(async () => {
      fire({ text: 'hello' });
    });

    const actionFrames = socket.sentMessages.filter((m) => m.type === 'action');
    expect(actionFrames).toHaveLength(1);

    const frame = actionFrames[0];
    expect(frame.type).toBe('action');
    if (frame.type !== 'action') throw new Error('narrowing');
    const envelope: ActionEnvelope = frame.payload;

    expect(envelope.sessionId).toBe('sess-test');
    expect(envelope.type).toBe('data:submit');
    expect(envelope.stackIndex).toBe(0);
    expect(envelope.stackItemId).toBe('page-0');
    expect(typeof envelope.clientSeq).toBe('number');
    expect(envelope.payload).toEqual({
      action: 'submit',
      data: { text: 'hello' },
    });
  });

  it('clientSeq increments monotonically across multiple submissions', async () => {
    const { socket, fire } = await bootSession();

    await act(async () => {
      fire({ text: 'one' });
    });
    await act(async () => {
      fire({ text: 'two' });
    });
    await act(async () => {
      fire({ text: 'three' });
    });

    const actionFrames = socket.sentMessages.filter((m) => m.type === 'action');
    expect(actionFrames).toHaveLength(3);
    const seqs = actionFrames.map((m) => {
      if (m.type !== 'action') throw new Error('narrowing');
      return m.payload.clientSeq;
    });
    // seqs should be strictly increasing, each > 0.
    expect(seqs[0]).toBeGreaterThan(0);
    expect(seqs[1]).toBeGreaterThan(seqs[0]!);
    expect(seqs[2]).toBeGreaterThan(seqs[1]!);
  });

  it('envelope.stackItemId tracks the active stack item when it changes', async () => {
    const { socket, fire } = await bootSession();

    // First action against page-0.
    await act(async () => {
      fire({ text: 'first' });
    });

    // Agent pushes a new page.
    await act(async () => {
      socket.simulateMessage({
        type: 'push',
        payload: {
          stackItem: {
            id: 'page-1',
            componentCode: '/* stub */',
            createdAt: new Date().toISOString(),
            actionSpec: ACTION_SPEC,
          },
        },
      });
    });

    // Second action now targets page-1.
    await act(async () => {
      fire({ text: 'second' });
    });

    const actionFrames = socket.sentMessages.filter((m) => m.type === 'action');
    expect(actionFrames).toHaveLength(2);
    const firstEnv = actionFrames[0];
    const secondEnv = actionFrames[1];
    if (firstEnv.type !== 'action' || secondEnv.type !== 'action') {
      throw new Error('narrowing');
    }
    expect(firstEnv.payload.stackItemId).toBe('page-0');
    expect(firstEnv.payload.stackIndex).toBe(0);
    expect(secondEnv.payload.stackItemId).toBe('page-1');
    expect(secondEnv.payload.stackIndex).toBe(1);
  });
});
