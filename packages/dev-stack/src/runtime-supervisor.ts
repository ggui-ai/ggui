/**
 * `RuntimeSupervisor` — owns the live view of a supervised agent
 * runtime inside `@ggui-ai/dev-stack`.
 *
 * Responsibilities:
 *
 *   1. Subscribe to the adapter's event stream on construction.
 *   2. Keep a bounded ring buffer of recent events (status + logs +
 *      errors) so hosts that missed the live stream (the CLI banner,
 *      the future hub, an HTTP snapshot endpoint) can still render a
 *      consistent "recent state" view.
 *   3. Expose a cheap, GC-friendly {@link RuntimeStateSnapshot} for
 *      point-in-time reads without forcing callers to subscribe.
 *   4. Dispose cleanly — the `close()` method unsubscribes the
 *      internal listener and forwards unsubscribe to observers.
 *
 * The supervisor intentionally does NOT:
 *
 *   - Own the handle's lifecycle. Whoever constructed the adapter
 *     and called `start()` still owns `stop()`. Supervisor is a
 *     read-plus-buffer layer, not a controller.
 *   - Implement restart-on-crash. That's a higher-layer policy
 *     needing a second adapter to validate the abstraction.
 *   - Persist events beyond the in-memory ring. The hub's eventual
 *     log panel is snapshot-and-tail, not full-history.
 *   - Fan events out to multiple subscribers. The `onEvent` callback
 *     is a single pipe — `runDev` uses it to forward into the CLI
 *     log stream; if a future host needs multi-subscriber fanout it
 *     wraps an `EventEmitter` around the same pipe.
 */
import type {
  AgentRuntimeAdapter,
  AgentRuntimeCapabilities,
  AgentRuntimeEvent,
  AgentRuntimeHandle,
  AgentRuntimeStatus,
} from '@ggui-ai/agent-runtime';

/** Default ring-buffer depth. Chosen to render cleanly in a CLI +
 * hub panel while staying bounded in memory (~200 entries × ~1 KiB
 * worst case ≈ 200 KiB). */
export const DEFAULT_RUNTIME_BUFFER_SIZE = 200;

/**
 * A ring-buffered event — identical to the adapter's
 * `AgentRuntimeEvent` with an appended monotonic `sequence` so
 * consumers can detect gaps without parsing timestamps.
 */
export type RuntimeEventRecord =
  | ({ sequence: number } & Extract<AgentRuntimeEvent, { type: 'status' }>)
  | ({ sequence: number } & Extract<AgentRuntimeEvent, { type: 'log' }>)
  | ({ sequence: number } & Extract<AgentRuntimeEvent, { type: 'error' }>);

/**
 * Point-in-time snapshot. The HTTP surface serializes this verbatim;
 * the CLI uses it for banner refresh; tests assert on its shape
 * directly.
 */
export interface RuntimeStateSnapshot {
  /** `true` when a runtime is currently supervised. Always `true`
   * on a snapshot produced by a supervisor (supervisor exists iff
   * a runtime was started). Included for HTTP parity with the
   * "no runtime" case. */
  readonly present: true;
  /** Adapter name (e.g. `'node-process'`). */
  readonly name: string;
  /** Handle's `runId`. */
  readonly runId: string;
  /** Current status — matches the declarative handle snapshot. */
  readonly status: AgentRuntimeStatus;
  /** Adapter capabilities. */
  readonly capabilities: AgentRuntimeCapabilities;
  /** Timestamp (ms) the supervisor was created. Fixed per run. */
  readonly startedAt: number;
  /** Timestamp (ms) of the most recent event the supervisor saw,
   * or `null` if no events have arrived yet. */
  readonly lastEventAt: number | null;
  /** Recent events, oldest-first. Capped at the supervisor's
   * buffer size (default 200). */
  readonly recentEvents: readonly RuntimeEventRecord[];
}

