/**
 * Node subprocess reference adapter — the first real
 * implementation of {@link AgentRuntimeAdapter}.
 *
 * Supervises a local agent that runs as a child process: spawns
 * with an explicit `command` + `args`, streams stdout/stderr into
 * the event channel, and maps process lifecycle signals onto the
 * adapter's status machine (`starting` → `ready` → `stopped` |
 * `crashed`).
 *
 * Reference only — deliberately NOT the architecture:
 *
 *   - `command` + `args` are REQUIRED. The factory does not assume
 *     `npx tsx watch src/index.ts` (the `ggui dev` default) or
 *     any framework-specific entrypoint. A CLI wanting `.ts` input
 *     wraps its own `node --import=tsx` shape and passes it
 *     through; the adapter itself knows only how to spawn.
 *   - No framework detection. Claude / OpenAI / Vercel AI / LangGraph
 *     adapters live in their own packages and translate their own
 *     idioms onto this same seam.
 *   - No service-discovery assumptions. Optional `readyCheck` lets
 *     callers promote `starting → ready` on an HTTP probe; if
 *     omitted the adapter considers the child "ready" as soon as
 *     the spawn completes.
 *
 * Lives under `@ggui-ai/agent-runtime/process` so consumers that
 * don't spawn subprocesses (browser-side hubs, future test
 * runners) never pull the `node:child_process` dep by loading the
 * root barrel.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type {
  AgentRuntimeAdapter,
  AgentRuntimeEvent,
  AgentRuntimeHandle,
  AgentRuntimeListener,
  AgentRuntimeStartInput,
  AgentRuntimeStatus,
} from './types.js';

/** Default graceful-shutdown window before escalating to SIGKILL. */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
/** Default readyCheck polling cadence. */
const DEFAULT_READY_INTERVAL_MS = 250;
/** Default readyCheck overall budget. */
const DEFAULT_READY_TIMEOUT_MS = 30_000;

/**
 * Optional HTTP-probe readiness gate. The adapter polls
 * `http://127.0.0.1:<port>/<path>` and emits `status: 'ready'` on
 * the first successful response. Before that the handle stays in
 * `starting`.
 *
 * Kept narrow — no redirect following, no body inspection, no
 * non-HTTP probes. Hosts wanting richer semantics (gRPC health,
 * stdout-match) fork the adapter or post a specific probe layer
 * on top. Keeps the reference impl honest.
 */
export interface HttpReadyCheck {
  readonly type: 'http';
  /** Port to probe on 127.0.0.1. Required — we don't scan. */
  readonly port: number;
  /** Path to probe. Defaults to `'/'`. */
  readonly path?: string;
  /** Milliseconds between polls. Defaults to 250. */
  readonly intervalMs?: number;
  /** Overall timeout budget. Defaults to 30s. */
  readonly timeoutMs?: number;
}

export type ReadyCheck = HttpReadyCheck;

export interface NodeProcessAgentRuntimeOptions {
  /**
   * Adapter name surfaced via `adapter.name`. Defaults to
   * `'node-process'`. Override for clearer logs when multiple
   * adapters coexist.
   */
  readonly name?: string;
  /**
   * Executable to run. Required — the factory takes NO default to
   * avoid pinning a framework. The CLI or host decides whether
   * this is `'node'`, `process.execPath`, or something else.
   */
  readonly command: string;
  /** Args forwarded to the child. Required; pass `[]` for no args. */
  readonly args: readonly string[];
  /**
   * Working directory for the child process. When omitted the
   * adapter uses {@link AgentRuntimeStartInput.projectRoot} (or the
   * parent's cwd as a last resort). Absolute paths only.
   */
  readonly cwd?: string;
  /**
   * Extra env vars forwarded into the child. MERGED with
   * `startInput.env` (startInput wins on collision) and then with
   * `process.env` (child inherits the rest of the parent env).
   * Adapter never leaks env keys the caller didn't opt into by
   * either source.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Optional readiness probe. When omitted the adapter emits
   * `status: 'ready'` immediately after spawn succeeds.
   */
  readonly readyCheck?: ReadyCheck;
  /**
   * Signal to send on `stop()`. Defaults to `'SIGTERM'`. After
   * {@link shutdownTimeoutMs} the adapter escalates to `SIGKILL`.
   */
  readonly shutdownSignal?: NodeJS.Signals;
  /** Grace period before SIGKILL. Defaults to {@link DEFAULT_SHUTDOWN_TIMEOUT_MS}. */
  readonly shutdownTimeoutMs?: number;
  /**
   * Maximum bytes to buffer from a single log line before truncation.
   * Useful for runaway stack traces — defaults to 16 KiB.
   */
  readonly maxLineBytes?: number;
  /**
   * Test seam — inject a spawner to exercise the adapter without
   * touching the filesystem. Production code leaves this unset.
   */
  readonly spawner?: Spawner;
}

/**
 * Minimal spawner contract — `spawn()` from `node:child_process`
 * satisfies this. Broken out so tests can substitute a fake that
 * emits crafted stdout / stderr / exit events.
 */
