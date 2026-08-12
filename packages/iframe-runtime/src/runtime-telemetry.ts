/**
 * Transport-telemetry sink — the iframe runtime's self-report channel
 * (`ggui_runtime_telemetry`).
 *
 * Why: on sandboxed MCP-Apps hosts (claude.ai's `claudemcpcontent.com`
 * frames) the console is unreadable from outside and the CSP blocks
 * every network channel — when the delivery ladder (WS → SSE → polling
 * → bridge-pull) misbehaves there, the failure is invisible by
 * construction. This sink batches the ladder's own events and flushes
 * them over the host's `tools/call` postMessage bridge, the one
 * carrier a CSP jail cannot block.
 *
 * What flows through it:
 *   - `record()` calls from the boot sequence (path decisions, status
 *     transitions, doorbell rings);
 *   - the live-channel's OWN diagnostics via {@link channelLogger} —
 *     a `ChannelLogger` facade that forwards every
 *     `channel_failover_swap` / `channel_polling_*` / SSE event the
 *     transports already emit. Tapping the logger means ZERO new
 *     instrumentation inside `@ggui-ai/live-channel`.
 *
 * Posture: bounded, fire-and-forget, diagnostics-only.
 *   - Buffer caps at the protocol's per-batch limit; overflow drops
 *     the OLDEST entries (the tail of a failure story beats its
 *     preamble).
 *   - First flush is delayed (~4s) so one batch carries the whole
 *     boot+ladder story; later flushes throttle.
 *   - A hard per-session flush cap bounds host load; flush failures
 *     are swallowed (a diagnostics channel must never cause the
 *     symptoms it reports).
 */
import type { ChannelLogger } from '@ggui-ai/live-channel';
import { RUNTIME_TELEMETRY_MAX_EVENTS } from '@ggui-ai/protocol';

const FIRST_FLUSH_DELAY_MS = 4_000;
const FLUSH_THROTTLE_MS = 8_000;
const MAX_FLUSHES_PER_SESSION = 12;
const MAX_DETAIL_CHARS = 500;

/** Narrow slice of `App.callServerTool` the sink needs. */
export type TelemetryCallTool = (args: {
  name: string;
  arguments: Record<string, unknown>;
}) => Promise<unknown>;

export interface TelemetrySink {
  /** Append one event; schedules a (throttled) flush. */
  record(kind: string, detail?: string): void;
  /**
   * `ChannelLogger` facade for the live-channel bind — every event the
   * transports emit lands in the buffer verbatim (event name = kind,
   * fields JSON = detail).
   */
  readonly channelLogger: ChannelLogger;
  /** Cancel timers; buffered-but-unflushed events are dropped. */
  dispose(): void;
}

export function createTelemetrySink(opts: {
  readonly sessionId: string;
  readonly callTool: TelemetryCallTool;
}): TelemetrySink {
  const bootAt = Date.now();
  const buffer: Array<{ at: number; kind: string; detail?: string }> = [];
  let flushes = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let firstFlushDone = false;

  const flush = (): void => {
    timer = null;
    if (disposed || buffer.length === 0) return;
    if (flushes >= MAX_FLUSHES_PER_SESSION) return;
    flushes += 1;
    firstFlushDone = true;
    const events = buffer.splice(0, buffer.length);
    void opts
      .callTool({
        name: 'ggui_runtime_telemetry',
        arguments: { sessionId: opts.sessionId, events },
      })
      .catch(() => {
        // Swallowed by design — the diagnostics channel must never
        // cause the failures it exists to report.
      });
  };

  const scheduleFlush = (): void => {
    if (disposed || timer !== null) return;
    if (flushes >= MAX_FLUSHES_PER_SESSION) return;
    timer = setTimeout(
      flush,
      firstFlushDone ? FLUSH_THROTTLE_MS : FIRST_FLUSH_DELAY_MS,
    );
  };

  const record = (kind: string, detail?: string): void => {
    if (disposed) return;
    if (buffer.length >= RUNTIME_TELEMETRY_MAX_EVENTS) buffer.shift();
    buffer.push({
      at: Math.max(0, Date.now() - bootAt),
      kind: kind.slice(0, 64),
      ...(detail !== undefined ? { detail: detail.slice(0, MAX_DETAIL_CHARS) } : {}),
    });
    scheduleFlush();
  };

  const fieldsToDetail = (fields: Record<string, unknown>): string => {
    try {
      return JSON.stringify(fields).slice(0, MAX_DETAIL_CHARS);
    } catch {
      return '[unserializable]';
    }
  };

  return {
    record,
    channelLogger: {
      info: (event, fields) => record(event, fieldsToDetail(fields)),
      warn: (event, fields) => record(event, fieldsToDetail(fields)),
      debug: (event, fields) => record(event, fieldsToDetail(fields)),
    },
    dispose(): void {
      disposed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
