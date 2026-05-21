/**
 * `@ggui-ai/sandbox` — public API types.
 *
 * One high-level entry point (`runSandboxed`) with a small, pinned
 * surface. The discriminated `SandboxOutcome` lets callers branch on
 * terminal state without re-deriving it from exit codes / signals.
 *
 * ## Honest security boundary (MVP)
 *
 * What this package DOES enforce, portably, from pure Node:
 *
 *   - **Process boundary.** Work runs in a fresh `child_process.spawn`
 *     subprocess with `shell: false` + `detached: false` + `stdio:
 *     ['pipe', 'pipe', 'pipe']`. The child cannot attach to the
 *     parent's controlling terminal, cannot inherit open fds, and
 *     cannot fork into a new process group. A crash in the child
 *     cannot corrupt parent state.
 *
 *   - **Working-directory isolation.** Callers either bring their own
 *     absolute `cwd` or let the sandbox mint an owned tmpdir that it
 *     cleans up on finish. Relative paths inside the child resolve
 *     against the declared `cwd` only. (Not an FS boundary — the
 *     child still has the parent user's read permissions on absolute
 *     paths; see "Does NOT enforce" below.)
 *
 *   - **Environment allowlist.** The child receives the `env` object
 *     verbatim. The parent's `process.env` is NEVER merged.
 *     Consumers that want to expose specific variables write them
 *     explicitly. A minimal bootstrap (`PATH`, `HOME`, `TMPDIR` if
 *     present on the parent) is injected only so the child can
 *     resolve the command and write scratch data — and is documented
 *     in {@link SandboxOptions.env}.
 *
 *   - **Wall-clock timeout.** `timeoutMs` is required — no
 *     "infinity." On overrun the sandbox sends `SIGTERM`, waits
 *     `gracePeriodMs`, then escalates to `SIGKILL`. Outcome is
 *     `'timeout'`.
 *
 *   - **Output byte caps.** stdout + stderr are accumulated up to
 *     `maxStdoutBytes` / `maxStderrBytes`. When either is exceeded
 *     the sandbox terminates the child and returns outcome
 *     `'overflow-stdout'` / `'overflow-stderr'`. Captured output is
 *     truncated to exactly the cap.
 *
 *   - **V8 heap cap (Node children only).** When `nodeHeapMb` is
 *     set AND the command is `process.execPath` (or has the basename
 *     `node`), the sandbox prepends `--max-old-space-size=<mb>` to
 *     `args` via the `NODE_OPTIONS` env var. This caps V8's old-
 *     generation heap. It does NOT cap total RSS (native buffers,
 *     ArrayBuffers, child-of-child memory).
 *
 *   - **No stdin leakage.** When `stdin` is absent the child's stdin
 *     is closed immediately. When present, the sandbox writes exactly
 *     the supplied bytes then closes. The parent never forwards its
 *     own stdin.
 *
 * What this package does NOT enforce (portably from Node):
 *
 *   - **Network egress blocking.** Impossible portably from Node
 *     user-space. Real enforcement needs OS primitives: Linux
 *     network namespaces + iptables, macOS pf, Windows WFP, or a
 *     sidecar (Docker network:none, gVisor, firecracker). Consumers
 *     who need no-egress MUST layer those themselves; the sandbox
 *     does not pretend.
 *
 *   - **Filesystem read boundaries.** The child shares the parent
 *     process's UID/GID + filesystem visibility. Relative paths
 *     resolve under `cwd`, but absolute paths and `..` traversals
 *     remain reachable. A true FS sandbox needs chroot / pivot_root /
 *     user namespaces / Landlock (Linux) / sandbox-exec (macOS).
 *
 *   - **CPU share / scheduling cap.** Node has no portable rlimit
 *     surface for CPU time. Consumers who need CPU caps run the
 *     sandbox under a cgroup / `ulimit` / container.
 *
 *   - **Syscall filtering.** No seccomp, no LSM hooks. The child can
 *     make any syscall the parent could.
 *
 *   - **Fork-bomb containment.** No `RLIMIT_NPROC`. A malicious
 *     child could spawn descendants that the sandbox does NOT track
 *     or kill. (The sandbox kills only its direct child; grandchildren
 *     survive if they reparent.)
 *
 * Every "does not" above is a deliberate omission to keep the MVP
 * portable + honest. Consumers that require any of those guarantees
 * run the sandbox under a stronger layer (Docker, gVisor, firecracker,
 * etc.) — the sandbox does not lie about what it gives them.
 */
import type { Spawner } from './spawner.js';

/**
 * Options for a single {@link runSandboxed} invocation. Immutable —
 * callers construct a fresh object per run.
 */
export interface SandboxOptions {
  /**
   * Absolute path to the executable. Required. No shell interpretation
   * (`shell: false` is the only supported mode); to run a Node script
   * pass `process.execPath` or a resolved `node` path and put the
   * script path in `args`.
   */
  readonly command: string;

  /**
   * Args forwarded verbatim to the child. Pass `[]` for no args.
   */
  readonly args: readonly string[];

  /**
   * Working directory. Absolute paths only. Absent = sandbox creates
   * an owned tmpdir under `os.tmpdir()` and removes it at the end
   * of the run (result.cwdOwnedBySandbox === true). Relative paths
   * are rejected — the sandbox does not silently resolve against the
   * parent's CWD.
   */
  readonly cwd?: string;

  /**
   * Environment variables exposed to the child. **The parent's
   * `process.env` is NEVER merged in.** Only the keys in this map
   * plus a minimal bootstrap (`PATH`, `HOME`, and `TMPDIR` when
   * present on the parent — required so the kernel + Node can find
   * the command and write scratch data) reach the child. Callers
   * that want to forward extra variables do so explicitly by reading
   * `process.env` and copying the keys they want.
   *
   * Absent = empty allowlist (child gets only the bootstrap).
   */
  readonly env?: Readonly<Record<string, string>>;

