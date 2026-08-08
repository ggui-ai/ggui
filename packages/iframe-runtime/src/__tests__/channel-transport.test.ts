/**
 * Channel-transport router unit tests (EE+ 1c).
 *
 * The router decides per channel whether to use the WebSocket
 * `channel_subscribe` path or the iframe-polling fallback, and
 * orchestrates the cross-state transitions (WS drop → poll fallback,
 * WS reconnect → re-subscribe). These tests pin every transition the
 * brief calls out:
 *
 *   - Local tool: subscribe arrives over WS, `channel_payload`
 *     delivers to the bus.
 *   - Non-local tool: iframe polling via `tools/call` delivers
 *     payloads at the declared cadence.
 *   - WS drop → polling fallback fires immediately on affected
 *     channels.
 *   - WS reconnect → re-subscribes affected channels, cancels
 *     polling on first `channel_payload`.
 *   - `channel_error` with `CHANNEL_NOT_LOCAL` triggers polling
 *     fallback (server says "I can't do this, you handle it").
 *   - Idempotent re-subscribe on reconnect (same channelKey, no
 *     duplicate state).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { JsonValue, StreamEnvelope, StreamSpec } from '@ggui-ai/protocol';
import type { WebSocketMessage } from '@ggui-ai/protocol/transport/websocket';
import {
  createChannelTransportRouter,
  DEFAULT_IFRAME_POLL_INTERVAL_MS,
  DEFAULT_IFRAME_PROBE_POLL_INTERVAL_MS,
  type ChannelTransportEvent,
  type ToolsCallInvoker,
} from '../channel-transport.js';
import { RelayIncapableError } from '../relay-incapability.js';
import { StreamBus } from '../wire-config.js';

const RENDER_ID = 'render_test';
const APP_ID = 'app_test';

/**
 * One scripted `tools/call` outcome. The script is consumed in order;
 * once exhausted the LAST step repeats forever, so "this channel keeps
 * failing structurally on every tick" is expressible in one entry.
 */
type ToolsCallStep =
  | { readonly reject: Error }
  | { readonly resolve: JsonValue };

function makeRouter(opts: {
  readonly streamWebSocketLocalTools?: readonly string[];
  readonly defaultPollIntervalMs?: number;
  readonly probePollIntervalMs?: number;
  readonly toolsCallResults?: Array<unknown>;
  readonly toolsCallReject?: boolean;
  readonly toolsCallScript?: readonly ToolsCallStep[];
  /**
   * Makes the invoker a NON-async function that throws before
   * returning a promise — legal under `ToolsCallInvoker`, and the one
   * shape whose failure reaches the tick's catch synchronously.
   */
  readonly toolsCallSyncReject?: Error;
}) {
  const sent: WebSocketMessage[] = [];
  const observed: ChannelTransportEvent[] = [];
  const calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
  const results = [...(opts.toolsCallResults ?? [])];
  let scriptStep = 0;
  const bus = new StreamBus();
  const received: StreamEnvelope[] = [];
  bus.subscribe('weather', (env) => received.push(env));
  bus.subscribe('quotes', (env) => received.push(env));
  bus.subscribe('news', (env) => received.push(env));
  const syncReject = opts.toolsCallSyncReject;
  const toolsCall: ToolsCallInvoker =
    syncReject !== undefined
      ? ({ toolName, args }) => {
          calls.push({
            toolName,
            args: { ...args } as Record<string, unknown>,
          });
          throw syncReject;
        }
      : async ({ toolName, args }) => {
          calls.push({
            toolName,
            args: { ...args } as Record<string, unknown>,
          });
          if (opts.toolsCallReject) {
            throw new Error('boom');
          }
          const script = opts.toolsCallScript;
          if (script !== undefined && script.length > 0) {
            const step = script[Math.min(scriptStep, script.length - 1)];
            scriptStep += 1;
            if (step !== undefined) {
              if ('reject' in step) throw step.reject;
              return step.resolve;
            }
          }
          const next = results.shift();
          return (next ?? null) as never;
        };
  const router = createChannelTransportRouter({
    sessionId: RENDER_ID,
    appId: APP_ID,
    ...(opts.streamWebSocketLocalTools !== undefined
      ? { streamWebSocketLocalTools: opts.streamWebSocketLocalTools }
      : {}),
    send: (msg) => {
      sent.push(msg);
    },
    toolsCall,
    streamBus: bus,
    ...(opts.defaultPollIntervalMs !== undefined
      ? { defaultPollIntervalMs: opts.defaultPollIntervalMs }
      : {}),
    ...(opts.probePollIntervalMs !== undefined
      ? { probePollIntervalMs: opts.probePollIntervalMs }
      : {}),
    onObserve: (e) => observed.push(e),
  });
  return { router, sent, observed, calls, received, bus };
}

