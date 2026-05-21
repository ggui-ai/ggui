/**
 * Agent runtime adapter seam — the one public contract for
 * "something that runs an agent and can be supervised by
 * `@ggui-ai/dev-stack` or any other host."
 *
 * Design rules (locked 2026-04-18):
 *
 * 1. **Framework-neutral.** No Claude / OpenAI / Vercel-AI / LangGraph
 *    assumption leaks into this interface. Adapter authors translate
 *    their framework's idioms into this shape, not the other way
 *    around. `tsx watch src/index.ts` is a reference adapter — not
 *    the architecture.
 *
 * 2. **Node-free.** These types MUST NOT import from `node:*`. A
 *    browser-side host (the local dev hub, a cloud control plane,
 *    a test runner) needs to consume the adapter's events without
 *    pulling subprocess / fs APIs in. Reference adapters that DO
 *    spawn subprocesses live behind secondary subpaths (`./process`,
 *    `./stub`) so consumers opt in.
 *
 * 3. **Events are the runtime truth.** A handle exposes a declarative
 *    `status` for one-shot queries, but the authoritative state lives
 *    in the event stream (`status` → `log` → `error`). Consumers that
 *    care about liveness subscribe; those that only need a
 *    point-in-time probe read `status`.
 *
 * 4. **Capabilities are data, not duck typing.** Hosts inspect
 *    `capabilities.restartable` / `.observable` before calling
 *    methods that might not exist. Keeps the seam declarative even
 *    when adapters grow feature flags.
 *
 * 5. **Dependency direction.** `dev-stack` → `agent-runtime` only.
 *    Never the reverse. This lets future non-dev hosts (bench
 *    runners, remote supervisors) consume the same adapters without
 *    pulling the dev server in.
 */

/**
 * Point-in-time status of a running adapter.
 *
 * - `starting` — `start()` has been called; the adapter is
 *   bootstrapping. The handle is already returned; status events
 *   will surface progress.
 * - `ready` — the underlying agent process / worker / service is
 *   healthy and accepting work.
 * - `stopped` — `stop()` was called and completed, or the adapter
 *   shut itself down cleanly (graceful exit).
 * - `crashed` — the adapter terminated without a request. Hosts
 *   decide whether to restart; adapters MAY self-restart only when
 *   `capabilities.restartable === true`.
 */
export type AgentRuntimeStatus = 'starting' | 'ready' | 'stopped' | 'crashed';

/**
 * Event the adapter emits through the handle's subscription.
 *
 * Delivery is at-least-once — consumers dedupe where it matters.
 * Ordering is preserved per-adapter; cross-adapter ordering is not.
 */
export type AgentRuntimeEvent =
  | { type: 'status'; status: AgentRuntimeStatus; timestamp: number }
  | {
      type: 'log';
      stream: 'stdout' | 'stderr';
      line: string;
      timestamp: number;
    }
  | { type: 'error'; message: string; timestamp: number };

/** Listener shape — hosts register one of these via `handle.subscribe`. */
export type AgentRuntimeListener = (event: AgentRuntimeEvent) => void;

/**
 * Capability probe. Callers branch the UI / supervision policy on
 * these instead of poking at optional methods at runtime.
 */
export interface AgentRuntimeCapabilities {
  /**
   * `true` if the adapter emits a non-empty event stream during its
   * run (at minimum, a `status: 'ready'` event after boot). `false`
   * for adapters that only support start/stop/status polling.
   */
  readonly observable: boolean;

  /**
   * `true` if the adapter's `restart()` is safe to call on an active
   * handle. Adapters that need a full stop-then-start cycle leave
   * this `false` and hosts compose their own restart.
   */
  readonly restartable: boolean;
}

/**
 * Minimal identity of the ggui project the adapter is being asked
 * to run. The adapter MAY use `slug` / `name` in logs or in the
 * process title; it MUST NOT assume anything beyond these fields
 * are present.
 *
 * `protocol` carries the ggui protocol version (e.g. `'1.1'`) so
 * adapters that generate boilerplate / pass protocol headers to
 * their framework can stay in lockstep with the manifest.
 */