export interface RuntimeSupervisorOptions {
  /** Adapter that produced {@link handle}. */
  readonly adapter: AgentRuntimeAdapter;
  /** Running handle the supervisor observes. */
  readonly handle: AgentRuntimeHandle;
  /** Ring-buffer capacity. Defaults to
   * {@link DEFAULT_RUNTIME_BUFFER_SIZE}. Must be ≥ 1. */
  readonly bufferSize?: number;
  /** Optional forward pipe — the supervisor calls this for every
   * event after the ring buffer is updated. `runDev` uses it to
   * forward formatted lines into the CLI log stream. */
  readonly onEvent?: (event: RuntimeEventRecord) => void;
}

/**
 * Attach a supervisor to a running handle. Call `close()` when the
 * runtime is torn down to release the subscription.
 */
export class RuntimeSupervisor {
  readonly adapter: AgentRuntimeAdapter;
  readonly handle: AgentRuntimeHandle;

  private readonly bufferSize: number;
  private readonly buffer: RuntimeEventRecord[] = [];
  private readonly startedAt: number;
  private readonly onEvent?: (event: RuntimeEventRecord) => void;
  private readonly unsubscribe: () => void;

  private sequence = 0;
  private lastEventAt: number | null = null;

  constructor(options: RuntimeSupervisorOptions) {
    this.adapter = options.adapter;
    this.handle = options.handle;
    this.bufferSize = Math.max(1, options.bufferSize ?? DEFAULT_RUNTIME_BUFFER_SIZE);
    this.onEvent = options.onEvent;
    this.startedAt = Date.now();

    this.unsubscribe = this.handle.subscribe((event) => this.record(event));
  }

  /** Point-in-time snapshot — shallow-immutable view of the buffer. */
  snapshot(): RuntimeStateSnapshot {
    return {
      present: true,
      name: this.adapter.name,
      runId: this.handle.runId,
      status: this.handle.status,
      capabilities: this.adapter.capabilities,
      startedAt: this.startedAt,
      lastEventAt: this.lastEventAt,
      // Slice so callers can't mutate the internal ring.
      recentEvents: this.buffer.slice(),
    };
  }

  /** Stop observing the handle. Safe to call repeatedly. */
  close(): void {
    this.unsubscribe();
  }

  private record(event: AgentRuntimeEvent): void {
    this.sequence += 1;
    const record = { ...event, sequence: this.sequence } as RuntimeEventRecord;
    this.buffer.push(record);
    if (this.buffer.length > this.bufferSize) {
      // Drop the oldest to keep memory bounded. Ring behaviour
      // without the wrap — `recentEvents` always reads
      // oldest-first with monotonic `sequence` so gaps (if a buffer
      // roll happened) are observable.
      this.buffer.shift();
    }
    this.lastEventAt = event.timestamp;

    try {
      this.onEvent?.(record);
    } catch {
      // A broken forward pipe MUST NOT break the supervisor itself
      // — the snapshot would still be correct. Consumers that need
      // tighter error surfacing subscribe directly to the handle.
    }
  }
}

/**
 * The "no runtime" snapshot shape. Kept here so HTTP surfaces can
 * serialize a consistent shape whether or not a runtime is being
 * supervised.
 */
export interface EmptyRuntimeStateSnapshot {
  readonly present: false;
}

/** Union over present + absent, for HTTP / CLI consumption. */
export type AnyRuntimeStateSnapshot = RuntimeStateSnapshot | EmptyRuntimeStateSnapshot;

/** Convenience helper for the "no runtime" case. */
export function emptyRuntimeSnapshot(): EmptyRuntimeStateSnapshot {
  return { present: false };
}

/**
 * Format an event as a single log line — used by
 * {@link RuntimeSupervisor} consumers that want to forward events
 * into an existing text log stream (the CLI banner log, a test
 * collector, …). Stable format:
 *
 *     [runtime status] ready
 *     [runtime stdout] hello
 *     [runtime stderr] oops
 *     [runtime error]  boot failure
 */
export function formatRuntimeEventLine(event: RuntimeEventRecord): string {
  switch (event.type) {
    case 'status':
      return `[runtime status] ${event.status}`;
    case 'log':
      return `[runtime ${event.stream}] ${event.line}`;
    case 'error':
      return `[runtime error]  ${event.message}`;
  }
}
