import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNEL_LOG_EVENTS } from '@ggui-ai/live-channel';
import {
  CONNECTION_STATUSES,
  RUNTIME_TELEMETRY_KINDS,
  type RuntimeTelemetryKind,
} from '@ggui-ai/protocol/runtime-telemetry';
import { createTelemetrySink } from '../runtime-telemetry.js';

/**
 * Telemetry sink — the iframe's self-report. Pins:
 *   - two batches, HEALTH and DIAGNOSTIC, never mixed in one call (#1383): a host that admits only the health
 *     vocabulary judges a batch whole, so one diagnostic event would cost the batch its doorbell ring;
 *   - the kind → batch → detail-shape table is a reading of the runtime's emit sites, both ways;
 *   - a health event carries only the detail its kind pins (none | id | booleans), recorded without it otherwise;
 *   - the health batch flushes first, and the two batches have separate flush caps (health 8, diagnostic 4), so
 *     refused diagnostic flushes can never starve the health batch;
 *   - first flush delayed (~4s); later flushes throttle; buffer caps drop the OLDEST; flush failures swallowed;
 *     dispose cancels timers.
 */
type Call = { name: string; arguments: { sessionId: string; events: Array<{ at: number; kind: string; detail?: string }> } };

function makeSink(): { sink: ReturnType<typeof createTelemetrySink>; calls: Call[] } {
  const calls: Call[] = [];
  const sink = createTelemetrySink({
    sessionId: 'render_tel',
    callTool: async (args) => {
      calls.push({ name: args.name, arguments: JSON.parse(JSON.stringify(args.arguments)) });
      return {};
    },
  });
  return { sink, calls };
}

const spec = (kind: string) => RUNTIME_TELEMETRY_KINDS.find((k) => k.kind === kind);

describe('the kind table is a reading of the emit sites', () => {
  const runtimeSrc = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'runtime.ts'), 'utf8');
  const literalKinds = [...runtimeSrc.matchAll(/\.record\(\s*'([a-z_.]+)'/g)].map((m) => m[1]!);

  it('every literal kind the runtime records is in the table', () => {
    expect(literalKinds.length).toBeGreaterThan(10);
    for (const kind of literalKinds) expect(spec(kind), kind).toBeDefined();
  });

  it('the status kinds are exactly `status.<ConnectionStatus>`, and the runtime records them from one template', () => {
    expect(runtimeSrc).toContain('.record(`status.${status}`)');
    const statusKinds = RUNTIME_TELEMETRY_KINDS.filter((k) => k.kind.startsWith('status.')).map((k) => k.kind);
    expect(statusKinds.sort()).toEqual(CONNECTION_STATUSES.map((s) => `status.${s}`).sort());
  });

  it("the channel kinds are exactly the live channel's log events, as health with no detail", () => {
    const channelKinds = RUNTIME_TELEMETRY_KINDS.filter((k) => k.kind.startsWith('channel_'));
    expect(channelKinds.map((k) => k.kind).sort()).toEqual([...CHANNEL_LOG_EVENTS].sort());
    for (const k of channelKinds) expect([k.batch, k.detail]).toEqual(['health', 'none']);
  });

  it('every other table kind is recorded somewhere in the runtime', () => {
    const others = RUNTIME_TELEMETRY_KINDS.filter((k) => !k.kind.startsWith('status.') && !k.kind.startsWith('channel_'));
    for (const k of others) expect(literalKinds, k.kind).toContain(k.kind);
  });

  it('pins the health set this row agreed, and the detail shapes a host door reads', () => {
    const health = RUNTIME_TELEMETRY_KINDS.filter((k) => k.batch === 'health' && !k.kind.startsWith('status.') && !k.kind.startsWith('channel_'));
    expect(health.map((k) => `${k.kind}:${k.detail}`).sort()).toEqual(
      ['boot.path:booleans', 'boot.static_only_no_bridge:none', 'doorbell.ring:id', 'subscribe.resolved:booleans'].sort(),
    );
    for (const k of RUNTIME_TELEMETRY_KINDS) if (k.batch === 'health') expect(['none', 'id', 'booleans']).toContain(k.detail);
  });
});