export type Spawner = (
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
) => ChildProcess;

/**
 * Construct a framework-neutral subprocess adapter. The returned
 * adapter carries no framework-specific behaviour; callers pin the
 * framework by choosing `command` + `args`.
 */
export function createNodeProcessAgentRuntime(
  options: NodeProcessAgentRuntimeOptions,
): AgentRuntimeAdapter {
  if (!options.command || options.command.length === 0) {
    throw new TypeError('createNodeProcessAgentRuntime: `command` is required');
  }
  const name = options.name ?? 'node-process';
  const spawnImpl: Spawner =
    options.spawner ??
    ((cmd, args, opts) => spawn(cmd, args as string[], { ...opts, stdio: ['ignore', 'pipe', 'pipe'] }));

  return {
    name,
    capabilities: {
      observable: true,
      restartable: false,
    },
    async start(input: AgentRuntimeStartInput): Promise<AgentRuntimeHandle> {
      const cwd = options.cwd ?? input.projectRoot;
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...options.env,
        ...input.env,
      };

      const child = spawnImpl(options.command, options.args, { cwd, env });
      const handle = new NodeProcessHandle({
        child,
        runId: `node-process-${child.pid ?? 'nopid'}-${Date.now()}`,
        shutdownSignal: options.shutdownSignal ?? 'SIGTERM',
        shutdownTimeoutMs: options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
        maxLineBytes: options.maxLineBytes ?? 16_384,
      });

      if (input.signal) {
        const onAbort = () => {
          void handle.stop();
        };
        if (input.signal.aborted) {
          queueMicrotask(onAbort);
        } else {
          input.signal.addEventListener('abort', onAbort, { once: true });
        }
      }

      if (options.readyCheck) {
        handle.runReadyCheck(options.readyCheck);
      } else {
        handle.markReadyOnNextTick();
      }

      return handle;
    },
  };
}

interface HandleOptions {
  child: ChildProcess;
  runId: string;
  shutdownSignal: NodeJS.Signals;
  shutdownTimeoutMs: number;
  maxLineBytes: number;
}

/**
 * Concrete handle wrapping a `ChildProcess`. Owns the lifecycle
 * transitions and the stdout/stderr line fanout.
 */
class NodeProcessHandle implements AgentRuntimeHandle {
  readonly runId: string;
  private _status: AgentRuntimeStatus = 'starting';
  private readonly listeners = new Set<AgentRuntimeListener>();
  private readonly child: ChildProcess;
  private readonly shutdownSignal: NodeJS.Signals;
  private readonly shutdownTimeoutMs: number;
  private readonly maxLineBytes: number;
  private stopping = false;
  private readyAbort: AbortController | null = null;
  private stdoutBuffer = '';
  private stderrBuffer = '';