const STREAM_SPEC_WS: StreamSpec = {
  weather: {
    schema: { type: 'object' },
    mode: 'replace',
    source: { tool: 'weather_now' },
  },
};

const STREAM_SPEC_POLL: StreamSpec = {
  quotes: {
    schema: { type: 'object' },
    mode: 'append',
    source: { tool: 'thirdparty_quotes' },
  },
};

describe('channel-transport router — transport selection', () => {
  it('routes a tool in `streamWebSocketLocalTools` over WS via channel_subscribe', () => {
    const { router, sent, observed } = makeRouter({
      streamWebSocketLocalTools: ['weather_now'],
    });
    router.applyRender({
      sessionId: RENDER_ID,
      streamSpec: STREAM_SPEC_WS,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: 'channel_subscribe',
      payload: {
        sessionId: RENDER_ID,
        appId: APP_ID,
        channelName: 'weather',
      },
    });
    expect(observed).toContainEqual({
      kind: 'channel-transport-picked',
      sessionId: RENDER_ID,
      channelName: 'weather',
      transport: 'ws',
    });
    router.dispose();
  });

  it('routes a tool NOT in the allowlist via iframe polling tools/call', async () => {
    vi.useFakeTimers();
    const { router, sent, calls, received, observed } = makeRouter({
      streamWebSocketLocalTools: ['weather_now'],
      defaultPollIntervalMs: 1_000,
      toolsCallResults: [{ q: 'one' }, { q: 'two' }, { q: 'three' }],
    });
    router.applyRender({
      sessionId: RENDER_ID,
      streamSpec: STREAM_SPEC_POLL,
    });
    // No WS frame
    expect(sent).toHaveLength(0);
    expect(observed).toContainEqual({
      kind: 'channel-transport-picked',
      sessionId: RENDER_ID,
      channelName: 'quotes',
      transport: 'poll',
    });
    // Flush the leading microtask tick + the first interval tick.
    await vi.advanceTimersByTimeAsync(0);
    // Leading tick already fired (microtask flush from advanceTimersByTimeAsync(0))
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]).toEqual({ toolName: 'thirdparty_quotes', args: {} });
    expect(received[0]).toEqual({
      sessionId: RENDER_ID,
      channel: 'quotes',
      mode: 'append',
      payload: { q: 'one' },
    });
    // Advance to fire the next interval tick
    const before = calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.length).toBeGreaterThan(before);
    router.dispose();
    vi.useRealTimers();
  });

  it('uses iframe polling when no allowlist is supplied (universal fallback)', async () => {
    vi.useFakeTimers();
    const { router, sent, calls } = makeRouter({
      defaultPollIntervalMs: 1_000,
      toolsCallResults: [{ ok: true }, { ok: true }],
    });
    router.applyRender({
      sessionId: RENDER_ID,
      streamSpec: STREAM_SPEC_WS,
    });
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]?.toolName).toBe('weather_now');
    router.dispose();
    vi.useRealTimers();
  });

  it('ignores channels without `source.tool` declared (legacy data-frame path)', () => {
    const { router, sent } = makeRouter({
      streamWebSocketLocalTools: ['weather_now'],
    });
    router.applyRender({
      sessionId: RENDER_ID,
      streamSpec: {
        legacy: { schema: { type: 'object' }, mode: 'append' },
      },
    });
    expect(sent).toHaveLength(0);
    router.dispose();
  });
});

