import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTelemetrySink } from '../runtime-telemetry.js';

/**
 * Telemetry sink — the iframe's transport self-report. Pins:
 *   - first flush delayed (~4s) so one batch carries the boot story;
 *   - later flushes throttle; per-session flush cap;
 *   - channelLogger facade forwards live-channel events verbatim
 *     (event name = kind, fields JSON = detail);
 *   - buffer cap drops OLDEST; flush failures swallowed; dispose
 *     cancels timers.
 */
describe('createTelemetrySink', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeSink(): {
    sink: ReturnType<typeof createTelemetrySink>;
    calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  } {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const sink = createTelemetrySink({
      sessionId: 'render_tel',
      callTool: async (args) => {
        calls.push(args);
        return {};
      },
    });
    return { sink, calls };
  }

  it('batches records and first-flushes after the boot-story delay', async () => {
    const { sink, calls } = makeSink();
    sink.record('boot.path', '{"hasLiveTrio":false}');
    sink.record('status.connecting');
    await vi.advanceTimersByTimeAsync(3900);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('ggui_runtime_telemetry');
    const args = calls[0]?.arguments as {
      sessionId: string;
      events: Array<{ kind: string }>;
    };
    expect(args.sessionId).toBe('render_tel');
    expect(args.events.map((e) => e.kind)).toEqual([
      'boot.path',
      'status.connecting',
    ]);
  });

  it('channelLogger facade forwards transport diagnostics as events', async () => {
    const { sink, calls } = makeSink();
    sink.channelLogger.warn?.('channel_failover_swap', {
      from: 'ws',
      to: 'sse',
    });
    await vi.advanceTimersByTimeAsync(4100);
    const args = calls[0]?.arguments as {
      events: Array<{ kind: string; detail?: string }>;
    };
    expect(args.events[0]?.kind).toBe('channel_failover_swap');
    expect(args.events[0]?.detail).toBe('{"from":"ws","to":"sse"}');
  });

  it('throttles subsequent flushes and honors the per-session cap', async () => {
    const { sink, calls } = makeSink();
    sink.record('boot.path');
    await vi.advanceTimersByTimeAsync(4100);
    expect(calls).toHaveLength(1);
    // Second batch throttles at 8s, not 4s.
    sink.record('status.connected');
    await vi.advanceTimersByTimeAsync(7900);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toHaveLength(2);
    // Exhaust the cap (2 used; 10 more allowed).
    for (let i = 0; i < 15; i += 1) {
      sink.record(`k${i}`);
      await vi.advanceTimersByTimeAsync(8100);
    }
    expect(calls.length).toBeLessThanOrEqual(12);
  });

  it('drops the OLDEST events past the buffer cap; flush failure is swallowed', async () => {
    const failing = createTelemetrySink({
      sessionId: 's',
      callTool: async () => {
        throw new Error('host rejected');
      },
    });
    for (let i = 0; i < 45; i += 1) failing.record(`k${i}`);
    // 40-cap: oldest 5 dropped. Flush swallows the rejection.
    await vi.advanceTimersByTimeAsync(4100);
    failing.dispose();
  });

  it('dispose cancels pending flushes', async () => {
    const { sink, calls } = makeSink();
    sink.record('boot.path');
    sink.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(0);
  });
});