  /**
   * Wall-clock timeout in milliseconds. Required — the sandbox does
   * not support "run forever." Must be a positive finite integer.
   *
   * On overrun:
   *   1. sandbox sends {@link shutdownSignal} to the child,
   *   2. waits up to {@link gracePeriodMs},
   *   3. escalates to `SIGKILL` if the child is still alive.
   *
   * Outcome is `'timeout'`.
   */
  readonly timeoutMs: number;

  /**
   * Signal to send when terminating. Defaults to `'SIGTERM'`.
   * The escalation to `'SIGKILL'` after {@link gracePeriodMs} is
   * unconditional and not configurable.
   */
  readonly shutdownSignal?: NodeJS.Signals;

  /**
   * Grace period in ms between the soft-kill signal and the hard
   * `SIGKILL`. Defaults to `2000`. Must be >= 0 and < {@link
   * timeoutMs} to leave headroom for a child that ignores SIGTERM.
   */
  readonly gracePeriodMs?: number;

  /**
   * Optional data written to the child's stdin. When omitted, stdin
   * is closed immediately and the child reads EOF. Strings are
   * encoded as UTF-8; `Uint8Array` is written verbatim.
   */
  readonly stdin?: string | Uint8Array;

  /**
   * Max bytes to capture from stdout before terminating the child.
   * Defaults to `8 * 1024 * 1024` (8 MiB). Must be > 0.
   * Exceeding the cap terminates the child with outcome
   * `'overflow-stdout'`; captured stdout is truncated to the cap.
   */
  readonly maxStdoutBytes?: number;

  /**
   * Max bytes to capture from stderr before terminating the child.
   * Defaults to `1 * 1024 * 1024` (1 MiB). Must be > 0.
   * Exceeding the cap terminates the child with outcome
   * `'overflow-stderr'`; captured stderr is truncated to the cap.
   */
  readonly maxStderrBytes?: number;

  /**
   * V8 old-generation heap cap in MiB. Applied only when the
   * resolved `command` basename is `node` (or equals
   * `process.execPath`). For non-Node children the field is ignored
   * and {@link SandboxResult.nodeHeapMbApplied} is `false`.
   *
   * Applied via `NODE_OPTIONS=--max-old-space-size=<mb>`. Caps V8's
   * old-gen only — not total RSS.
   */
  readonly nodeHeapMb?: number;

  /**
   * External cancellation. When the signal fires, the sandbox
   * terminates the child (SIGTERM → grace → SIGKILL) and returns
   * outcome `'canceled'`.
   */
  readonly signal?: AbortSignal;

  /**
   * Test seam — substitute a spawner to exercise the runner without
   * launching real processes. Production code leaves this unset.
   */
  readonly spawner?: Spawner;
}

/**
 * Terminal state of a sandbox run. Exhaustive; every possible
 * shutdown path maps to exactly one of these.
 */
export type SandboxOutcome =
  /** Child exited on its own within the budget. `exitCode`/`signal`
   * record why. */
  | 'exit'
  /** `timeoutMs` elapsed; sandbox killed the child. */
  | 'timeout'
  /** External `signal` aborted the run; sandbox killed the child. */
  | 'canceled'
  /** stdout exceeded `maxStdoutBytes`; sandbox killed the child. */
  | 'overflow-stdout'
  /** stderr exceeded `maxStderrBytes`; sandbox killed the child. */
  | 'overflow-stderr'
  /** Spawn failed or an internal error occurred before the child
   * could be supervised. `errorMessage` carries detail. */
  | 'spawn-error';

/**
 * Result of a {@link runSandboxed} invocation. All fields are
 * non-optional — consumers get a consistent shape whatever the
 * outcome. Fields that are only meaningful for some outcomes carry
 * documented sentinels (e.g. `exitCode: null` for signal-induced
 * termination).
 */
export interface SandboxResult {
  /** Terminal state. */
  readonly outcome: SandboxOutcome;

  /** Exit code when the child exited on its own; `null` when the
   * sandbox killed it or spawn failed. */
  readonly exitCode: number | null;

  /** Signal that terminated the child; `null` when the child exited
   * with an explicit code or spawn failed. */
  readonly signal: NodeJS.Signals | null;

  /** Captured stdout, decoded as UTF-8. Truncated to
   * `maxStdoutBytes`. */
  readonly stdout: string;

  /** Captured stderr, decoded as UTF-8. Truncated to
   * `maxStderrBytes`. */
  readonly stderr: string;

  /** Wall-clock duration in milliseconds. */
  readonly durationMs: number;

  /** True iff stdout output was truncated (actual stream was larger
   * than `maxStdoutBytes`). */
  readonly stdoutTruncated: boolean;

  /** True iff stderr output was truncated. */
  readonly stderrTruncated: boolean;

  /** Absolute `cwd` the child ran in. When the caller brought their
   * own it is echoed back; when the sandbox minted one this points
   * at the owned tmpdir (already removed by the time the result
   * resolves, per `cwdOwnedBySandbox`). */
  readonly cwd: string;

  /** True iff the sandbox created (and cleaned up) `cwd`. */
  readonly cwdOwnedBySandbox: boolean;

  /** True iff the sandbox applied the V8 heap cap (Node child only). */
  readonly nodeHeapMbApplied: boolean;

  /** Human-readable reason when `outcome === 'spawn-error'`.
   * Empty string for every other outcome. */
  readonly errorMessage: string;
}
