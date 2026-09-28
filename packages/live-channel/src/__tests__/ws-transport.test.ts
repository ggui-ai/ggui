import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WSTransport,
  type ChannelHandler,
} from '../index.js';

/**
 * Fake socket that mimics enough of the WebSocket lifecycle for the
 * transport's onopen / onmessage / onclose paths. Tests pump events
 * directly via `triggerOpen()` / `triggerMessage()` / `triggerClose()`.
 *
 * `readyState` mirrors the real values: 0=CONNECTING, 1=OPEN,
 * 2=CLOSING, 3=CLOSED — matching `WebSocket.OPEN === 1` so the
 * transport's `socket.readyState === WebSocket.OPEN` check works
 * against the fake just like a real socket.
 */
class FakeSocket {
  readyState = 0;
  sent: string[] = [];
  closeCalled = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e?: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closeCalled = true;
    this.readyState = 3;
  }
  triggerOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  triggerMessage(payload: object): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }
  triggerClose(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }
}

const SUBSCRIBE_FRAME = { type: 'subscribe', payload: { sessionId: 's', appId: 'a', bootstrap: 'tok' } };

describe('WSTransport — open + dispatch', () => {
  let fake: FakeSocket;
  let transport: WSTransport;

  beforeEach(() => {
    fake = new FakeSocket();
  });

  afterEach(async () => {
    await transport?.dispose();
  });

  it('sends subscribe frame on open and routes messages by type', () => {
    const propsHandler = vi.fn();
    const drainHandler = vi.fn();
    const handlers = new Map<string, ChannelHandler>([
      ['props_update', { type: 'props_update', onMessage: propsHandler }],
      ['drain_ack', { type: 'drain_ack', onMessage: drainHandler }],
    ]);
    transport = new WSTransport({
      url: 'ws://test/ws',
      subscribeFrame: () => SUBSCRIBE_FRAME,
      handlers,
      webSocketFactory: () => fake as unknown as WebSocket,
    });
    transport.start();
    fake.triggerOpen();
    // Subscribe frame fired.
    expect(JSON.parse(fake.sent[0])).toEqual(SUBSCRIBE_FRAME);
    // Inbound dispatch.
    fake.triggerMessage({ type: 'props_update', payload: { sessionId: 'x' } });
    expect(propsHandler).toHaveBeenCalledWith({ sessionId: 'x' });
    fake.triggerMessage({ type: 'drain_ack', payload: { eventId: 'evt-1' } });
    expect(drainHandler).toHaveBeenCalledWith({ eventId: 'evt-1' });
  });

  it('ignores pong heartbeats', () => {
    const handler = vi.fn();
    const handlers = new Map<string, ChannelHandler>([
      ['pong', { type: 'pong', onMessage: handler }],
    ]);
    transport = new WSTransport({
      url: 'ws://test/ws',
      subscribeFrame: () => SUBSCRIBE_FRAME,
      handlers,
      webSocketFactory: () => fake as unknown as WebSocket,
    });
    transport.start();
    fake.triggerOpen();
    fake.triggerMessage({ type: 'pong', payload: {} });
    expect(handler).not.toHaveBeenCalled();
  });

  it('drops frames of unrecognized type silently', () => {
    const handler = vi.fn();
    const handlers = new Map<string, ChannelHandler>([
      ['props_update', { type: 'props_update', onMessage: handler }],
    ]);
    transport = new WSTransport({
      url: 'ws://test/ws',
      subscribeFrame: () => SUBSCRIBE_FRAME,
      handlers,
      webSocketFactory: () => fake as unknown as WebSocket,
    });
    transport.start();
    fake.triggerOpen();
    fake.triggerMessage({ type: 'some_unknown_type', payload: {} });
    expect(handler).not.toHaveBeenCalled();
  });

  it('absorbs handler throws so one bad handler does not break the loop', () => {
    const survivor = vi.fn();
    const handlers = new Map<string, ChannelHandler>([
      [
        'bad',
        {
          type: 'bad',
          onMessage: () => {
            throw new Error('boom');
          },
        },
      ],
      ['good', { type: 'good', onMessage: survivor }],
    ]);
    transport = new WSTransport({
      url: 'ws://test/ws',
      subscribeFrame: () => SUBSCRIBE_FRAME,
      handlers,
      webSocketFactory: () => fake as unknown as WebSocket,
    });
    transport.start();
    fake.triggerOpen();
    fake.triggerMessage({ type: 'bad', payload: {} });
    fake.triggerMessage({ type: 'good', payload: {} });
    expect(survivor).toHaveBeenCalled();
  });
});

