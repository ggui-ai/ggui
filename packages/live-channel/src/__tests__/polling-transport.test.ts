import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PollingTransport, type ChannelHandler } from '../index.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('PollingTransport — per-channel fetch loop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires immediately + on each interval, dispatching parsed payloads', async () => {
    const handler = vi.fn();
    const fetchImpl = vi.fn(async () => jsonResponse({ value: 42 }));
    const handlers = new Map<string, ChannelHandler>([
      [
        'tick',
        {
          type: 'tick',
          onMessage: handler,
          polling: {
            url: 'http://test/tick',
            intervalMs: 1000,
            parse: (body: unknown) =>
              (body as { value?: number }).value ?? null,
          },
        },
      ],
    ]);
    const transport = new PollingTransport({
      handlers,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    transport.start();
    // Immediate tick (microtask drain).
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledWith(42);
    expect(handler).toHaveBeenCalledTimes(1);
    // Interval tick.
    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(2);
    await transport.dispose();
  });

  it('skips dispatch when parse() returns null (no new payload)', async () => {
    const handler = vi.fn();
    const fetchImpl = vi.fn(async () => jsonResponse({ stale: true }));
    const handlers = new Map<string, ChannelHandler>([
      [
        'maybe',
        {
          type: 'maybe',
          onMessage: handler,
          polling: {
            url: 'http://test/maybe',
            intervalMs: 500,
            parse: () => null,
          },
        },
      ],
    ]);
    const transport = new PollingTransport({
      handlers,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    transport.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    await transport.dispose();
  });

  it('absorbs fetch failures and retries on next tick', async () => {
    const handler = vi.fn();
    let callCount = 0;
    const fetchImpl = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) throw new Error('network blip');
      return jsonResponse({ value: 7 });
    });
    const handlers = new Map<string, ChannelHandler>([
      [
        'tick',
        {
          type: 'tick',
          onMessage: handler,
          polling: {
            url: 'http://test/tick',
            intervalMs: 1000,
            parse: (b: unknown) => (b as { value?: number }).value ?? null,
          },
        },
      ],
    ]);
    const transport = new PollingTransport({
      handlers,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    transport.start();
    await vi.advanceTimersByTimeAsync(0); // first poll throws
    expect(handler).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000); // second poll succeeds
    expect(handler).toHaveBeenCalledWith(7);
    await transport.dispose();
  });

  it('treats 204 No Content as "nothing new this tick" without parsing', async () => {
    const handler = vi.fn();
    const parseSpy = vi.fn(() => 'should-not-call');
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const handlers = new Map<string, ChannelHandler>([
      [
        'gated',
        {
          type: 'gated',
          onMessage: handler,
          polling: {
            url: 'http://test/gated',
            intervalMs: 1000,
            parse: parseSpy,
          },
        },
      ],
    ]);
    const transport = new PollingTransport({
      handlers,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    transport.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(parseSpy).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    await transport.dispose();
  });

  it('ignores handlers without a polling descriptor', async () => {
    const wsOnlyHandler = vi.fn();
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const handlers = new Map<string, ChannelHandler>([
      // No `polling` field — should be inert under PollingTransport.
      ['ws_only', { type: 'ws_only', onMessage: wsOnlyHandler }],
    ]);
    const transport = new PollingTransport({
      handlers,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    transport.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(wsOnlyHandler).not.toHaveBeenCalled();
    await transport.dispose();
  });

  it('clamps sub-floor intervals to minPollIntervalMs', async () => {
    const handler = vi.fn();
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const handlers = new Map<string, ChannelHandler>([
      [
        'tight',
        {
          type: 'tight',
          onMessage: handler,
          polling: {
            url: 'http://test/tight',
            intervalMs: 50, // sub-floor — should clamp to 500
            parse: (b) => b,
          },
        },
      ],
    ]);
    const transport = new PollingTransport({
      handlers,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      minPollIntervalMs: 500,
    });
    transport.start();
    await vi.advanceTimersByTimeAsync(0); // immediate
    await vi.advanceTimersByTimeAsync(100); // below floor — no tick
    expect(handler).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(400); // crosses floor
    expect(handler).toHaveBeenCalledTimes(2);
    await transport.dispose();
  });
});

describe('PollingTransport — lifecycle', () => {
  it('dispose() stops further polls', async () => {
    vi.useFakeTimers();
    const handler = vi.fn();
    const fetchImpl = vi.fn(async () => jsonResponse({ value: 1 }));
    const handlers = new Map<string, ChannelHandler>([
      [
        'tick',
        {
          type: 'tick',
          onMessage: handler,
          polling: {
            url: 'http://test/tick',
            intervalMs: 1000,
            parse: (b: unknown) => (b as { value?: number }).value ?? null,
          },
        },
      ],
    ]);
    const transport = new PollingTransport({
      handlers,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    transport.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledTimes(1);
    await transport.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(handler).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
