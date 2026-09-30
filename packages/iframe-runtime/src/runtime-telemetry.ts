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
 * Two batches, never mixed in one call (#1383):
 *   - HEALTH — which rung the card booted on, its connection status,
 *     whether its doorbell rang, which transport failed. Event names and
 *     the card's own ids only: each health kind pins the one `detail`
 *     shape it admits (none | id | booleans), and a detail outside that
 *     shape is left off the event, never sent free. A host may admit this
 *     vocabulary and nothing else, judging a batch whole; keeping the
 *     other events out of it means they can never cost it the doorbell
 *     ring.
 *   - DIAGNOSTIC — the gesture trail and the ladder's finer story (the
 *     credential renewals, stream restarts, a live channel's end). Its
 *     details are codes, enums, numbers and ids, never free text: no
 *     intent strings, no error messages, no URLs.
 *   {@link RUNTIME_TELEMETRY_KINDS} is the one table of kinds, and
 *   `record` takes only its kinds, so a new emit site is a new table row.
 *
 * Posture: bounded, fire-and-forget, diagnostics-only.
 *   - Each batch buffers up to the protocol's per-batch limit; overflow
 *     drops the OLDEST entries (the tail of a failure story beats its
 *     preamble).
 *   - First flush is delayed (~4s) so one batch carries the whole
 *     boot+ladder story; later flushes throttle. The health batch
 *     flushes first.
 *   - Each batch has its own per-session flush cap (health 8, diagnostic
 *     4), so refused diagnostic flushes never starve the health batch;
 *     flush failures are swallowed (a diagnostics channel must never
 *     cause the symptoms it reports).
 */
import type { ChannelLogEvent, ChannelLogger } from '@ggui-ai/live-channel';
import {
  RUNTIME_TELEMETRY_KINDS,
  type RuntimeTelemetryKind,
  type RuntimeTelemetryKindSpec,
  type TelemetryBatch,
} from '@ggui-ai/protocol/runtime-telemetry';
import { RUNTIME_TELEMETRY_MAX_EVENTS } from '@ggui-ai/protocol/wire';

const FIRST_FLUSH_DELAY_MS = 4_000;
const FLUSH_THROTTLE_MS = 8_000;
const MAX_HEALTH_FLUSHES_PER_SESSION = 8;
const MAX_DIAGNOSTIC_FLUSHES_PER_SESSION = 4;
const MAX_DETAIL_CHARS = 500;

/** The kind vocabulary (`@ggui-ai/protocol/runtime-telemetry`, ggui#1381), indexed by kind. */
const SPEC_BY_KIND: ReadonlyMap<string, RuntimeTelemetryKindSpec> = new Map(
  RUNTIME_TELEMETRY_KINDS.map((s) => [s.kind, s]),
);

const ID_DETAIL = /^[A-Za-z0-9_.:-]{1,128}$/;

function isBooleansObject(detail: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const values = Object.values(parsed);
  return values.length > 0 && values.every((v) => typeof v === 'boolean');
}

/** The detail a kind may carry, or `undefined` when its shape does not admit this one. */
function admittedDetail(spec: RuntimeTelemetryKindSpec | undefined, detail: string | undefined): string | undefined {
  if (detail === undefined || spec === undefined) return undefined;
  switch (spec.detail) {
    case 'none':
      return undefined;
    case 'id':
      return ID_DETAIL.test(detail) ? detail : undefined;
    case 'booleans':
      return detail.length <= MAX_DETAIL_CHARS && isBooleansObject(detail) ? detail : undefined;
    case 'fields':
      return detail.slice(0, MAX_DETAIL_CHARS);
  }
}

/** Narrow slice of `App.callServerTool` the sink needs. */
export type TelemetryCallTool = (args: {
  name: string;
  arguments: Record<string, unknown>;
}) => Promise<unknown>;

export interface TelemetrySink {
  /** Append one event to its kind's batch; schedules a (throttled) flush. */
  record(kind: RuntimeTelemetryKind, detail?: string): void;
  /**
   * `ChannelLogger` facade for the live-channel bind — every event the
   * transports emit lands in the health batch by name, with no detail
   * (the transports' fields carry URLs and error messages).
   */
  readonly channelLogger: ChannelLogger;
  /** Cancel timers; buffered-but-unflushed events are dropped. */
  dispose(): void;
}

type TelemetryEvent = { at: number; kind: string; detail?: string };

export function createTelemetrySink(opts: {
  readonly sessionId: string;
  readonly callTool: TelemetryCallTool;
}): TelemetrySink {
  const bootAt = Date.now();
  const batches: { readonly [b in TelemetryBatch]: { events: TelemetryEvent[]; flushes: number; readonly maxFlushes: number } } = {
    health: { events: [], flushes: 0, maxFlushes: MAX_HEALTH_FLUSHES_PER_SESSION },
    diagnostic: { events: [], flushes: 0, maxFlushes: MAX_DIAGNOSTIC_FLUSHES_PER_SESSION },
  };
  const order: readonly TelemetryBatch[] = ['health', 'diagnostic'];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let firstFlushDone = false;

  const canFlush = (b: TelemetryBatch): boolean =>
    batches[b].events.length > 0 && batches[b].flushes < batches[b].maxFlushes;

  const send = (b: TelemetryBatch): void => {
    if (!canFlush(b)) return;
    const batch = batches[b];
    batch.flushes += 1;
    const events = batch.events.splice(0, batch.events.length);
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

  const flush = (): void => {
    timer = null;
    if (disposed) return;
    firstFlushDone = true;
    for (const b of order) send(b);
  };

  const scheduleFlush = (): void => {
    if (disposed || timer !== null) return;
    if (!order.some(canFlush)) return;
    timer = setTimeout(flush, firstFlushDone ? FLUSH_THROTTLE_MS : FIRST_FLUSH_DELAY_MS);
  };

  const append = (kind: string, detail: string | undefined): void => {
    if (disposed) return;
    const spec = SPEC_BY_KIND.get(kind);
    // An unlisted kind (a caller past the types) travels as diagnostic, and without its detail.
    const batch = batches[spec?.batch ?? 'diagnostic'];
    if (batch.events.length >= RUNTIME_TELEMETRY_MAX_EVENTS) batch.events.shift();
    const kept = admittedDetail(spec, detail);
    batch.events.push({
      at: Math.max(0, Date.now() - bootAt),
      kind: kind.slice(0, 64),
      ...(kept !== undefined ? { detail: kept } : {}),
    });
    scheduleFlush();
  };

  const onChannelEvent = (event: ChannelLogEvent): void => append(event, undefined);

  return {
    record: (kind, detail) => append(kind, detail),
    channelLogger: {
      info: onChannelEvent,
      warn: onChannelEvent,
      debug: onChannelEvent,
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