describe('WSTransport — lifecycle', () => {
  it('dispose() closes the socket and short-circuits further events', async () => {
    const fake = new FakeSocket();
    const handler = vi.fn();
    const handlers = new Map<string, ChannelHandler>([
      ['props_update', { type: 'props_update', onMessage: handler }],
    ]);
    const transport = new WSTransport({
      url: 'ws://test/ws',
      subscribeFrame: () => SUBSCRIBE_FRAME,
      handlers,
      webSocketFactory: () => fake as unknown as WebSocket,
    });
    transport.start();
    fake.triggerOpen();
    await transport.dispose();
    expect(fake.closeCalled).toBe(true);
    // Disposed transport ignores subsequent triggers.
    fake.triggerMessage({ type: 'props_update', payload: {} });
    expect(handler).not.toHaveBeenCalled();
  });

  it('send() queues frames pre-open and drains on connect', () => {
    const fake = new FakeSocket();
    const handlers = new Map<string, ChannelHandler>();
    const transport = new WSTransport({
      url: 'ws://test/ws',
      subscribeFrame: () => SUBSCRIBE_FRAME,
      handlers,
      webSocketFactory: () => fake as unknown as WebSocket,
    });
    transport.start();
    // Pre-open: queues
    transport.send({ type: 'action', payload: { foo: 1 } });
    expect(fake.sent).toEqual([]);
    fake.triggerOpen();
    // Subscribe sent first, then drained queue.
    const sent = fake.sent.map((s) => JSON.parse(s));
    expect(sent[0]).toEqual(SUBSCRIBE_FRAME);
    expect(sent[1]).toEqual({ type: 'action', payload: { foo: 1 } });
  });

  it('marks status failed when the WebSocket constructor throws', () => {
    const handlers = new Map<string, ChannelHandler>();
    const transport = new WSTransport({
      url: 'ws://bogus',
      subscribeFrame: () => SUBSCRIBE_FRAME,
      handlers,
      webSocketFactory: () => {
        throw new Error('CSP refused');
      },
    });
    transport.start();
    expect(transport.status).toBe('failed');
  });
});

describe('WSTransport — fail-fast on never-opened-close', () => {
  it('fails fast after two consecutive never-opened closes', () => {
    // Empirical motivation: Claude Desktop's iframe sandbox refuses
    // `wss://` at the CSP layer — the browser closes without ever
    // dispatching `onopen`. The default 10-attempt retry ladder (≈5
    // min) burns UX-relevant time with no chance of success.
    let socketsCreated = 0;
    const fakes: FakeSocket[] = [];
    const handlers = new Map<string, ChannelHandler>();
    const statuses: string[] = [];
    const transport = new WSTransport({
      url: 'ws://csp-blocked',
      subscribeFrame: () => SUBSCRIBE_FRAME,
      handlers,
      onStatusChange: (s) => statuses.push(s),
      webSocketFactory: () => {
        socketsCreated += 1;
        const f = new FakeSocket();
        fakes.push(f);
        return f as unknown as WebSocket;
      },
    });
    transport.start();
    // Attempt 1: closes without ever opening — should arm the streak.
    fakes[0]!.triggerClose(1006);
    expect(transport.status).toBe('closed');
    // Reconnect timer hasn't fired yet; force-trigger by re-starting.
    // (The reconnect ladder schedules a setTimeout — we simulate the
    // next attempt directly to keep the test sync.)
    transport.start();
    expect(socketsCreated).toBe(2);
    fakes[1]!.triggerClose(1006);
    // After two consecutive never-opened closes the transport bails.
    expect(transport.status).toBe('failed');
    expect(statuses).toContain('failed');
    // No additional sockets get spawned — the retry ladder is short-
    // circuited.
    expect(socketsCreated).toBe(2);
  });

  it('resets the streak when a successful open intervenes', () => {
    const fakes: FakeSocket[] = [];
    const handlers = new Map<string, ChannelHandler>();
    const transport = new WSTransport({
      url: 'ws://flaky',
      subscribeFrame: () => SUBSCRIBE_FRAME,
      handlers,
      webSocketFactory: () => {
        const f = new FakeSocket();
        fakes.push(f);
        return f as unknown as WebSocket;
      },
    });
    transport.start();
    // Attempt 1: closes without open (streak=1)
    fakes[0]!.triggerClose(1006);
    transport.start();
    // Attempt 2: opens THEN closes (streak resets)
    fakes[1]!.triggerOpen();
    fakes[1]!.triggerClose(1006);
    transport.start();
    // Attempt 3: closes without open (streak=1 again, not 2)
    fakes[2]!.triggerClose(1006);
    expect(transport.status).toBe('closed'); // not 'failed'
  });
});

/**
 * ggui#1496 — the retry budget resets when the consumer says the server
 * ACCEPTED the subscription, not when the socket merely opens. The
 * library stays protocol-unaware: the consumer's `classifyFrame` reads a
 * frame's meaning, the transport only applies the verdict.
 */
