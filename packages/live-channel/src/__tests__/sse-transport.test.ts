import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SSETransport,
  type ChannelHandler,
} from '../index.js';

/**
 * Fake EventSource that mimics enough of the lifecycle for the
 * transport's onopen / onmessage / onerror paths — modeled on the
 * FakeSocket fixture in ws-transport.test.ts. Tests pump events
 * directly via `triggerOpen()` / `triggerMessage()` / `triggerError()`.
 *
 * `readyState` mirrors the real values: 0=CONNECTING, 1=OPEN,
 * 2=CLOSED. jsdom has no EventSource global, so every test injects a
 * factory returning this fake (the missing-global path is itself a
 * test case below).
 */
class FakeEventSource {
  readyState = 0;
  closeCalled = false;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  constructor(readonly url: string) {}
  close(): void {
    this.closeCalled = true;
    this.readyState = 2;
  }
  triggerOpen(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  triggerMessage(frame: object, lastEventId = ''): void {
    this.onmessage?.({
      data: JSON.stringify(frame),
      lastEventId,
    } as MessageEvent);
  }
  triggerError(readyState: 0 | 2): void {
    this.readyState = readyState;
    this.onerror?.(new Event('error'));
  }
}

/** Factory helper: collects every created fake for multi-instance tests. */
function makeFactory(): {
  sources: FakeEventSource[];
  factory: (url: string) => EventSource;
} {
  const sources: FakeEventSource[] = [];
  return {
    sources,
    factory: (url: string) => {
      const s = new FakeEventSource(url);
      sources.push(s);
      return s as unknown as EventSource;
    },
  };
}

const SSE_URL = 'http://test/api/sessions/s/stream?wsToken=tok';

describe('SSETransport — open + dispatch', () => {
  let transport: SSETransport;

  afterEach(async () => {
    await transport?.dispose();
  });

  it('dispatches ChannelFrame JSON by type to the handler map (same frames as WS)', () => {
    const propsHandler = vi.fn();
    const drainHandler = vi.fn();
    const handlers = new Map<string, ChannelHandler>([
      ['props_update', { type: 'props_update', onMessage: propsHandler }],
      ['drain_ack', { type: 'drain_ack', onMessage: drainHandler }],
    ]);
    const { sources, factory } = makeFactory();
    transport = new SSETransport({
      sse: { url: SSE_URL },
      handlers,
      eventSourceFactory: factory,
    });
    transport.start();
    sources[0]!.triggerOpen();
    expect(transport.status).toBe('open');
    sources[0]!.triggerMessage({ type: 'props_update', payload: { sessionId: 'x' } });
    expect(propsHandler).toHaveBeenCalledWith({ sessionId: 'x' });
    sources[0]!.triggerMessage({ type: 'drain_ack', payload: { eventId: 'evt-1' } });
    expect(drainHandler).toHaveBeenCalledWith({ eventId: 'evt-1' });
  });

  it('drops malformed JSON silently', () => {
    const handler = vi.fn();
    const handlers = new Map<string, ChannelHandler>([
      ['props_update', { type: 'props_update', onMessage: handler }],
    ]);
    const { sources, factory } = makeFactory();
    transport = new SSETransport({
      sse: { url: SSE_URL },
      handlers,
      eventSourceFactory: factory,
    });
    transport.start();
    sources[0]!.triggerOpen();
    sources[0]!.onmessage?.({ data: 'not json{', lastEventId: '' } as MessageEvent);
    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores pong frames (wire parity with WS)', () => {
    const handler = vi.fn();
    const handlers = new Map<string, ChannelHandler>([
      ['pong', { type: 'pong', onMessage: handler }],
    ]);
    const { sources, factory } = makeFactory();
    transport = new SSETransport({
      sse: { url: SSE_URL },
      handlers,
      eventSourceFactory: factory,
    });
    transport.start();
    sources[0]!.triggerOpen();
    sources[0]!.triggerMessage({ type: 'pong', payload: {} });
    expect(handler).not.toHaveBeenCalled();
  });

  it('drops frames of unrecognized type silently', () => {
    const handler = vi.fn();
    const handlers = new Map<string, ChannelHandler>([
      ['props_update', { type: 'props_update', onMessage: handler }],
    ]);
    const { sources, factory } = makeFactory();
    transport = new SSETransport({
      sse: { url: SSE_URL },
      handlers,
      eventSourceFactory: factory,
    });
    transport.start();
    sources[0]!.triggerOpen();
    sources[0]!.triggerMessage({ type: 'some_unknown_type', payload: {} });
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
    const { sources, factory } = makeFactory();
    transport = new SSETransport({
      sse: { url: SSE_URL },
      handlers,
      eventSourceFactory: factory,
    });
    transport.start();
    sources[0]!.triggerOpen();
    sources[0]!.triggerMessage({ type: 'bad', payload: {} });
    sources[0]!.triggerMessage({ type: 'good', payload: {} });
    expect(survivor).toHaveBeenCalled();
  });
});

describe('SSETransport — sequence cursor', () => {
  let transport: SSETransport;

  afterEach(async () => {
    await transport?.dispose();
  });

  it('fires onSequence with the parsed lastEventId of a dispatched frame', () => {
    const onSequence = vi.fn();
    const handlers = new Map<string, ChannelHandler>([
      ['render_event', { type: 'render_event', onMessage: () => {} }],
    ]);
    const { sources, factory } = makeFactory();
    transport = new SSETransport({
      sse: { url: SSE_URL, onSequence },
      handlers,
      eventSourceFactory: factory,
    });
    transport.start();
    sources[0]!.triggerOpen();
    sources[0]!.triggerMessage({ type: 'render_event', payload: { n: 1 } }, '7');
    expect(onSequence).toHaveBeenCalledWith(7);
    expect(onSequence).toHaveBeenCalledTimes(1);
  });

  it('skips frames without a parseable id (empty, non-numeric, negative, fractional)', () => {
    const onSequence = vi.fn();
    const handlers = new Map<string, ChannelHandler>([
      ['render_event', { type: 'render_event', onMessage: () => {} }],
    ]);
    const { sources, factory } = makeFactory();
    transport = new SSETransport({
      sse: { url: SSE_URL, onSequence },
      handlers,
      eventSourceFactory: factory,
    });
    transport.start();
    sources[0]!.triggerOpen();
    // Live frames are id-less (same ephemeral posture as WS).
    sources[0]!.triggerMessage({ type: 'render_event', payload: {} }, '');
    sources[0]!.triggerMessage({ type: 'render_event', payload: {} }, 'abc');
    sources[0]!.triggerMessage({ type: 'render_event', payload: {} }, '-1');
    sources[0]!.triggerMessage({ type: 'render_event', payload: {} }, '1.5');
    expect(onSequence).not.toHaveBeenCalled();
  });

  it('appends &sinceSequence= from initialSinceSequence on first connect', () => {
    const { sources, factory } = makeFactory();
    transport = new SSETransport({
      sse: { url: SSE_URL, initialSinceSequence: 42 },
      handlers: new Map<string, ChannelHandler>(),
      eventSourceFactory: factory,
    });
    transport.start();
    expect(sources[0]!.url).toBe(`${SSE_URL}&sinceSequence=42`);
  });

  it('uses ? as the separator when the URL has no query yet', () => {
    const { sources, factory } = makeFactory();
    transport = new SSETransport({
      sse: { url: 'http://test/stream', initialSinceSequence: 3 },
      handlers: new Map<string, ChannelHandler>(),
      eventSourceFactory: factory,
    });
    transport.start();
    expect(sources[0]!.url).toBe('http://test/stream?sinceSequence=3');
  });

  it('omits the cursor query entirely when no initialSinceSequence is given', () => {
    const { sources, factory } = makeFactory();
    transport = new SSETransport({
      sse: { url: SSE_URL },
      handlers: new Map<string, ChannelHandler>(),
      eventSourceFactory: factory,
    });
    transport.start();
    expect(sources[0]!.url).toBe(SSE_URL);
  });

  it('re-seeds the cursor from the latest dispatched sequence on recreate', () => {
    const handlers = new Map<string, ChannelHandler>([
      ['render_event', { type: 'render_event', onMessage: () => {} }],
    ]);
    const { sources, factory } = makeFactory();
    transport = new SSETransport({
      sse: { url: SSE_URL, initialSinceSequence: 5 },
      handlers,
      eventSourceFactory: factory,
    });
    transport.start();
    expect(sources[0]!.url).toBe(`${SSE_URL}&sinceSequence=5`);
    sources[0]!.triggerOpen();
    sources[0]!.triggerMessage({ type: 'render_event', payload: {} }, '9');
    // Terminal close, then manual recreate (tests bypass the timer by
    // calling start() directly — same pattern as the WS reconnect tests).
    sources[0]!.triggerError(2);
    transport.start();
    expect(sources[1]!.url).toBe(`${SSE_URL}&sinceSequence=9`);
  });
});

describe('SSETransport — failure policy', () => {
  it('marks status failed when the factory throws (construct guard)', () => {
    const statuses: string[] = [];
    const transport = new SSETransport({
      sse: { url: SSE_URL },
      handlers: new Map<string, ChannelHandler>(),
      onStatusChange: (s) => statuses.push(s),
      eventSourceFactory: () => {
        throw new Error('CSP refused');
      },
    });
    transport.start();
    expect(transport.status).toBe('failed');
    expect(statuses).toContain('failed');
  });

  it('marks status failed when the EventSource global is missing (jsdom has none)', () => {
    // No eventSourceFactory injected → the default factory references
    // the global, which jsdom does not provide → ReferenceError →
    // construct guard → 'failed'. This is the graceful-degradation
    // path for Node < 22 / locked-down hosts.
    const transport = new SSETransport({
      sse: { url: SSE_URL },
      handlers: new Map<string, ChannelHandler>(),
    });
    transport.start();
    expect(transport.status).toBe('failed');
  });

  it('watchdog: a stream stuck CONNECTING for 2× heartbeat (50s) fails', () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    const { sources, factory } = makeFactory();
    const transport = new SSETransport({
      sse: { url: SSE_URL },
      handlers: new Map<string, ChannelHandler>(),
      onStatusChange: (s) => statuses.push(s),
      eventSourceFactory: factory,
    });
    transport.start();
    // Never opens; readyState stays CONNECTING (0) — the browser owns
    // an invisible internal retry loop the watchdog must bound.
    vi.advanceTimersByTime(25_000);
    expect(transport.status).toBe('connecting');
    vi.advanceTimersByTime(25_000);
    expect(transport.status).toBe('failed');
    expect(sources[0]!.closeCalled).toBe(true);
    vi.useRealTimers();
  });

  it('watchdog: tolerates a quiet-but-alive stream (readyState OPEN at each tick)', () => {
    vi.useFakeTimers();
    const { sources, factory } = makeFactory();
    const transport = new SSETransport({
      sse: { url: SSE_URL },
      handlers: new Map<string, ChannelHandler>(),
      eventSourceFactory: factory,
    });
    transport.start();
    sources[0]!.triggerOpen();
    // Heartbeat comments (`: hb`) never reach onmessage — a healthy
    // stream can be message-silent indefinitely. readyState OPEN at
    // each watchdog tick counts as liveness.
    vi.advanceTimersByTime(200_000);
    expect(transport.status).toBe('open');
    expect(sources[0]!.closeCalled).toBe(false);
    vi.useRealTimers();
  });

  it('terminal close (readyState CLOSED) under threshold recreates after the delay', () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    const { sources, factory } = makeFactory();
    const transport = new SSETransport({
      sse: { url: SSE_URL },
      handlers: new Map<string, ChannelHandler>(),
      onStatusChange: (s) => statuses.push(s),
      eventSourceFactory: factory,
    });
    transport.start();
    sources[0]!.triggerOpen();
    sources[0]!.triggerError(2);
    expect(transport.status).toBe('closed');
    expect(sources).toHaveLength(1);
    // The recreate timer fires start() after SSE_RECREATE_DELAY_MS.
    vi.advanceTimersByTime(1_000);
    expect(sources).toHaveLength(2);
    sources[1]!.triggerOpen();
    expect(transport.status).toBe('open');
    void transport.dispose();
    vi.useRealTimers();
  });

