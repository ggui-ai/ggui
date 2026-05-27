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

const SUBSCRIBE_FRAME = { type: 'subscribe', payload: { renderId: 's', appId: 'a', bootstrap: 'tok' } };

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
    fake.triggerMessage({ type: 'props_update', payload: { renderId: 'x' } });
    expect(propsHandler).toHaveBeenCalledWith({ renderId: 'x' });
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