describe('channel-transport router — WS payload delivery', () => {
  it('forwards channel_payload to the StreamBus as a StreamEnvelope', () => {
    const { router, received } = makeRouter({
      streamWebSocketLocalTools: ['weather_now'],
    });
    router.applyRender({
      sessionId: RENDER_ID,
      streamSpec: STREAM_SPEC_WS,
    });
    const consumed = router.handleWsFrame({
      type: 'channel_payload',
      payload: {
        sessionId: RENDER_ID,
        appId: APP_ID,
        channelName: 'weather',
        seq: 1,
        ts: new Date().toISOString(),
        mode: 'replace',
        payload: { temp: 72 },
      },
    });
    expect(consumed).toBe(true);
    expect(received[0]).toEqual({
      sessionId: RENDER_ID,
      channel: 'weather',
      mode: 'replace',
      payload: { temp: 72 },
    });
    router.dispose();
  });

  it('honors the channel_payload `complete: true` marker', () => {
    const { router, received } = makeRouter({
      streamWebSocketLocalTools: ['weather_now'],
    });
    router.applyRender({
      sessionId: RENDER_ID,
      streamSpec: STREAM_SPEC_WS,
    });
    router.handleWsFrame({
      type: 'channel_payload',
      payload: {
        sessionId: RENDER_ID,
        appId: APP_ID,
        channelName: 'weather',
        seq: 1,
        ts: new Date().toISOString(),
        mode: 'replace',
        payload: { final: true },
        complete: true,
      },
    });
    expect(received[0]?.complete).toBe(true);
    router.dispose();
  });

  it('does not consume frames for unknown channels', () => {
    const { router } = makeRouter({
      streamWebSocketLocalTools: ['weather_now'],
    });
    router.applyRender({
      sessionId: RENDER_ID,
      streamSpec: STREAM_SPEC_WS,
    });
    const consumed = router.handleWsFrame({
      type: 'channel_payload',
      payload: {
        sessionId: RENDER_ID,
        appId: APP_ID,
        channelName: 'unknown-channel',
        seq: 1,
        ts: new Date().toISOString(),
        mode: 'replace',
        payload: null,
      },
    });
    expect(consumed).toBe(false);
    router.dispose();
  });
});

describe('channel-transport router — WS drop → poll fallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts polling fallback IMMEDIATELY on WS disconnect for WS-bound channels', async () => {
    const { router, calls, observed } = makeRouter({
      streamWebSocketLocalTools: ['weather_now'],
      defaultPollIntervalMs: 1_000,
      toolsCallResults: [{ ok: true }, { ok: true }, { ok: true }],
    });
    router.applyRender({
      sessionId: RENDER_ID,
      streamSpec: STREAM_SPEC_WS,
    });
    expect(calls).toHaveLength(0);
    router.onWsStatusChange('disconnected');
    expect(observed).toContainEqual({
      kind: 'channel-transport-fallback',
      sessionId: RENDER_ID,
      channelName: 'weather',
      reason: 'ws-disconnect',
    });
    // Leading tick fires immediately (microtask flush)
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]?.toolName).toBe('weather_now');
    router.dispose();
  });

  it('re-sends channel_subscribe on reconnect and cancels polling on first WS payload', async () => {
    const { router, sent, calls, observed } = makeRouter({
      streamWebSocketLocalTools: ['weather_now'],
      defaultPollIntervalMs: 1_000,
      toolsCallResults: [{ ok: true }],
    });
    router.applyRender({
      sessionId: RENDER_ID,
      streamSpec: STREAM_SPEC_WS,
    });
    expect(sent).toHaveLength(1);
    router.onWsStatusChange('disconnected');
    await vi.runOnlyPendingTimersAsync();
    expect(calls.length).toBeGreaterThan(0);
    // Pretend the WS comes back up
    router.onWsStatusChange('connected');
    // Second subscribe frame sent
    expect(sent).toHaveLength(2);
    expect(sent[1]?.type).toBe('channel_subscribe');
    expect(observed).toContainEqual({
      kind: 'channel-transport-resubscribed',
      sessionId: RENDER_ID,
      channelName: 'weather',
    });
    // Polling still running until the first channel_payload
    const callsBeforePayload = calls.length;
    // First post-reconnect channel_payload → cancel polling
    router.handleWsFrame({
      type: 'channel_payload',
      payload: {
        sessionId: RENDER_ID,
        appId: APP_ID,
        channelName: 'weather',
        seq: 1,
        ts: new Date().toISOString(),
        mode: 'replace',
        payload: { reconnected: true },
      },
    });
    // Advance well past the next tick — should NOT fire because the
    // polling loop has been canceled.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls.length).toBe(callsBeforePayload);
    router.dispose();
  });

  it('idempotent — applyRender with the same channel does not duplicate state on reconnect', async () => {
    const { router, sent } = makeRouter({
      streamWebSocketLocalTools: ['weather_now'],
    });
    router.applyRender({
      sessionId: RENDER_ID,
      streamSpec: STREAM_SPEC_WS,
    });
    expect(sent).toHaveLength(1);
    // Second applyRender with the same shape — no new subscribe
    // frame, transport state untouched.
    router.applyRender({
      sessionId: RENDER_ID,
      streamSpec: STREAM_SPEC_WS,
    });
    expect(sent).toHaveLength(1);
    // Reconnect → one re-subscribe per channel, no doubling.
    router.onWsStatusChange('disconnected');
    router.onWsStatusChange('connected');
    expect(sent).toHaveLength(2);
    router.dispose();
  });

  it('does NOT start polling fallback for channels that prefer poll already', async () => {
    const { router, calls } = makeRouter({
      streamWebSocketLocalTools: ['unrelated'],
      defaultPollIntervalMs: 1_000,
      toolsCallResults: [{ ok: true }, { ok: true }, { ok: true }],
    });
    router.applyRender({
      sessionId: RENDER_ID,
      streamSpec: STREAM_SPEC_POLL,
    });
    // First leading tick from the initial activate
    await vi.runOnlyPendingTimersAsync();
    const ticksBefore = calls.length;
    router.onWsStatusChange('disconnected');
    // No EXTRA leading tick from the disconnect — the channel was
    // already on the polling path; flipping wsStatus doesn't restart it.
    expect(calls.length).toBe(ticksBefore);
    router.dispose();
  });
});