  constructor(options: HandleOptions) {
    this.runId = options.runId;
    this.child = options.child;
    this.shutdownSignal = options.shutdownSignal;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs;
    this.maxLineBytes = options.maxLineBytes;

    this.child.stdout?.setEncoding('utf-8');
    this.child.stderr?.setEncoding('utf-8');
    this.child.stdout?.on('data', (chunk: string) => this.onChunk('stdout', chunk));
    this.child.stderr?.on('data', (chunk: string) => this.onChunk('stderr', chunk));
    this.child.on('error', (err) => {
      this.emit({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      });
    });
    this.child.on('exit', (code, signal) => this.onExit(code, signal));
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

  async stop(): Promise<void> {
    if (this._status === 'stopped' || this._status === 'crashed') return;
    if (this.stopping) return;
    this.stopping = true;
    this.cancelReadyCheck();

    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      // Already gone.
      this.transitionTo('stopped');
      return;
    }

    // Graceful request first.
    this.child.kill(this.shutdownSignal);

    // Escalate to SIGKILL if the child doesn't exit in time. We
    // only escalate — the `exit` handler owns the final status
    // transition once the kernel reports the process gone.
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        try {
          this.child.kill('SIGKILL');
        } catch {
          // Already exited between checks.
        }
      }, this.shutdownTimeoutMs).unref?.();

      this.child.once('exit', () => {
        if (killTimer !== undefined) clearTimeout(killTimer);
        resolve();
      });
    });
  }

  /**
   * Schedule a ready transition on a macrotask. Called when
   * there's no readyCheck configured — the adapter considers the
   * child "ready" as soon as it exists. A `setTimeout(…, 0)`
   * macrotask is deliberate: subscribers attached synchronously
   * after `await adapter.start()` must land BEFORE the emit fires
   * (microtasks would race with the `async` resolution). Guarded
   * so an immediate stop() or crash doesn't raise `ready` over a
   * terminal state.
   */
  markReadyOnNextTick(): void {
    const timer = setTimeout(() => {
      if (this._status === 'starting') {
        this.transitionTo('ready');
      }
    }, 0);
    timer.unref?.();
  }

  runReadyCheck(check: ReadyCheck): void {
    const abort = new AbortController();
    this.readyAbort = abort;
    void runHttpReadyCheck(check, abort.signal).then(
      (result) => {
        if (abort.signal.aborted) return;
        if (this._status !== 'starting') return;
        if (result.ok) {
          this.transitionTo('ready');
        } else {
          this.emit({
            type: 'error',
            message: `readyCheck failed: ${result.reason}`,
            timestamp: Date.now(),
          });
        }
      },
      (err: unknown) => {
        if (abort.signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        this.emit({ type: 'error', message, timestamp: Date.now() });
      },
    );
  }

  private cancelReadyCheck(): void {
    this.readyAbort?.abort();
    this.readyAbort = null;
  }

  private onChunk(stream: 'stdout' | 'stderr', chunk: string): void {
    const buffer = stream === 'stdout' ? 'stdoutBuffer' : 'stderrBuffer';
    let remaining = (this[buffer] + chunk) as string;
    let lineEnd = remaining.indexOf('\n');
    while (lineEnd !== -1) {
      const raw = remaining.slice(0, lineEnd).replace(/\r$/, '');
      const line =
        raw.length > this.maxLineBytes ? `${raw.slice(0, this.maxLineBytes)}…` : raw;
      this.emit({
        type: 'log',
        stream,
        line,
        timestamp: Date.now(),
      });
      remaining = remaining.slice(lineEnd + 1);
      lineEnd = remaining.indexOf('\n');
    }
    this[buffer] = remaining;
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    // Flush any tail-buffered output as a final line each.
    for (const stream of ['stdout', 'stderr'] as const) {
      const key = stream === 'stdout' ? 'stdoutBuffer' : 'stderrBuffer';
      const tail = this[key];
      if (tail.length > 0) {
        this.emit({
          type: 'log',
          stream,
          line: tail.replace(/\r$/, ''),
          timestamp: Date.now(),
        });
        this[key] = '';
      }
    }

    this.cancelReadyCheck();

    // Crashed vs stopped:
    //   - `stop()` was called → stopping=true, we requested the exit.
    //   - external signal we asked for (`shutdownSignal`) → stopped.
    //   - non-zero exit code WITHOUT our request → crashed.
    //   - zero exit code WITHOUT our request → stopped (graceful self-exit).
    if (this.stopping) {
      this.transitionTo('stopped');
      return;
    }
    if (signal !== null) {
      // Unexpected signal the dev-stack didn't send → crashed.
      this.emit({
        type: 'error',
        message: `process terminated by signal ${signal}`,
        timestamp: Date.now(),
      });
      this.transitionTo('crashed');
      return;
    }
    if (code === 0) {
      this.transitionTo('stopped');
    } else {
      this.emit({
        type: 'error',
        message: `process exited with code ${code ?? 'null'}`,
        timestamp: Date.now(),
      });
      this.transitionTo('crashed');
    }
  }

  private transitionTo(status: AgentRuntimeStatus): void {
    if (this._status === status) return;
    this.emit({ type: 'status', status, timestamp: Date.now() });
  }

  private emit(event: AgentRuntimeEvent): void {
    if (event.type === 'status') {
      this._status = event.status;
    }
    const snapshot = Array.from(this.listeners);
    for (const listener of snapshot) {
      try {
        listener(event);
      } catch {
        // A bad listener MUST NOT break fanout. Adapter-level
        // errors surface through `error` events; a listener that
        // throws is a consumer bug.
      }
    }
  }
}

interface ReadyResult {
  ok: boolean;
  reason?: string;
}

/**
 * HTTP readiness probe. Polls `http://127.0.0.1:port<path>` at the
 * configured interval until it gets a 2xx, the caller aborts, or
 * the overall budget expires.
 *
 * Uses the built-in `fetch` with its own `AbortController` per
 * request so a slow connect doesn't block the poll cadence. The
 * outer `signal` cancels the whole loop on caller abort (handle
 * shutdown).
 */
async function runHttpReadyCheck(
  check: HttpReadyCheck,
  signal: AbortSignal,
): Promise<ReadyResult> {
  const interval = check.intervalMs ?? DEFAULT_READY_INTERVAL_MS;
  const budget = check.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const path = check.path ?? '/';
  const url = `http://127.0.0.1:${check.port}${path.startsWith('/') ? path : `/${path}`}`;
  const start = Date.now();

  while (!signal.aborted) {
    if (Date.now() - start > budget) {
      return { ok: false, reason: `timeout after ${budget}ms probing ${url}` };
    }
    const perRequest = AbortSignal.timeout
      ? AbortSignal.timeout(Math.max(interval, 100))
      : undefined;
    try {
      const res = await fetch(url, { signal: perRequest });
      if (res.ok) return { ok: true };
    } catch {
      // Not reachable yet — fall through to the sleep.
    }
    if (signal.aborted) return { ok: false, reason: 'aborted' };
    await sleep(interval, signal);
  }
  return { ok: false, reason: 'aborted' };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
