/**
 * In-memory stub adapter — a reference implementation that
 * `@ggui-ai/dev-stack` tests, the hub's dev fixtures, and contract
 * tests in this package use to exercise the seam without spawning
 * real processes.
 *
 * The stub's behaviour is deterministic and fully controlled by
 * the caller:
 *
 *   - `start()` immediately transitions `starting → ready` via a
 *     status event, unless `manualReady` is set (in which case the
 *     caller drives the transition through the returned controller).
 *   - `stop()` transitions whatever-the-current-state is →
 *     `stopped` and resolves after all pending listeners have seen
 *     the event.
 *   - The returned controller lets tests emit arbitrary log / error
 *     events, flip status programmatically, and assert against
 *     whatever timing shape they care about.
 *
 * The stub is the shape new adapter implementations should imitate
 * for their own event-loop plumbing: fanout set, single `status`
 * field, idempotent stop, no global state.
 */
import type {
  AgentRuntimeAdapter,
  AgentRuntimeEvent,
  AgentRuntimeHandle,
  AgentRuntimeListener,
  AgentRuntimeStartInput,
  AgentRuntimeStatus,
} from './types.js';

export interface StubAgentRuntimeOptions {
  /** Identifier surfaced via `adapter.name`. Defaults to `'stub'`. */
  readonly name?: string;

  /**
   * When `true`, `start()` returns a handle in `starting` without
   * emitting `ready`. Tests drive the transition via
   * {@link StubAgentRuntimeController.emitStatus}.
   */
  readonly manualReady?: boolean;
}

/**
 * Side-channel controller returned from
 * {@link createStubAgentRuntime}. Production code should never hold
 * one of these; they exist so tests can simulate arbitrary adapter
 * behaviour.
 */
export interface StubAgentRuntimeController {
  /** Inputs the last `start()` call received. `null` before start. */
  lastInput(): AgentRuntimeStartInput | null;
  /** All handles ever produced (one per `start()`). */
  handles(): readonly AgentRuntimeHandle[];
  /**
   * Inject a status event on the latest handle. Updates the handle's
   * declarative `status` too.
   */
  emitStatus(status: AgentRuntimeStatus): void;
  /** Inject a log event on the latest handle. */
  emitLog(stream: 'stdout' | 'stderr', line: string): void;
  /** Inject an error event on the latest handle. */
  emitError(message: string): void;
  /** Fail the next `start()` call with the given error. */
  failNextStart(error: Error): void;
}

/**
 * Construct a stub adapter + controller pair.
 *
 *     const { adapter, controller } = createStubAgentRuntime();
 *     const handle = await adapter.start({ … });
 *     controller.emitLog('stderr', 'boot fail');
 *     await handle.stop();
 */
export function createStubAgentRuntime(
  options: StubAgentRuntimeOptions = {},
): {
  adapter: AgentRuntimeAdapter;
  controller: StubAgentRuntimeController;
} {
  const name = options.name ?? 'stub';
  const manualReady = options.manualReady ?? false;

  const handles: StubHandle[] = [];
  let lastInput: AgentRuntimeStartInput | null = null;
  let nextStartError: Error | null = null;

  const adapter: AgentRuntimeAdapter = {
    name,
    capabilities: {
      observable: true,
      restartable: false,
    },
    async start(input) {
      lastInput = input;
      if (nextStartError) {
        const err = nextStartError;
        nextStartError = null;
        throw err;
      }
      const handle = new StubHandle(`stub-run-${handles.length + 1}`, {
        signal: input.signal,
      });
      handles.push(handle);

      // Emit ready asynchronously unless the caller wants to drive it.
      // A `setTimeout(…, 0)` macrotask guarantees the emit lands AFTER
      // the caller's sync code post-`await adapter.start()` has run —
      // so `handle.subscribe(…)` attached right after the await still
      // catches the ready event. `queueMicrotask` would fire before the
      // subscriber was registered because `async` resolution is also a
      // microtask.
      if (!manualReady) {
        const timer = setTimeout(() => {
          handle.emitIfStarting({
            type: 'status',
            status: 'ready',
            timestamp: Date.now(),
          });
        }, 0);
        timer.unref?.();
      }
      return handle;
    },
  };

  const controller: StubAgentRuntimeController = {
    lastInput: () => lastInput,
    handles: () => handles,
    emitStatus(status) {
      currentHandle(handles).emit({
        type: 'status',
        status,
        timestamp: Date.now(),
      });
    },
    emitLog(stream, line) {
      currentHandle(handles).emit({
        type: 'log',
        stream,
        line,
        timestamp: Date.now(),
      });
    },
    emitError(message) {
      currentHandle(handles).emit({
        type: 'error',
        message,
        timestamp: Date.now(),
      });
    },
    failNextStart(error) {
      nextStartError = error;
    },
  };

  return { adapter, controller };
}

function currentHandle(handles: readonly StubHandle[]): StubHandle {
  const latest = handles.at(-1);
  if (!latest) {
    throw new Error('stub adapter has no active handle — call start() first');
  }
  return latest;
}

/**
 * Concrete handle implementation. Extracted so the stub adapter +
 * future in-package adapters can share the same event fanout
 * plumbing without depending on Node internals.
 */
class StubHandle implements AgentRuntimeHandle {
  readonly runId: string;
  private _status: AgentRuntimeStatus = 'starting';
  private readonly listeners = new Set<AgentRuntimeListener>();
  private stopped = false;

  constructor(
    runId: string,
    options: { signal?: AbortSignal } = {},
  ) {
    this.runId = runId;
    if (options.signal) {
      const onAbort = () => {
        void this.stop();
      };
      if (options.signal.aborted) {
        queueMicrotask(onAbort);
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }
  }

  get status(): AgentRuntimeStatus {
    return this._status;
  }

  subscribe(listener: AgentRuntimeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: AgentRuntimeEvent): void {
    if (event.type === 'status') {
      this._status = event.status;
    }
    // Snapshot first so a listener that unsubscribes mid-fanout
    // doesn't skip another listener in the same tick.
    const snapshot = Array.from(this.listeners);
    for (const listener of snapshot) {
      try {
        listener(event);
      } catch {
        // A bad listener MUST NOT break fanout to its peers.
        // Adapter-level errors surface through `error` events; a
        // listener that throws is a consumer bug.
      }
    }
  }

  /**
   * Emit iff the handle is still in `starting`. Used by the
   * deferred auto-ready path so an aborted / explicitly-stopped
   * handle doesn't reawaken as `ready` when the timer fires.
   */
  emitIfStarting(event: AgentRuntimeEvent): void {
    if (this._status !== 'starting') return;
    this.emit(event);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.emit({ type: 'status', status: 'stopped', timestamp: Date.now() });
    // A real adapter awaits subprocess exit here. The stub has
    // nothing to wait on — but the microtask-synchronous emit
    // keeps timing predictable for tests.
  }
}