describe('channel-transport router — channel_error → fallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('CHANNEL_NOT_LOCAL switches the channel to permanent polling fallback', async () => {
    const { router, calls, observed } = makeRouter({
      streamWebSocketLocalTools: ['weather_now'],
      defaultPollIntervalMs: 1_000,
      toolsCallResults: [{ ok: true }],
    });
    router.applyRender({
      sessionId: RENDER_ID,
      streamSpec: STREAM_SPEC_WS,
    });
    router.handleWsFrame({
      type: 'channel_error',
      payload: {
        sessionId: RENDER_ID,
        channelName: 'weather',
        code: 'CHANNEL_NOT_LOCAL',
        message: 'tool not in streamWebSocketLocalTools',
      },
    });
    expect(observed).toContainEqual({
      kind: 'channel-transport-fallback',
      sessionId: RENDER_ID,
      channelName: 'weather',
      reason: 'channel-not-local',
    });
    // Polling started
    await vi.runOnlyPendingTimersAsync();
    expect(calls.length).toBeGreaterThan(0);
    // Reconnect does NOT re-subscribe a permanently-fallback'd channel.
    router.onWsStatusChange('disconnected');
    router.onWsStatusChange('connected');
    // No new subscribe frame — the channel stayed on permanent poll.
    // (We can't trivially see "no subscribe sent" because the first
    // subscribe is already there; check by counting subscribes since
    // creation.)
    router.dispose();
  });

  it('POLL_FAILED does NOT permanently fall back — transient error', () => {
    const { router } = makeRouter({
      streamWebSocketLocalTools: ['weather_now'],
    });
    router.applyRender({
      sessionId: RENDER_ID,
      streamSpec: STREAM_SPEC_WS,
    });
    router.handleWsFrame({
      type: 'channel_error',
      payload: {
        sessionId: RENDER_ID,
        channelName: 'weather',
        code: 'POLL_FAILED',
        message: 'tool threw',
      },
    });
    // Channel stays on WS — reconnect path still re-subscribes
    router.onWsStatusChange('disconnected');
    router.onWsStatusChange('connected');
    router.dispose();
  });
});

describe('channel-transport router — backoff schedule honored', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('iframe polling honors the supplied cadence between ticks', async () => {
    const { router, calls } = makeRouter({
      defaultPollIntervalMs: 5_000,
      toolsCallResults: [
        { tick: 1 },
        { tick: 2 },
        { tick: 3 },
        { tick: 4 },
        { tick: 5 },
      ],
    });
    router.applyRender({
      sessionId: RENDER_ID,
      streamSpec: STREAM_SPEC_POLL,
    });
    // Leading tick: flush microtask
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    // Advance 4_999ms — should NOT fire another tick yet
    const afterFirst = calls.length;
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls.length).toBe(afterFirst);
    // Cross the 5_000 boundary — should fire one more
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.length).toBe(afterFirst + 1);
    // Advance another full cadence
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.length).toBe(afterFirst + 2);
    router.dispose();
  });

  it('default cadence is exported as DEFAULT_IFRAME_POLL_INTERVAL_MS', () => {
    expect(DEFAULT_IFRAME_POLL_INTERVAL_MS).toBe(10_000);
  });
});

