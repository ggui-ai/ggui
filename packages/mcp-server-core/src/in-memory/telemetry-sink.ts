/**
 * Reference {@link TelemetrySink} implementations.
 *
 *   - `NoopTelemetrySink` — swallows events silently. This is the
 *     shipped default for every surface that doesn't pass a real
 *     sink. An OSS deployment that doesn't care about metrics gets
 *     zero-cost no-op emit; any future real sink (OTLP exporter,
 *     CloudWatch EMF, …) drops in behind the same seam without
 *     rewiring call sites.
 *
 *   - `InMemoryTelemetrySink` — retains events in a bounded buffer
 *     for tests + local debugging. Oldest-drop behavior under
 *     backpressure makes the lossy contract observable: if
 *     `capacity` is 2 and 5 events are emitted, `drain()` returns
 *     the 3 most recent. Operators who want a real persistent sink
 *     bind a different implementation; this one is reference-only.
 *
 * Both adapters are allocation-bounded and fire-and-forget — they
 * satisfy the "SHOULD be safe on hot paths" clause of the interface
 * by never performing IO.
 */
import type { TelemetryEvent, TelemetrySink } from '../telemetry-sink.js';

/**
 * No-op sink. Accepts every event and silently drops it.
 *
 * The default for every `createGguiServer` deployment that doesn't
 * bind a telemetry sink — matches the rule that telemetry is a
 * metric gap, not a compliance problem, when absent.
 */
export class NoopTelemetrySink implements TelemetrySink {
  emit(_event: TelemetryEvent): void {
    // Intentional no-op — see class doc.
  }
}

export interface InMemoryTelemetrySinkOptions {
  /**
   * Max retained events. Older events are dropped first once the
   * buffer is full. Defaults to `1000` — enough for a long test
   * run, small enough to cap memory. Set to `Infinity` for an
   * unbounded buffer (tests that want exact event counts).
   */
  readonly capacity?: number;
}

/**
 * Bounded in-memory sink. Captures events for introspection. Tests +
 * local debugging only — production deployments use a real adapter.
 *
 * Thread-safety note: Node's single-threaded JS execution model
 * means `emit` + `drain` never race within a single event loop
 * tick. Multi-process deployments don't share state here at all;
 * that's intentional.
 */
export class InMemoryTelemetrySink implements TelemetrySink {
  private readonly buf: TelemetryEvent[] = [];
  private readonly capacity: number;

  constructor(opts: InMemoryTelemetrySinkOptions = {}) {
    const cap = opts.capacity ?? 1000;
    if (cap !== Infinity && (!Number.isFinite(cap) || cap <= 0)) {
      throw new Error(
        `InMemoryTelemetrySink: capacity must be a positive finite number or Infinity, got ${cap}`,
      );
    }
    this.capacity = cap;
  }

  emit(event: TelemetryEvent): void {
    this.buf.push(event);
    if (this.buf.length > this.capacity) {
      // Oldest-drop. Array.shift is O(n) but fine at ≤1000-entry
      // bounds; ring-buffer optimization is unnecessary for a
      // reference adapter.
      this.buf.shift();
    }
  }

  /** Snapshot of currently-buffered events, oldest first. Does not
   *  clear. Returns a copy so callers can't mutate internal state. */
  snapshot(): TelemetryEvent[] {
    return [...this.buf];
  }

  /** Snapshot + clear in one step. Useful for test `afterEach`. */
  drain(): TelemetryEvent[] {
    const out = [...this.buf];
    this.buf.length = 0;
    return out;
  }

  /** Current buffer size. */
  get length(): number {
    return this.buf.length;
  }
}
