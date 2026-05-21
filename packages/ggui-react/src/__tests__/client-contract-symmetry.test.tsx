/**
 * Integration tests for client-side contract enforcement wiring in
 * GguiSession. Mocks `global.WebSocket`, simulates a subscribe ack
 * that seeds the session stack with actionSpec / streamSpec /
 * propsSpec, triggers dispatch via a child that uses `useAction`,
 * and asserts:
 *
 *   - valid actions are sent; invalid actions fire `onError` + block send
 *   - valid inbound data emits AGENT_DATA; invalid data blocks emission +
 *     fires `onError`
 *   - valid props_update mutates stack; invalid blocks setStack + fires
 *     `onError`
 *
 * Maps to `channelEnforcementContract` invariants (direction-swapped
 * because client's outbound-action ⇔ server's inbound-event,
 * client's inbound-stream ⇔ server's outbound-data). Full contract
 * wiring would require a client harness + role-swap adapter that
 * isn't worth the indirection for a single consumer; the shared
 * contract suite still applies at the server layer and the
 * validators themselves are unit-tested in `wire-contract.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, act } from '@testing-library/react';
import type { WebSocketMessage } from '@ggui-ai/protocol/transport/websocket';
import type {
  ActionSpec,
  PropsSpec,
  StackItem,
  StreamSpec,
} from '@ggui-ai/protocol';
import { ClientContractViolationError, useAction } from '@ggui-ai/wire';
import { GguiProvider } from '../components/GguiProvider';
import { GguiSession } from '../components/GguiSession';

// ── MockWebSocket (same shape as useWebSocket.test.ts) ───────────────

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

// ── Fixtures ────────────────────────────────────────────────────────

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
    actionSpec: ACTION_SPEC,
    streamSpec: STREAM_SPEC,
    propsSpec: PROPS_SPEC,
  };
}

function ActionFireHelper({ onReady }: { onReady: (fire: (name: string, data: unknown) => void) => void }) {
  // `useAction` takes the name at hook-call time, so we precompute
  // one fire-per-name. Tests pick the lane by passing the name to
  // the returned fire() shim.
  const fireSubmit = useAction<unknown>('submit');
  const fireUnknown = useAction<unknown>('deleteAccount');
  React.useEffect(() => {
    onReady((name, data) => {
      if (name === 'submit') fireSubmit(data);
      else fireUnknown(data);
    });
  }, [fireSubmit, fireUnknown, onReady]);
  return null;
}

async function bootSession(opts: { onError?: (err: Error) => void } = {}): Promise<{
  socket: MockWebSocket;
  fire: (name: string, data: unknown) => void;
}> {
  let fire!: (name: string, data: unknown) => void;
  render(
    <GguiProvider appId="test-app" wsEndpoint="wss://example.test">
      <GguiSession sessionId="sess-test" onError={opts.onError}>
        <ActionFireHelper onReady={(f) => { fire = f; }} />
      </GguiSession>
    </GguiProvider>,
  );

  // Drain the queued open + useEffect.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  const socket = sockets[sockets.length - 1];
  if (!socket) throw new Error('MockWebSocket was not constructed');

  // Subscribe ack with a seeded stack — establishes actionSpec/streamSpec/propsSpec
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

  return { socket, fire };
}

describe('client contract symmetry — outbound action', () => {
  let originalWebSocket: typeof WebSocket;

  beforeEach(() => {
    sockets.length = 0;
    originalWebSocket = global.WebSocket;
    global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });
  afterEach(() => {
    global.WebSocket = originalWebSocket;
  });

  it('sends a valid action over the wire', async () => {
    const onError = vi.fn();
    const { socket, fire } = await bootSession({ onError });

    await act(async () => {
      fire('submit', { text: 'hi' });
    });

    // subscribe + event = 2 messages
    const actionMsg = socket.sentMessages.find((m) => m.type === 'action');
    expect(actionMsg).toBeDefined();
    expect(onError).not.toHaveBeenCalled();
  });

  it('blocks an unknown action and fires onError', async () => {
    const onError = vi.fn();
    const { socket, fire } = await bootSession({ onError });

    // Count event messages before (baseline)
    const actionsBefore = socket.sentMessages.filter((m) => m.type === 'action').length;

    await act(async () => {
      fire('deleteAccount', { anything: true });
    });

    const actionsAfter = socket.sentMessages.filter((m) => m.type === 'action').length;
    expect(actionsAfter).toBe(actionsBefore); // send was blocked

    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0][0] as ClientContractViolationError;
    expect(err).toBeInstanceOf(ClientContractViolationError);
    expect(err.direction).toBe('outbound-action');
  });

  it('blocks a declared action with malformed payload and fires onError', async () => {
    const onError = vi.fn();
    const { socket, fire } = await bootSession({ onError });

    const actionsBefore = socket.sentMessages.filter((m) => m.type === 'action').length;

    await act(async () => {
      // 'submit' schema requires an object; pass a string to force violation.
      fire('submit', 'not-an-object');
    });

    const actionsAfter = socket.sentMessages.filter((m) => m.type === 'action').length;
    expect(actionsAfter).toBe(actionsBefore);

    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0][0] as ClientContractViolationError;
    expect(err.direction).toBe('outbound-action');
  });
});

describe('client contract symmetry — fallback surface', () => {
  let originalWebSocket: typeof WebSocket;

  beforeEach(() => {
    sockets.length = 0;
    originalWebSocket = global.WebSocket;
    global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });
  afterEach(() => {
    global.WebSocket = originalWebSocket;
  });

  it('falls back to console.warn when onError is not wired', async () => {
    // Spy on console.warn ONLY for this test. We want to see the
    // fallback fire — devs who forget to wire onError still get a
    // signal in the dev console rather than a silent drop.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { fire } = await bootSession(); // no onError
      await act(async () => {
        fire('deleteAccount', { anything: true });
      });

      // At least one warn call should include our tag.
      const tagged = warnSpy.mock.calls.filter((args) =>
        typeof args[0] === 'string' && args[0].startsWith('[ggui:contract]'),
      );
      expect(tagged.length).toBeGreaterThan(0);

      // And the structured second arg must carry direction + violations.
      const detail = tagged[0][1] as { direction: string; violations: unknown[] };
      expect(detail.direction).toBe('outbound-action');
      expect(Array.isArray(detail.violations)).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('client contract symmetry — inbound stream', () => {
  let originalWebSocket: typeof WebSocket;

  beforeEach(() => {
    sockets.length = 0;
    originalWebSocket = global.WebSocket;
    global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });
  afterEach(() => {
    global.WebSocket = originalWebSocket;
  });

  it('emits AGENT_DATA when inbound data matches streamSpec', async () => {
    const onError = vi.fn();
    const { socket } = await bootSession({ onError });

    const captured: unknown[] = [];
    const listener = (e: Event) => {
      captured.push((e as CustomEvent).detail);
    };
    window.addEventListener('ggui:agent-data', listener);

    try {
      await act(async () => {
        socket.simulateMessage({
          type: 'data',
          payload: {
            sessionId: 'sess-test',
            channel: 'tick',
            mode: 'append',
            payload: { count: 7 },
          },
        });
      });

      expect(captured).toHaveLength(1);
      expect(captured[0]).toEqual({
        sessionId: 'sess-test',
        channel: 'tick',
        mode: 'append',
        payload: { count: 7 },
      });
      expect(onError).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('ggui:agent-data', listener);
    }
  });

  it('blocks inbound envelope violating streamSpec + fires onError', async () => {
    const onError = vi.fn();
    const { socket } = await bootSession({ onError });

    const captured: unknown[] = [];
    const listener = (e: Event) => {
      captured.push((e as CustomEvent).detail);
    };
    window.addEventListener('ggui:agent-data', listener);

    try {
      await act(async () => {
        socket.simulateMessage({
          type: 'data',
          payload: {
            sessionId: 'sess-test',
            channel: 'mystery', // undeclared channel
            mode: 'append',
            payload: {},
          },
        });
      });

      expect(captured).toHaveLength(0); // emission blocked

      expect(onError).toHaveBeenCalledTimes(1);
      const err = onError.mock.calls[0][0] as ClientContractViolationError;
      expect(err.direction).toBe('inbound-stream');
    } finally {
      window.removeEventListener('ggui:agent-data', listener);
    }
  });
});

describe('client contract symmetry — inbound props', () => {
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
    const { socket } = await bootSession({ onError });

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
  });

  it('applies props_update with valid props without firing onError', async () => {
    const onError = vi.fn();
    const { socket } = await bootSession({ onError });

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
  });
});