  it('second consecutive terminal close (no intervening open) → failed', () => {
    const statuses: string[] = [];
    const { sources, factory } = makeFactory();
    const transport = new SSETransport({
      sse: { url: SSE_URL },
      handlers: new Map<string, ChannelHandler>(),
      onStatusChange: (s) => statuses.push(s),
      eventSourceFactory: factory,
    });
    transport.start();
    // Instance 1 dies terminally without ever opening (non-200 /
    // content-type / CORS — the browser never retries from CLOSED).
    sources[0]!.triggerError(2);
    expect(transport.status).toBe('closed');
    // Bypass the recreate timer — same pattern as the WS tests.
    transport.start();
    expect(sources).toHaveLength(2);
    sources[1]!.triggerError(2);
    // 2-strike mirror of the WS never-opened precedent.
    expect(transport.status).toBe('failed');
    expect(statuses).toContain('failed');
  });

  it('a successful open resets the terminal-close streak', () => {
    const { sources, factory } = makeFactory();
    const transport = new SSETransport({
      sse: { url: SSE_URL },
      handlers: new Map<string, ChannelHandler>(),
      eventSourceFactory: factory,
    });
    transport.start();
    sources[0]!.triggerError(2); // streak = 1
    transport.start();
    sources[1]!.triggerOpen(); // streak resets
    sources[1]!.triggerError(2); // streak = 1 again, not 2
    expect(transport.status).toBe('closed'); // not 'failed'
    void transport.dispose();
  });