describe('WSTransport — retry budget follows the consumer verdict (ggui#1496)', () => {
  const REFUSAL = { type: 'error', payload: { code: 'SOME_TRANSIENT_REFUSAL', message: 'not now' } };
  const AUTH_REFUSAL = { type: 'error', payload: { code: 'BOOTSTRAP_EXPIRED', message: 'expired' } };
  const ACK = { type: 'ack', payload: {} };
  const classifyFrame = (frame: { readonly type: string; readonly payload: unknown }) => {
    if (frame.type === 'ack') return 'accepted' as const;
    const p = frame.payload;
    if (frame.type === 'error' && typeof p === 'object' && p !== null && 'code' in p && p.code === 'BOOTSTRAP_EXPIRED') {
      return 'refused-terminal' as const;
    }
    return undefined;
  };

  function harness(withClassifier: boolean) {
    const fakes: FakeSocket[] = [];
    const statuses: string[] = [];
    const errorsSeen: unknown[] = [];
    const handlers = new Map<string, ChannelHandler>([
      ['error', { type: 'error', onMessage: (payload: unknown) => { errorsSeen.push(payload); } }],
    ]);
    const transport = new WSTransport({
      url: 'ws://refusing',
      subscribeFrame: () => SUBSCRIBE_FRAME,
      handlers,
      onStatusChange: (s) => statuses.push(s),
      ...(withClassifier ? { classifyFrame } : {}),
      webSocketFactory: () => {
        const f = new FakeSocket();
        fakes.push(f);
        return f as unknown as WebSocket;
      },
    });
    /** One attempt that opens, is refused by the server, and is closed. */
    const openThenRefuse = (): void => {
      const f = fakes[fakes.length - 1]!;
      f.triggerOpen();
      f.triggerMessage(REFUSAL);
      f.triggerClose(1008);
      vi.advanceTimersByTime(60_000);
    };
    return { fakes, statuses, errorsSeen, transport, openThenRefuse };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a socket that opens and is refused, again and again, reaches failed after the retry budget', async () => {
    const h = harness(true);
    h.transport.start();
    for (let i = 0; i < 12; i += 1) {
      if (h.transport.status === 'failed') break;
      h.openThenRefuse();
    }
    expect(h.transport.status).toBe('failed');
    // The first socket plus MAX_RECONNECT_ATTEMPTS (10) retries, and no more.
    expect(h.fakes).toHaveLength(11);
    await h.transport.dispose();
  });

  it('an accepted subscription that holds resets the budget', async () => {
    const h = harness(true);
    h.transport.start();
    for (let i = 0; i < 9; i += 1) h.openThenRefuse();
    // The tenth socket is accepted, runs past the hold window, and then drops.
    const accepted = h.fakes[h.fakes.length - 1]!;
    accepted.triggerOpen();
    accepted.triggerMessage(ACK);
    vi.advanceTimersByTime(5_001);
    accepted.triggerClose(1006);
    vi.advanceTimersByTime(60_000);
    for (let i = 0; i < 9; i += 1) h.openThenRefuse();
    expect(h.transport.status).not.toBe('failed');
    await h.transport.dispose();
  });

  it('an ack followed by a close inside the hold window does not reset the budget: a repeating ack-then-close reaches failed (ggui#1533)', async () => {
    const h = harness(true);
    h.transport.start();
    for (let i = 0; i < 12; i += 1) {
      if (h.transport.status === 'failed') break;
      const f = h.fakes[h.fakes.length - 1]!;
      f.triggerOpen();
      f.triggerMessage(ACK);
      // The server's subscribe fails after its ack and closes at once.
      f.triggerClose(1011);
      vi.advanceTimersByTime(60_000);
    }
    expect(h.transport.status).toBe('failed');
    // The first socket plus MAX_RECONNECT_ATTEMPTS (10) retries, as for any refusal.
    expect(h.fakes).toHaveLength(11);
    await h.transport.dispose();
  });

  it('a repeating ack-then-1012 takes the 100 ms service-restart retry once, then backs off (ggui#1533)', async () => {
    const h = harness(true);
    h.transport.start();
    const openAckClose = (): void => {
      const f = h.fakes[h.fakes.length - 1]!;
      f.triggerOpen();
      f.triggerMessage(ACK);
      f.triggerClose(1012);
    };
    openAckClose();
    vi.advanceTimersByTime(100);
    expect(h.fakes).toHaveLength(2);
    openAckClose();
    // The second retry is no longer the service-restart fast path.
    vi.advanceTimersByTime(100);
    expect(h.fakes).toHaveLength(2);
    vi.advanceTimersByTime(60_000);
    expect(h.fakes).toHaveLength(3);
    await h.transport.dispose();
  });

  it('an auth-class refusal fails at once, is still handed to the consumer, and is never retried with the same credential', async () => {
    const h = harness(true);
    h.transport.start();
    const f = h.fakes[0]!;
    f.triggerOpen();
    f.triggerMessage(AUTH_REFUSAL);
    // The transport closes the refused socket itself.
    expect(f.closeCalled).toBe(true);
    f.triggerClose(1000);
    vi.advanceTimersByTime(10 * 60_000);
    expect(h.transport.status).toBe('failed');
    expect(h.statuses.at(-1)).toBe('failed');
    expect(h.errorsSeen).toEqual([AUTH_REFUSAL.payload]);
    expect(h.fakes).toHaveLength(1);
    await h.transport.dispose();
  });

  it('without a classifier, the budget still resets on open (behaviour unchanged for consumers that do not opt in)', async () => {
    const h = harness(false);
    h.transport.start();
    for (let i = 0; i < 15; i += 1) h.openThenRefuse();
    expect(h.transport.status).not.toBe('failed');
    await h.transport.dispose();
  });
});