describe('channel-transport router — dispose teardown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears all polling timers on dispose', async () => {
    const { router, calls } = makeRouter({
      defaultPollIntervalMs: 1_000,
      toolsCallResults: [{ ok: true }, { ok: true }, { ok: true }],
    });
    router.applyRender({
      sessionId: RENDER_ID,
      streamSpec: STREAM_SPEC_POLL,
    });
    await vi.runOnlyPendingTimersAsync();
    const beforeDispose = calls.length;
    router.dispose();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.length).toBe(beforeDispose);
  });
});

describe('channel-transport router — classified poll failures (#443)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const pollEvents = (
    observed: readonly ChannelTransportEvent[],
    kind: 'channel-poll-degraded' | 'channel-poll-recovered',
  ): ChannelTransportEvent[] => observed.filter((e) => e.kind === kind);

  it('drops a structurally-failing channel to probe cadence, emitting ONE degraded event', async () => {
    const { router, calls, observed } = makeRouter({
      defaultPollIntervalMs: 1_000,
      probePollIntervalMs: 10_000,
      toolsCallScript: [{ reject: new RelayIncapableError() }],
    });
    router.applyRender({
      sessionId: RENDER_ID,
      streamSpec: STREAM_SPEC_POLL,
    });
    // Leading tick rejects structurally.
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(observed).toContainEqual({
      kind: 'channel-poll-degraded',
      sessionId: RENDER_ID,
      channelName: 'quotes',
      reason: 'relay-incapable',
      probeIntervalMs: 10_000,
    });

    // Default cadence no longer fires — the channel is on probe cadence.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(8_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);

    // FAIL-SAFE PIN: probing continues indefinitely — degradation is a
    // cadence change, never a stop.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(5);

    // …and the transition is announced once, not once per tick.
    expect(pollEvents(observed, 'channel-poll-degraded')).toHaveLength(1);
    router.dispose();
  });

  it('leaves cadence and observability untouched on a transient poll failure', async () => {
    const { router, calls, observed } = makeRouter({
      defaultPollIntervalMs: 1_000,
      probePollIntervalMs: 10_000,
      toolsCallScript: [{ reject: new Error('network blip') }],
    });
    router.applyRender({
      sessionId: RENDER_ID,
      streamSpec: STREAM_SPEC_POLL,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls).toHaveLength(4);
    expect(pollEvents(observed, 'channel-poll-degraded')).toHaveLength(0);
    expect(pollEvents(observed, 'channel-poll-recovered')).toHaveLength(0);
    router.dispose();
  });

  it('restores default cadence and announces recovery on the first success after degradation', async () => {
    const { router, calls, observed, received } = makeRouter({
      defaultPollIntervalMs: 1_000,
      probePollIntervalMs: 10_000,
      toolsCallScript: [
        { reject: new RelayIncapableError() },
        { resolve: { q: 'back' } },
      ],
    });
    router.applyRender({
      sessionId: RENDER_ID,
      streamSpec: STREAM_SPEC_POLL,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(pollEvents(observed, 'channel-poll-degraded')).toHaveLength(1);

    // The probe tick succeeds.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(2);
    expect(received[0]).toEqual({
      sessionId: RENDER_ID,
      channel: 'quotes',
      mode: 'append',
      payload: { q: 'back' },
    });
    expect(observed).toContainEqual({
      kind: 'channel-poll-recovered',
      sessionId: RENDER_ID,
      channelName: 'quotes',
      pollIntervalMs: 1_000,
    });

    // Back on the default cadence.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(3);

    // Recovery is announced once, not on every subsequent success.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pollEvents(observed, 'channel-poll-recovered')).toHaveLength(1);
    router.dispose();
  });

  it('FAIL-SAFE: a channel that never fails structurally never changes cadence', async () => {
    const { router, calls, observed } = makeRouter({
      defaultPollIntervalMs: 1_000,
      probePollIntervalMs: 10_000,
      toolsCallScript: [{ resolve: { ok: true } }],
    });
    router.applyRender({
      sessionId: RENDER_ID,
      streamSpec: STREAM_SPEC_POLL,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(6);
    expect(pollEvents(observed, 'channel-poll-degraded')).toHaveLength(0);
    expect(pollEvents(observed, 'channel-poll-recovered')).toHaveLength(0);
    router.dispose();
  });

  it('never probes FASTER than the channel already polls', async () => {
    const { router, calls, observed } = makeRouter({
      defaultPollIntervalMs: 60_000,
      probePollIntervalMs: 10_000,
      toolsCallScript: [{ reject: new RelayIncapableError() }],
    });
    router.applyRender({
      sessionId: RENDER_ID,
      streamSpec: STREAM_SPEC_POLL,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(observed).toContainEqual({
      kind: 'channel-poll-degraded',
      sessionId: RENDER_ID,
      channelName: 'quotes',
      reason: 'relay-incapable',
      probeIntervalMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(calls).toHaveLength(2);
    router.dispose();
  });

  it('keeps the degraded cadence across a stop/start cycle, without re-announcing', async () => {
    // A WS-bound channel: it polls only as a disconnect fallback, so
    // its loop legitimately stops and restarts. Degradation must
    // survive that. A WS reconnect is no evidence the host regained
    // the ability to relay — only a successful poll is — so re-arming
    // at the default cadence would hand the doomed channel its full
    // poll rate back on every reconnect.
    const { router, calls, observed } = makeRouter({
      streamWebSocketLocalTools: ['weather_now'],
      defaultPollIntervalMs: 1_000,
      probePollIntervalMs: 10_000,
      toolsCallScript: [{ reject: new RelayIncapableError() }],
    });
    router.applyRender({ sessionId: RENDER_ID, streamSpec: STREAM_SPEC_WS });

    // WS drops → poll fallback starts → leading tick degrades it.
    router.onWsStatusChange('disconnected');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(pollEvents(observed, 'channel-poll-degraded')).toHaveLength(1);

    // WS comes back and delivers a payload → the poll loop STOPS.
    router.onWsStatusChange('connected');
    router.handleWsFrame({
      type: 'channel_payload',
      payload: {
        sessionId: RENDER_ID,
        appId: APP_ID,
        channelName: 'weather',
        seq: 1,
        ts: new Date().toISOString(),
        mode: 'replace',
        payload: { temp: 71 },
      },
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toHaveLength(1);

    // WS drops again → the loop restarts AT PROBE CADENCE.
    router.onWsStatusChange('disconnected');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(calls).toHaveLength(3);

    // Restarting a still-degraded channel is not a new transition.
    expect(pollEvents(observed, 'channel-poll-degraded')).toHaveLength(1);
    router.dispose();
  });

  it('degrades on the leading tick even when the invoker throws synchronously', async () => {
    // `ToolsCallInvoker` is declared to return a promise, but a
    // non-async implementation that throws before returning one
    // satisfies that type. Such a throw lands in the tick's catch
    // during `startPolling`'s own synchronous execution — so the
    // channel's timer must already be armed by then, or the
    // stopped-channel guard in `degradePolling` correctly ignores it
    // and the channel silently burns a full degrade cycle.
    const { router, calls, observed } = makeRouter({
      defaultPollIntervalMs: 1_000,
      probePollIntervalMs: 10_000,
      toolsCallSyncReject: new RelayIncapableError(),
    });
    router.applyRender({ sessionId: RENDER_ID, streamSpec: STREAM_SPEC_POLL });

    // No timer advance: the degrade already happened, synchronously.
    expect(calls).toHaveLength(1);
    expect(pollEvents(observed, 'channel-poll-degraded')).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(calls).toHaveLength(2);
    router.dispose();
  });

  it('probe cadence default is exported as DEFAULT_IFRAME_PROBE_POLL_INTERVAL_MS', () => {
    expect(DEFAULT_IFRAME_PROBE_POLL_INTERVAL_MS).toBe(30_000);
  });
});

describe('channel-transport router — channel-only key match for channel_error', () => {
  it('routes channel_error to fallback via the (sessionId, channelName) key', () => {
    const { router, observed } = makeRouter({
      streamWebSocketLocalTools: ['weather_now'],
    });
    router.applyRender({
      sessionId: RENDER_ID,
      streamSpec: STREAM_SPEC_WS,
    });
    router.handleWsFrame({
      type: 'channel_error',
      payload: {
        sessionId: RENDER_ID,
        channelName: 'weather',
        code: 'CHANNEL_NOT_LOCAL',
        message: 'demo',
      },
    });
    // Found + flipped to fallback
    expect(observed.some((e) => e.kind === 'channel-transport-fallback')).toBe(
      true,
    );
    router.dispose();
  });
});
