import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import {
  RUNTIME_TELEMETRY_MAX_EVENTS,
  runtimeTelemetryInputShape,
} from '@ggui-ai/protocol';
import { createGguiRuntimeTelemetryHandler } from './runtime-telemetry.js';

/**
 * `ggui_runtime_telemetry` — the transport self-report channel. Pins:
 *   - declaration meta (name, audience, `_meta.ui.visibility: ['app']`
 *     — the view-callable channel; without it sandboxed hosts cannot
 *     deliver the report and ladder failures stay invisible);
 *   - one structured log line per batch, appId from ctx (proved
 *     identity), sessionId passed through as a client-claimed tag;
 *   - fire-and-forget: returns {ok: true}, stores nothing;
 *   - schema bounds (event cap, kind/detail length) reject oversized
 *     batches — the anti-flooding contract.
 */

const ctx = { appId: 'app-1', requestId: 'r-tel' } as const;

describe('createGguiRuntimeTelemetryHandler', () => {
  it('pins the declaration: name, runtime audience, visibility ["app"], SSoT input shape', () => {
    const h = createGguiRuntimeTelemetryHandler();
    expect(h.name).toBe('ggui_runtime_telemetry');
    expect(h.audience).toEqual(['runtime']);
    const meta = h._meta as
      | { ui?: { visibility?: readonly string[] } }
      | undefined;
    expect(meta?.ui?.visibility).toEqual(['app']);
    expect(h.inputSchema).toBe(runtimeTelemetryInputShape);
  });

  it('logs one structured line per batch with the proved appId and returns {ok: true}', async () => {
    const info = vi.fn();
    const h = createGguiRuntimeTelemetryHandler({ logger: { info } });
    const out = await h.handler(
      {
        sessionId: 'render_tel_1',
        events: [
          { at: 0, kind: 'boot.path', detail: '{"hasLiveTrio":true}' },
          { at: 812, kind: 'channel_failover_swap', detail: 'ws->sse' },
          { at: 4210, kind: 'status.connected' },
        ],
      },
      ctx,
    );
    expect(out).toEqual({ ok: true });
    expect(info).toHaveBeenCalledTimes(1);
    const [event, fields] = info.mock.calls[0]!;
    expect(event).toBe('runtime_telemetry');
    expect(fields['sessionId']).toBe('render_tel_1');
    expect(fields['appId']).toBe('app-1');
    expect(fields['eventCount']).toBe(3);
    expect(fields['events']).toEqual([
      { at: 0, kind: 'boot.path', detail: '{"hasLiveTrio":true}' },
      { at: 812, kind: 'channel_failover_swap', detail: 'ws->sse' },
      { at: 4210, kind: 'status.connected' },
    ]);
  });

  it('falls back to a single-line console JSON when no logger is bound', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const h = createGguiRuntimeTelemetryHandler();
      await h.handler(
        { sessionId: 's1', events: [{ at: 1, kind: 'boot.path' }] },
        ctx,
      );
      expect(log).toHaveBeenCalledTimes(1);
      const line = JSON.parse(log.mock.calls[0]![0] as string) as {
        msg: string;
        appId: string;
      };
      expect(line.msg).toBe('runtime_telemetry');
      expect(line.appId).toBe('app-1');
    } finally {
      log.mockRestore();
    }
  });

  it('rejects an over-cap batch and oversized fields (anti-flooding bounds)', async () => {
    const h = createGguiRuntimeTelemetryHandler();
    const overCap = Array.from(
      { length: RUNTIME_TELEMETRY_MAX_EVENTS + 1 },
      (_, i) => ({ at: i, kind: 'k' }),
    );
    await expect(
      h.handler({ sessionId: 's1', events: overCap }, ctx),
    ).rejects.toThrow(ZodError);
    await expect(
      h.handler(
        { sessionId: 's1', events: [{ at: 0, kind: 'x'.repeat(65) }] },
        ctx,
      ),
    ).rejects.toThrow(ZodError);
    await expect(
      h.handler(
        {
          sessionId: 's1',
          events: [{ at: 0, kind: 'k', detail: 'y'.repeat(513) }],
        },
        ctx,
      ),
    ).rejects.toThrow(ZodError);
    await expect(
      h.handler({ sessionId: 's1', events: [] }, ctx),
    ).rejects.toThrow(ZodError);
  });
});
