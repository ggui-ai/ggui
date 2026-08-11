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

/**
 * Bridge-pull rung (ADDENDUM ruling 14) — `fetchBody` is the second
 * carrier: the resolved value IS the body handed to `parseSnapshot`
 * (no `res.ok` / `.json()` step). Exactly one of url / fetchBody must
 * be set.
 */
describe('PollingTransport — fetchBody carrier', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('awaits fetchBody per tick and hands the resolved value to parseSnapshot verbatim', async () => {
    const handler = vi.fn();
    const bodyA = { events: [{ sequence: 1 }], lastSequence: 1 };
    const fetchBody = vi.fn(async () => bodyA);
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const seen: unknown[] = [];
    const handlers = new Map<string, ChannelHandler>([
      ['tick', { type: 'tick', onMessage: handler }],
    ]);
    const transport = new PollingTransport({
      handlers,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      polling: {
        intervalMs: 1000,
        fetchBody,
        parseSnapshot: (body: unknown) => {
          seen.push(body);
          return { tick: { type: 'tick', payload: body } };
        },
      },
    });
    transport.start();
    expect(transport.status).toBe('open');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchBody).toHaveBeenCalledTimes(1);
    // The result IS the body — reference equality, no unwrap step.
    expect(seen[0]).toBe(bodyA);
    expect(handler).toHaveBeenCalledWith(bodyA);
    // The bridge carrier never touches HTTP.
    expect(fetchImpl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchBody).toHaveBeenCalledTimes(2);
    await transport.dispose();
  });

  it('absorbs fetchBody rejections and retries next tick when no budget is set', async () => {
    const handler = vi.fn();
    let call = 0;
    const fetchBody = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error('host bridge hiccup');
      return { value: 9 };
    });
    const handlers = new Map<string, ChannelHandler>([
      ['tick', { type: 'tick', onMessage: handler }],
    ]);
    const transport = new PollingTransport({
      handlers,
      polling: {
        intervalMs: 1000,
        fetchBody,
        parseSnapshot: (b: unknown) => ({
          tick: { type: 'tick', payload: b },
        }),
      },
    });
    transport.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).not.toHaveBeenCalled();
    expect(transport.status).toBe('open');
    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledWith({ value: 9 });
    expect(transport.status).toBe('open');
    await transport.dispose();
  });
});

/**
 * Exactly-one-of url / fetchBody guard — a violating descriptor is
 * structurally unusable, so `start()` fails the transport (status
 * `'failed'` + log), mirroring the WS constructor-throw route.
 */
describe('PollingTransport — exactly-one-of carrier guard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fails at start() when the descriptor has neither url nor fetchBody', async () => {
    const statuses: string[] = [];
    const warn = vi.fn();
    const parseSpy = vi.fn(() => null);
    const transport = new PollingTransport({
      handlers: new Map<string, ChannelHandler>(),
      logger: { warn },
      onStatusChange: (s) => statuses.push(s),
      polling: {
        intervalMs: 1000,
        parseSnapshot: parseSpy,
      },
    });
    transport.start();
    expect(transport.status).toBe('failed');
    expect(statuses).toEqual(['failed']);
    expect(warn).toHaveBeenCalledWith(
      'channel_polling_invalid_carrier',
      expect.objectContaining({ has_url: false, has_fetch_body: false }),
    );
    // No timer was armed — nothing ever ticks.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(parseSpy).not.toHaveBeenCalled();
    await transport.dispose();
  });

  it('fails at start() when both url and fetchBody are set', async () => {
    const statuses: string[] = [];
    const warn = vi.fn();
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const fetchBody = vi.fn(async () => ({}));
    const transport = new PollingTransport({
      handlers: new Map<string, ChannelHandler>(),
      logger: { warn },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onStatusChange: (s) => statuses.push(s),
      polling: {
        url: 'http://test/snapshot',
        intervalMs: 1000,
        fetchBody,
        parseSnapshot: () => null,
      },
    });
    transport.start();
    expect(transport.status).toBe('failed');
    expect(statuses).toEqual(['failed']);
    expect(warn).toHaveBeenCalledWith(
      'channel_polling_invalid_carrier',
      expect.objectContaining({ has_url: true, has_fetch_body: true }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fetchBody).not.toHaveBeenCalled();
    await transport.dispose();
  });
});

/**
 * Consecutive-failure budget (ADDENDUM ruling 14) — N consecutive
 * tick failures (carrier throw/reject or `!res.ok`; any success
 * resets) → status `'failed'` + timer stopped. Unset budget keeps the
 * never-fail posture (covered by the absorb/retry cases above).
 */