  it('onerror at readyState CONNECTING surfaces connecting and never counts toward the streak', () => {
    const { sources, factory } = makeFactory();
    const transport = new SSETransport({
      sse: { url: SSE_URL },
      handlers: new Map<string, ChannelHandler>(),
      eventSourceFactory: factory,
    });
    transport.start();
    sources[0]!.triggerOpen();
    // Browser-internal retry loop: repeated CONNECTING errors.
    sources[0]!.triggerError(0);
    sources[0]!.triggerError(0);
    sources[0]!.triggerError(0);
    expect(transport.status).toBe('connecting');
    // A single terminal close afterwards is still streak 1 → recreate,
    // not 'failed'.
    sources[0]!.triggerError(2);
    expect(transport.status).toBe('closed');
    void transport.dispose();
  });
});

describe('SSETransport — lifecycle', () => {
  it('dispose() closes the source and short-circuits further events', async () => {
    const handler = vi.fn();
    const handlers = new Map<string, ChannelHandler>([
      ['props_update', { type: 'props_update', onMessage: handler }],
    ]);
    const { sources, factory } = makeFactory();
    const transport = new SSETransport({
      sse: { url: SSE_URL },
      handlers,
      eventSourceFactory: factory,
    });
    transport.start();
    sources[0]!.triggerOpen();
    await transport.dispose();
    expect(sources[0]!.closeCalled).toBe(true);
    expect(transport.status).toBe('closed');
    // Disposed transport ignores subsequent triggers.
    sources[0]!.triggerMessage({ type: 'props_update', payload: {} });
    expect(handler).not.toHaveBeenCalled();
    // Idempotent.
    await transport.dispose();
  });

  it('dispose() cancels a pending recreate', async () => {
    vi.useFakeTimers();
    const { sources, factory } = makeFactory();
    const transport = new SSETransport({
      sse: { url: SSE_URL },
      handlers: new Map<string, ChannelHandler>(),
      eventSourceFactory: factory,
    });
    transport.start();
    sources[0]!.triggerError(2); // schedules recreate
    await transport.dispose();
    vi.advanceTimersByTime(10_000);
    expect(sources).toHaveLength(1); // no second instance
    vi.useRealTimers();
  });

  it('start() after dispose() is a no-op', () => {
    const { sources, factory } = makeFactory();
    const transport = new SSETransport({
      sse: { url: SSE_URL },
      handlers: new Map<string, ChannelHandler>(),
      eventSourceFactory: factory,
    });
    transport.start();
    void transport.dispose();
    transport.start();
    expect(sources).toHaveLength(1);
  });
});

describe('SSETransport — status listener robustness', () => {
  it('absorbs onStatusChange throws (channel_status_listener_throw parity)', () => {
    const warn = vi.fn();
    const { sources, factory } = makeFactory();
    const transport = new SSETransport({
      sse: { url: SSE_URL },
      handlers: new Map<string, ChannelHandler>(),
      logger: { warn },
      onStatusChange: () => {
        throw new Error('listener boom');
      },
      eventSourceFactory: factory,
    });
    transport.start();
    sources[0]!.triggerOpen();
    expect(transport.status).toBe('open');
    expect(warn).toHaveBeenCalledWith(
      'channel_status_listener_throw',
      expect.objectContaining({ error: 'listener boom' }),
    );
    void transport.dispose();
  });
});
