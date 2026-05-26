import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PollingTransport,
  type ChannelFrame,
  type ChannelHandler,
} from '../index.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * R6 (2026-05-26) — `PollingTransport` is registry-level: one URL, one
 * tick interval, one `parseSnapshot` that returns a `Record<type,
 * frame>` map. The transport dispatches each frame to its matching
 * registered handler. Pre-R6 per-handler `polling` descriptors are
 * deleted.
 */
describe('PollingTransport — registry-level fetch loop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires immediately + on each interval, dispatching frames by type', async () => {
    const handler = vi.fn();
    const fetchImpl = vi.fn(async () => jsonResponse({ value: 42 }));
    const handlers = new Map<string, ChannelHandler>([
      ['tick', { type: 'tick', onMessage: handler }],
    ]);
    const transport = new PollingTransport({
      handlers,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      polling: {
        url: 'http://test/snapshot',
        intervalMs: 1000,
        parseSnapshot: (body: unknown) => {
          const value = (body as { value?: number }).value;
          if (value === undefined) return null;
          const frame: ChannelFrame = { type: 'tick', payload: value };
          return { tick: frame };
        },
      },
    });
    transport.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledWith(42);
    expect(handler).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(2);
    await transport.dispose();
  });

  it('skips dispatch when parseSnapshot returns null (nothing changed)', async () => {
    const handler = vi.fn();
    const fetchImpl = vi.fn(async () => jsonResponse({ stale: true }));
    const handlers = new Map<string, ChannelHandler>([
      ['maybe', { type: 'maybe', onMessage: handler }],
    ]);
    const transport = new PollingTransport({
      handlers,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      polling: {
        url: 'http://test/snapshot',
        intervalMs: 500,
        parseSnapshot: () => null,
      },
    });
    transport.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    await transport.dispose();
  });

  it('skips dispatch when parseSnapshot returns an empty map', async () => {
    const handler = vi.fn();
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const handlers = new Map<string, ChannelHandler>([
      ['ch', { type: 'ch', onMessage: handler }],
    ]);
    const transport = new PollingTransport({
      handlers,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      polling: {
        url: 'http://test/snapshot',
        intervalMs: 500,
        parseSnapshot: () => ({}),
      },
    });
    transport.start();
    await vi.advanceTimersByTimeAsync(0);
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
      ['tick', { type: 'tick', onMessage: handler }],
    ]);
    const transport = new PollingTransport({
      handlers,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      polling: {
        url: 'http://test/snapshot',
        intervalMs: 1000,
        parseSnapshot: (b: unknown) => {
          const v = (b as { value?: number }).value;
          if (v === undefined) return null;
          return { tick: { type: 'tick', payload: v } };
        },
      },
    });
    transport.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledWith(7);
    await transport.dispose();
  });

  it('treats 204 No Content as "nothing new this tick" without parsing', async () => {
    const handler = vi.fn();
    const parseSpy = vi.fn(() => null);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const handlers = new Map<string, ChannelHandler>([
      ['gated', { type: 'gated', onMessage: handler }],
    ]);
    const transport = new PollingTransport({
      handlers,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      polling: {
        url: 'http://test/snapshot',
        intervalMs: 1000,
        parseSnapshot: parseSpy,
      },
    });
    transport.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(parseSpy).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    await transport.dispose();
  });

  it('does nothing when no polling descriptor is supplied', async () => {
    const wsOnlyHandler = vi.fn();
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const handlers = new Map<string, ChannelHandler>([
      ['ws_only', { type: 'ws_only', onMessage: wsOnlyHandler }],
    ]);
    const transport = new PollingTransport({
      handlers,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      // no `polling` descriptor — transport is inert.
    });
    transport.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(wsOnlyHandler).not.toHaveBeenCalled();
    await transport.dispose();
  });

  it('skips frames whose type has no registered handler (silent)', async () => {
    const knownHandler = vi.fn();
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const handlers = new Map<string, ChannelHandler>([
      ['known', { type: 'known', onMessage: knownHandler }],
    ]);
    const transport = new PollingTransport({
      handlers,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      polling: {
        url: 'http://test/snapshot',
        intervalMs: 1000,
        parseSnapshot: () => ({
          unknown: { type: 'unknown', payload: { x: 1 } },
          known: { type: 'known', payload: { y: 2 } },
        }),
      },
    });
    transport.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(knownHandler).toHaveBeenCalledWith({ y: 2 });
    expect(knownHandler).toHaveBeenCalledTimes(1);
    await transport.dispose();
  });

  it('clamps sub-floor intervals to minPollIntervalMs', async () => {
    const handler = vi.fn();
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const handlers = new Map<string, ChannelHandler>([
      ['tight', { type: 'tight', onMessage: handler }],
    ]);
    const transport = new PollingTransport({
      handlers,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      minPollIntervalMs: 500,
      polling: {
        url: 'http://test/snapshot',
        intervalMs: 50, // sub-floor — should clamp to 500
        parseSnapshot: (b) => ({ tight: { type: 'tight', payload: b } }),
      },
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
      ['tick', { type: 'tick', onMessage: handler }],
    ]);
    const transport = new PollingTransport({
      handlers,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      polling: {
        url: 'http://test/snapshot',
        intervalMs: 1000,
        parseSnapshot: (b: unknown) => {
          const v = (b as { value?: number }).value;
          if (v === undefined) return null;
          return { tick: { type: 'tick', payload: v } };
        },
      },
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