describe('createTelemetrySink', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('first-flushes after the boot-story delay, the health batch alone when only health was recorded', async () => {
    const { sink, calls } = makeSink();
    sink.record('boot.path', '{"hasLiveTrio":false}');
    sink.record('status.connecting');
    await vi.advanceTimersByTimeAsync(3900);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('ggui_runtime_telemetry');
    expect(calls[0]?.arguments.sessionId).toBe('render_tel');
    expect(calls[0]?.arguments.events.map((e) => e.kind)).toEqual(['boot.path', 'status.connecting']);
  });

  it('never mixes the batches in one call, and flushes health first', async () => {
    const { sink, calls } = makeSink();
    sink.record('gesture.dispatch', '{"toolName":"ggui_runtime_submit_action"}');
    sink.record('doorbell.ring', 'render_abc123');
    sink.record('epoch.frozen', '3');
    sink.record('boot.static_only_no_bridge');
    await vi.advanceTimersByTimeAsync(4100);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.arguments.events.map((e) => e.kind)).toEqual(['doorbell.ring', 'boot.static_only_no_bridge']);
    expect(calls[1]?.arguments.events.map((e) => e.kind)).toEqual(['gesture.dispatch', 'epoch.frozen']);
    for (const call of calls) {
      const batches = new Set(call.arguments.events.map((e) => spec(e.kind)?.batch));
      expect(batches.size).toBe(1);
    }
  });

  it('a health event carries only the detail its kind pins, for every health kind (property)', async () => {
    const { sink, calls } = makeSink();
    const free = 'the user typed: my card number is 4111 1111';
    for (const k of RUNTIME_TELEMETRY_KINDS) if (k.batch === 'health') sink.record(k.kind, free);
    await vi.advanceTimersByTimeAsync(4100);
    sink.record('doorbell.ring', 'render_abc123');
    sink.record('boot.path', '{"hasStaticContent":true,"bridgeCapable":false}');
    sink.record('boot.path', '{"hasStaticContent":true,"url":"https://x"}');
    sink.record('subscribe.resolved', '{"kind":"ws","hasAck":true}');
    sink.record('subscribe.resolved', '{"hasAck":true}');
    await vi.advanceTimersByTimeAsync(8100);
    const health = calls.flatMap((c) => c.arguments.events).filter((e) => spec(e.kind)?.batch === 'health');
    expect(health.length).toBeGreaterThan(20);
    for (const e of health) {
      expect(e.detail ?? '', e.kind).not.toContain('card number');
      const shape = spec(e.kind)?.detail;
      if (shape === 'none') expect(e.detail, e.kind).toBeUndefined();
      if (shape === 'id' && e.detail !== undefined) expect(e.detail).toMatch(/^[A-Za-z0-9_.:-]{1,128}$/);
      if (shape === 'booleans' && e.detail !== undefined) {
        const parsed: unknown = JSON.parse(e.detail);
        expect(parsed !== null && typeof parsed === 'object').toBe(true);
        if (parsed !== null && typeof parsed === 'object') for (const v of Object.values(parsed)) expect(typeof v).toBe('boolean');
      }
    }
    expect(health.find((e) => e.kind === 'doorbell.ring' && e.detail === 'render_abc123')).toBeDefined();
    expect(health.find((e) => e.kind === 'boot.path' && e.detail === '{"hasStaticContent":true,"bridgeCapable":false}')).toBeDefined();
    expect(health.find((e) => e.kind === 'subscribe.resolved' && e.detail === '{"hasAck":true}')).toBeDefined();
    // A booleans kind with one non-boolean field is recorded WITHOUT its detail: never dropped, never sent free.
    expect(health.filter((e) => e.kind === 'boot.path' && e.detail === undefined)).toHaveLength(2);
    expect(health.filter((e) => e.kind === 'subscribe.resolved' && e.detail === undefined)).toHaveLength(2);
  });

  it('the channel facade records each transport event as health with no detail', async () => {
    const { sink, calls } = makeSink();
    sink.channelLogger.warn?.('channel_failover_swap', { from: 'ws', to: 'sse', error: 'socket closed by https://x' });
    sink.channelLogger.info?.('channel_polling_fetch_failed', { url: 'https://x/poll', error: 'boom' });
    await vi.advanceTimersByTimeAsync(4100);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.arguments.events).toEqual([
      { at: expect.any(Number), kind: 'channel_failover_swap' },
      { at: expect.any(Number), kind: 'channel_polling_fetch_failed' },
    ]);
  });

  it('the batches have separate flush caps, so a diagnostic flood cannot starve the health batch', async () => {
    const { sink, calls } = makeSink();
    for (let round = 0; round < 12; round += 1) {
      sink.record('gesture.dom_click', '{"tag":"BUTTON","trusted":true}');
      sink.record(round % 2 === 0 ? 'status.connected' : 'status.reconnecting');
      await vi.advanceTimersByTimeAsync(round === 0 ? 4100 : 8100);
    }
    const batchOf = (c: Call) => spec(c.arguments.events[0]?.kind ?? '')?.batch;
    expect(calls.filter((c) => batchOf(c) === 'diagnostic')).toHaveLength(4);
    expect(calls.filter((c) => batchOf(c) === 'health')).toHaveLength(8);
  });

  it('throttles later flushes at 8s, not 4s', async () => {
    const { sink, calls } = makeSink();
    sink.record('boot.static_only_no_bridge');
    await vi.advanceTimersByTimeAsync(4100);
    expect(calls).toHaveLength(1);
    sink.record('status.connected');
    await vi.advanceTimersByTimeAsync(7900);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toHaveLength(2);
  });

  it("drops the OLDEST events past a batch's buffer cap; flush failure is swallowed", async () => {
    const seen: Call[] = [];
    const failing = createTelemetrySink({
      sessionId: 's',
      callTool: async (args) => {
        seen.push({ name: args.name, arguments: JSON.parse(JSON.stringify(args.arguments)) });
        throw new Error('host rejected');
      },
    });
    for (let i = 0; i < 45; i += 1) failing.record('epoch.frozen', String(i));
    await vi.advanceTimersByTimeAsync(4100);
    const details = seen.flatMap((c) => c.arguments.events).map((e) => e.detail);
    expect(details).toHaveLength(40);
    expect(details[0]).toBe('5');
    failing.dispose();
  });

  it('dispose cancels pending flushes', async () => {
    const { sink, calls } = makeSink();
    sink.record('boot.static_only_no_bridge');
    sink.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(0);
  });

  it('an unlisted kind (a JS caller past the types) is diagnostic and carries no detail', async () => {
    const { sink, calls } = makeSink();
    Reflect.apply(sink.record, sink, ['something.new', 'free text']);
    sink.record('doorbell.ring', 'render_1');
    await vi.advanceTimersByTimeAsync(4100);
    expect(calls[0]?.arguments.events.map((e) => e.kind)).toEqual(['doorbell.ring']);
    expect(calls[1]?.arguments.events).toEqual([{ at: expect.any(Number), kind: 'something.new' }]);
  });
});

// Compile-time: record() takes only the table's kinds.
const kindCheck: RuntimeTelemetryKind = 'doorbell.ring';
void kindCheck;
