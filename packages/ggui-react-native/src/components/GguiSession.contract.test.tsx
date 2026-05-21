/**
 * Integration tests for RN client-side contract enforcement in
 * GguiSession. Mocks `global.WebSocket`, mounts the session via
 * `react-test-renderer`, simulates a subscribe ack that seeds the
 * stack with streamSpec / propsSpec, fires inbound messages, and
 * asserts:
 *
 *   - valid inbound `data` passes (no onError)
 *   - invalid inbound `data` blocks emission + fires onError
 *   - valid `props_update` mutates stack + no onError
 *   - invalid `props_update` blocks setStack + fires onError
 *
 * Maps to the same channelEnforcementContract invariants the web
 * client satisfies — direction-symmetric (server's outbound-data
 * = client's inbound-stream; server's props-on-update = client's
 * inbound-props).
 *
 * Outbound canonical ActionEnvelope emission lives in
 * `GguiSession.outbound.test.tsx` (sibling file). Full actionSpec-
 * validated outbound (useAction-style) still needs the RN
 * WireProvider port — separate slice.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { create, act, type ReactTestRenderer } from 'react-test-renderer';
import type { WebSocketMessage } from '@ggui-ai/protocol/transport/websocket';
import type {
  PropsSpec,
  StackItem,
  StreamSpec,
} from '@ggui-ai/protocol';
import { ClientContractViolationError } from '@ggui-ai/wire';
import { GguiProvider } from './GguiProvider';
import { GguiSession } from './GguiSession';

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
    // Open in a microtask so the component's `onopen` handler wiring
    // has time to attach before we fire it.
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

// ── Fixtures ─────────────────────────────────────────────────────

const STREAM_SPEC: StreamSpec = {
  tick: {
    schema: {
      type: 'object',
      properties: { count: { type: 'number' } },
      required: ['count'],
    },
  },
};

const PROPS_SPEC: PropsSpec = {
  properties: {
    city: { required: true, schema: { type: 'string' } },
  },
};

function makeStackItem(): StackItem {
  return {
    id: 'page-0',
    componentCode: '/* stub */',
    createdAt: new Date().toISOString(),
    streamSpec: STREAM_SPEC,
    propsSpec: PROPS_SPEC,
  };
}

async function bootSession(onError?: (err: Error) => void): Promise<{
  socket: MockWebSocket;
  renderer: ReactTestRenderer;
}> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <GguiProvider appId="test-app" wsEndpoint="wss://example.test">
        <GguiSession sessionId="sess-rn-test" onError={onError}>
          <></>
        </GguiSession>
      </GguiProvider>,
    );
  });

  // Drain the microtask + effect queue so `new MockWebSocket()` fires
  // and the onopen handler lands.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  const socket = sockets[sockets.length - 1];
  if (!socket) throw new Error('MockWebSocket was not constructed');

  // Subscribe ack — seeds the stack with actionSpec/streamSpec/propsSpec
  // visible to the client's validation path.
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

  return { socket, renderer };
}

// ── Tests ────────────────────────────────────────────────────────

describe('RN client contract symmetry — inbound stream', () => {
  let originalWebSocket: typeof WebSocket;

  beforeEach(() => {
    sockets.length = 0;
    originalWebSocket = global.WebSocket;
    global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });
  afterEach(() => {
    global.WebSocket = originalWebSocket;
  });

  it('accepts inbound envelope matching streamSpec', async () => {
    const onError = vi.fn();
    const { socket, renderer } = await bootSession(onError);

    await act(async () => {
      socket.simulateMessage({
        type: 'data',
        payload: {
          sessionId: 'sess-rn-test',
          channel: 'tick',
          mode: 'append',
          payload: { count: 7 },
        },
      });
    });

    expect(onError).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it('blocks inbound envelope violating streamSpec + fires onError', async () => {
    const onError = vi.fn();
    const { socket, renderer } = await bootSession(onError);

    await act(async () => {
      socket.simulateMessage({
        type: 'data',
        payload: {
          sessionId: 'sess-rn-test',
          channel: 'mystery', // undeclared channel
          mode: 'append',
          payload: {},
        },
      });
    });

    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0][0] as ClientContractViolationError;
    expect(err).toBeInstanceOf(ClientContractViolationError);
    expect(err.direction).toBe('inbound-stream');
    renderer.unmount();
  });
});

describe('RN client contract symmetry — inbound props', () => {
  let originalWebSocket: typeof WebSocket;

  beforeEach(() => {
    sockets.length = 0;
    originalWebSocket = global.WebSocket;
    global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });
  afterEach(() => {
    global.WebSocket = originalWebSocket;
  });

  it('blocks props_update violating propsSpec + fires onError', async () => {
    const onError = vi.fn();
    const { socket, renderer } = await bootSession(onError);

    await act(async () => {
      socket.simulateMessage({
        type: 'props_update',
        payload: {
          stackItemId: 'page-0',
          props: { temp: 15 }, // missing required 'city'
        },
      });
    });

    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0][0] as ClientContractViolationError;
    expect(err.direction).toBe('inbound-props');
    renderer.unmount();
  });

  it('applies props_update with valid props + no onError', async () => {
    const onError = vi.fn();
    const { socket, renderer } = await bootSession(onError);

    await act(async () => {
      socket.simulateMessage({
        type: 'props_update',
        payload: {
          stackItemId: 'page-0',
          props: { city: 'Seoul' },
        },
      });
    });

    expect(onError).not.toHaveBeenCalled();
    renderer.unmount();
  });
});

describe('RN client contract symmetry — fallback surface', () => {
  let originalWebSocket: typeof WebSocket;

  beforeEach(() => {
    sockets.length = 0;
    originalWebSocket = global.WebSocket;
    global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });
  afterEach(() => {
    global.WebSocket = originalWebSocket;
  });

  it('falls back to console.warn when onError is unwired', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { socket, renderer } = await bootSession(); // no onError

      await act(async () => {
        socket.simulateMessage({
          type: 'data',
          payload: {
            sessionId: 'sess-rn-test',
            channel: 'mystery',
            mode: 'append',
            payload: {},
          },
        });
      });

      const tagged = warnSpy.mock.calls.filter((args) =>
        typeof args[0] === 'string' && args[0].startsWith('[ggui:contract]'),
      );
      expect(tagged.length).toBeGreaterThan(0);
      const detail = tagged[0][1] as { direction: string; violations: unknown[] };
      expect(detail.direction).toBe('inbound-stream');
      expect(Array.isArray(detail.violations)).toBe(true);
      renderer.unmount();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