describe('PollingTransport — consecutive-failure budget', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fail-fail-fail trips the budget: status failed + timer stopped', async () => {
    const statuses: string[] = [];
    const warn = vi.fn();
    const fetchImpl = vi.fn(async () => {
      throw new Error('csp jail');
    });
    const transport = new PollingTransport({
      handlers: new Map<string, ChannelHandler>(),
      logger: { warn },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onStatusChange: (s) => statuses.push(s),
      polling: {
        url: 'http://test/events',
        intervalMs: 1000,
        failureBudget: 3,
        parseSnapshot: () => null,
      },
    });
    transport.start();
    await vi.advanceTimersByTimeAsync(0); // fail 1
    expect(transport.status).toBe('open');
    await vi.advanceTimersByTimeAsync(1000); // fail 2
    expect(transport.status).toBe('open');
    await vi.advanceTimersByTimeAsync(1000); // fail 3 → budget exhausted
    expect(transport.status).toBe('failed');
    expect(statuses).toContain('failed');
    expect(warn).toHaveBeenCalledWith(
      'channel_polling_budget_exhausted',
      expect.objectContaining({ consecutive_failures: 3, failure_budget: 3 }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // Timer stopped — no further ticks after 'failed'.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    await transport.dispose();
  });

  it('a success mid-streak resets the count', async () => {
    const script: readonly ('throw' | 'ok')[] = ['throw', 'ok', 'throw', 'throw'];
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      const step = script[Math.min(call, script.length - 1)];
      call += 1;
      if (step === 'throw') throw new Error('blip');
      return jsonResponse({ ok: true });
    });
    const transport = new PollingTransport({
      handlers: new Map<string, ChannelHandler>(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      polling: {
        url: 'http://test/events',
        intervalMs: 1000,
        failureBudget: 2,
        parseSnapshot: () => null,
      },
    });
    transport.start();
    await vi.advanceTimersByTimeAsync(0); // fail (1)
    await vi.advanceTimersByTimeAsync(1000); // success → reset
    await vi.advanceTimersByTimeAsync(1000); // fail (1)
    expect(transport.status).toBe('open');
    await vi.advanceTimersByTimeAsync(1000); // fail (2) → budget
    expect(transport.status).toBe('failed');
    await transport.dispose();
  });

  it('non-ok responses count toward the budget', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 }));
    const transport = new PollingTransport({
      handlers: new Map<string, ChannelHandler>(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      polling: {
        url: 'http://test/events',
        intervalMs: 1000,
        failureBudget: 2,
        parseSnapshot: () => null,
      },
    });
    transport.start();
    await vi.advanceTimersByTimeAsync(0); // 503 (1)
    expect(transport.status).toBe('open');
    await vi.advanceTimersByTimeAsync(1000); // 503 (2) → budget
    expect(transport.status).toBe('failed');
    await transport.dispose();
  });

  it('204 No Content is a success and resets the streak', async () => {
    const script: readonly ('throw' | '204')[] = [
      'throw',
      '204',
      'throw',
      'throw',
    ];
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      const step = script[Math.min(call, script.length - 1)];
      call += 1;
      if (step === '204') return new Response(null, { status: 204 });
      throw new Error('blip');
    });
    const transport = new PollingTransport({
      handlers: new Map<string, ChannelHandler>(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      polling: {
        url: 'http://test/events',
        intervalMs: 1000,
        failureBudget: 2,
        parseSnapshot: () => null,
      },
    });
    transport.start();
    await vi.advanceTimersByTimeAsync(0); // fail (1)
    await vi.advanceTimersByTimeAsync(1000); // 204 → reset
    await vi.advanceTimersByTimeAsync(1000); // fail (1)
    expect(transport.status).toBe('open');
    await vi.advanceTimersByTimeAsync(1000); // fail (2) → budget
    expect(transport.status).toBe('failed');
    await transport.dispose();
  });

  it('transport-level failureBudget applies when the descriptor has none (registry injection seam)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('jailed');
    });
    const transport = new PollingTransport({
      handlers: new Map<string, ChannelHandler>(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      failureBudget: 1,
      polling: {
        url: 'http://test/events',
        intervalMs: 1000,
        parseSnapshot: () => null,
      },
    });
    transport.start();
    await vi.advanceTimersByTimeAsync(0); // fail (1) → budget
    expect(transport.status).toBe('failed');
    await transport.dispose();
  });

  it('fetchBody rejections count and resolutions reset', async () => {
    const script: readonly ('reject' | 'resolve')[] = [
      'reject',
      'resolve',
      'reject',
      'reject',
    ];
    let call = 0;
    const fetchBody = vi.fn(async () => {
      const step = script[Math.min(call, script.length - 1)];
      call += 1;
      if (step === 'reject') throw new Error('bridge down');
      return { ok: true };
    });
    const transport = new PollingTransport({
      handlers: new Map<string, ChannelHandler>(),
      polling: {
        intervalMs: 1000,
        fetchBody,
        failureBudget: 2,
        parseSnapshot: () => null,
      },
    });
    transport.start();
    await vi.advanceTimersByTimeAsync(0); // reject (1)
    await vi.advanceTimersByTimeAsync(1000); // resolve → reset
    await vi.advanceTimersByTimeAsync(1000); // reject (1)
    expect(transport.status).toBe('open');
    await vi.advanceTimersByTimeAsync(1000); // reject (2) → budget
    expect(transport.status).toBe('failed');
    // Timer stopped.
    const calls = fetchBody.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchBody.mock.calls.length).toBe(calls);
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

describe('PollingTransport — nextDelayMs subscription chain', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('paces via the callback: 0 → immediate successor, large → waits', async () => {
    const delays: unknown[] = [];
    let calls = 0;
    const fetchBody = vi.fn(async () => {
      calls += 1;
      return { n: calls };
    });
    const transport = new PollingTransport({
      handlers: new Map(),
      polling: {
        intervalMs: 1000,
        fetchBody,
        parseSnapshot: () => null,
        nextDelayMs: (body: unknown): number => {
          delays.push(body);
          // First two ticks chain immediately, then idle at 15s.
          return delays.length < 3 ? 0 : 15_000;
        },
      },
    });
    transport.start();
    // Three back-to-back ticks (delay 0 chains through microtasks +
    // zero-timers; each tick needs one flush for its async completion
    // and one for its zero-timer, so over-advance generously — the
    // idle gate below proves no 4th tick slipped through).
    for (let i = 0; i < 6; i += 1) {
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(fetchBody).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    // Now idle: nothing for 14.9s…
    await vi.advanceTimersByTimeAsync(14_900);
    expect(fetchBody).toHaveBeenCalledTimes(3);
    // …and the 15s idle tick fires.
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchBody).toHaveBeenCalledTimes(4);
    await transport.dispose();
  });

  it('serializes ticks — a held call outliving the nominal interval never overlaps', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchBody = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Simulate a 5s server hold.
      await new Promise<void>((resolve) => setTimeout(resolve, 5000));
      inFlight -= 1;
      return {};
    });
    const transport = new PollingTransport({
      handlers: new Map(),
      polling: {
        intervalMs: 1000,
        fetchBody,
        parseSnapshot: () => null,
        nextDelayMs: () => 0,
      },
    });
    transport.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(maxInFlight).toBe(1);
    expect(fetchBody.mock.calls.length).toBeGreaterThanOrEqual(3);
    await transport.dispose();
  });

  it('a failed tick paces at intervalMs without consulting the callback', async () => {
    const nextDelayMs = vi.fn(() => 0);
    let calls = 0;
    const fetchBody = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
      return {};
    });
    const transport = new PollingTransport({
      handlers: new Map(),
      polling: {
        intervalMs: 1000,
        fetchBody,
        parseSnapshot: () => null,
        nextDelayMs,
      },
    });
    transport.start();
    await vi.advanceTimersByTimeAsync(0);
    // Failure — callback NOT consulted, retry waits the full interval.
    expect(nextDelayMs).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchBody).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchBody).toHaveBeenCalledTimes(2);
    expect(nextDelayMs).toHaveBeenCalledWith({});
    await transport.dispose();
  });

  it('dispose mid-chain stops rescheduling', async () => {
    const fetchBody = vi.fn(async () => ({}));
    const transport = new PollingTransport({
      handlers: new Map(),
      polling: {
        intervalMs: 1000,
        fetchBody,
        parseSnapshot: () => null,
        nextDelayMs: () => 100,
      },
    });
    transport.start();
    await vi.advanceTimersByTimeAsync(0);
    const callsAtDispose = fetchBody.mock.calls.length;
    await transport.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchBody).toHaveBeenCalledTimes(callsAtDispose);
  });

  it('budget exhaustion mid-chain reports failed and halts the loop', async () => {
    const statuses: string[] = [];
    const fetchBody = vi.fn(async () => {
      throw new Error('down');
    });
    const transport = new PollingTransport({
      handlers: new Map(),
      failureBudget: 3,
      onStatusChange: (s) => statuses.push(s),
      polling: {
        intervalMs: 100,
        fetchBody,
        parseSnapshot: () => null,
        nextDelayMs: () => 0,
      },
    });
    transport.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(statuses).toContain('failed');
    expect(fetchBody).toHaveBeenCalledTimes(3);
    const callsAtFailure = fetchBody.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchBody).toHaveBeenCalledTimes(callsAtFailure);
  });
});