export interface AgentRuntimeProjectIdentity {
  readonly slug: string;
  readonly name: string;
  readonly protocol: string;
}

/**
 * Input passed to {@link AgentRuntimeAdapter.start}. Intentionally
 * narrow — adapters accept extra configuration through their own
 * factory functions; this shape is the common subset every adapter
 * MUST handle.
 */
export interface AgentRuntimeStartInput {
  /**
   * Absolute project root (directory that contains `ggui.json`).
   * Adapters resolve entry files / env files relative to this.
   */
  readonly projectRoot: string;

  /** The loaded project identity (see above). */
  readonly project: AgentRuntimeProjectIdentity;

  /**
   * Optional entry hint. Adapter-specific interpretation — a
   * subprocess adapter might treat this as the script path; a worker
   * adapter might treat it as a module name. `undefined` lets the
   * adapter fall back to its own default.
   */
  readonly entry?: string;

  /**
   * Environment variables to forward into the runtime. Adapter MUST
   * NOT leak `process.env` keys that aren't in this record — hosts
   * explicitly opt into what crosses the boundary.
   */
  readonly env?: Readonly<Record<string, string>>;

  /**
   * Port hint. Adapters that bind a socket SHOULD honour it when
   * available, or pick the next free port and surface the chosen
   * value via a status event.
   */
  readonly portHint?: number;

  /**
   * Abort signal. Aborting is equivalent to calling
   * {@link AgentRuntimeHandle.stop} on the returned handle — hosts
   * that want fire-and-forget cleanup pass a signal instead of
   * holding the handle.
   */
  readonly signal?: AbortSignal;
}

/**
 * Running-instance handle returned from {@link AgentRuntimeAdapter.start}.
 *
 * Every method is idempotent when called on an already-terminal
 * state: `stop()` on a stopped handle is a no-op; a second
 * `subscribe()` after `stop()` is allowed (returns an unsubscribe
 * that does nothing) but MAY be rejected with a clear error by the
 * adapter if desired.
 */
export interface AgentRuntimeHandle {
  /** Opaque id unique per run. Adapter decides the format. */
  readonly runId: string;

  /**
   * Declarative snapshot. Reflects the last status event the adapter
   * emitted; consumers that need real-time progress should
   * `subscribe` instead.
   */
  readonly status: AgentRuntimeStatus;

  /**
   * Subscribe to events. Returns an unsubscribe function.
   * At-least-once delivery; listeners MUST be idempotent.
   */
  subscribe(listener: AgentRuntimeListener): () => void;

  /**
   * Stop the runtime. Resolves after the adapter has completed its
   * teardown (process exit, worker termination, server close —
   * adapter-specific).
   */
  stop(): Promise<void>;
}

/**
 * The adapter interface. Implementations translate a specific agent
 * framework / process model into the seam's shape.
 *
 * Minimal reference adapters live in this package under secondary
 * subpaths (`./stub` for tests, `./process` for subprocess-based
 * runtimes). Framework-specific adapters (Claude Agent SDK, OpenAI
 * Agents, Vercel AI SDK) belong in their own packages so pulling
 * the seam in doesn't drag an SDK's dependency graph along.
 */
export interface AgentRuntimeAdapter {
  /** Human-readable identifier — used in logs and the hub UI. */
  readonly name: string;

  /** Capability probe — see {@link AgentRuntimeCapabilities}. */
  readonly capabilities: AgentRuntimeCapabilities;

  /**
   * Boot the runtime. Resolves once the handle is safe to return —
   * the agent may still be `starting`; `status: 'ready'` surfaces
   * via the event stream.
   *
   * Throws only on permanent start-time errors (missing entry,
   * malformed config). Runtime crashes after boot travel through
   * the event stream + `handle.status === 'crashed'`.
   */
  start(input: AgentRuntimeStartInput): Promise<AgentRuntimeHandle>;
}
