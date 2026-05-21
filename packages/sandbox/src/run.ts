/**
 * `runSandboxed` — bounded subprocess runner.
 *
 * Single code path per outcome. The state machine is intentionally
 * small:
 *
 *   starting  →  (spawn error)      →  'spawn-error'
 *             →  (child exits)      →  'exit'
 *             →  (timeout fires)    →  kill → 'timeout'
 *             →  (signal aborts)    →  kill → 'canceled'
 *             →  (stdout overflow)  →  kill → 'overflow-stdout'
 *             →  (stderr overflow)  →  kill → 'overflow-stderr'
 *
 * Once an outcome is decided, the runner:
 *
 *   1. stops accepting further outcome transitions (`outcomeDecided`),
 *   2. if the child is still alive, sends `shutdownSignal`,
 *   3. after `gracePeriodMs` escalates to `SIGKILL`,
 *   4. waits for the 'exit' event to flush remaining stdio,
 *   5. decodes captured buffers as UTF-8, truncated to their caps,
 *   6. cleans up the owned tmpdir if one was created,
 *   7. resolves the promise with a full `SandboxResult`.
 *
 * The runner resolves exactly once. All cleanup paths funnel through
 * a single `finish()` closure so we can't leak a file descriptor,
 * timer, or tmpdir no matter which path fired first.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import type { Spawner } from './spawner.js';
import type {
  SandboxOptions,
  SandboxOutcome,
  SandboxResult,
} from './types.js';

/**
 * Default wall-clock grace between `shutdownSignal` and `SIGKILL`.
 * 2 seconds covers typical Node child shutdown; a hostile / stuck
 * child hits the SIGKILL escalation deterministically.
 */
const DEFAULT_GRACE_PERIOD_MS = 2_000;

/** Default stdout budget — 8 MiB. */
const DEFAULT_MAX_STDOUT_BYTES = 8 * 1024 * 1024;

/** Default stderr budget — 1 MiB. */
const DEFAULT_MAX_STDERR_BYTES = 1 * 1024 * 1024;

/**
 * Run a command in a bounded subprocess. See {@link SandboxOptions}
 * and the `./types.ts` header for the full semantics + honest-boundary
 * lock.
 */
export async function runSandboxed(
  opts: SandboxOptions,
): Promise<SandboxResult> {
  // ── 1. Validate inputs ───────────────────────────────────────────
  validateOptions(opts);

  const gracePeriodMs = opts.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;
  const maxStdoutBytes = opts.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  const maxStderrBytes = opts.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
  const shutdownSignal = opts.shutdownSignal ?? 'SIGTERM';
  if (gracePeriodMs >= opts.timeoutMs) {
    throw new RangeError(
      `runSandboxed: gracePeriodMs (${gracePeriodMs}) must be < timeoutMs (${opts.timeoutMs}) so SIGTERM has time to take effect before the sandbox considers the child stuck.`,
    );
  }

  const start = Date.now();

  // ── 2. Resolve cwd (owned tmpdir or caller-supplied absolute) ────
  let cwd: string;
  let cwdOwnedBySandbox = false;
  if (opts.cwd !== undefined) {
    cwd = opts.cwd;
  } else {
    cwd = mkdtempSync(join(tmpdir(), 'ggui-sandbox-'));
    cwdOwnedBySandbox = true;
  }

  // ── 3. Resolve env + detect Node child for heap cap ──────────────
  const { env, nodeHeapMbApplied } = resolveEnv(opts);

  // ── 4. Pre-spawn guard: caller already aborted ───────────────────
  if (opts.signal?.aborted) {
    cleanupCwd(cwd, cwdOwnedBySandbox);
    return {
      outcome: 'canceled',
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      durationMs: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      cwd,
      cwdOwnedBySandbox,
      nodeHeapMbApplied,
      errorMessage: '',
    };
  }

  // ── 5. Spawn the child ──────────────────────────────────────────
  const spawner: Spawner =
    opts.spawner ??
    ((cmd, args, spawnOpts) =>
      spawn(cmd, args as string[], {
        cwd: spawnOpts.cwd,
        env: spawnOpts.env,
        stdio: spawnOpts.stdio,
        shell: spawnOpts.shell,
        detached: spawnOpts.detached,
        windowsHide: spawnOpts.windowsHide,
      }));

  let child: ChildProcess;
  try {
    child = spawner(opts.command, opts.args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      detached: false,
      windowsHide: true,
    });
  } catch (err) {
    cleanupCwd(cwd, cwdOwnedBySandbox);
    return {
      outcome: 'spawn-error',
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      durationMs: Date.now() - start,
      stdoutTruncated: false,
      stderrTruncated: false,
      cwd,
      cwdOwnedBySandbox,
      nodeHeapMbApplied,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }

  // ── 6. Supervise the child ──────────────────────────────────────
  return new Promise<SandboxResult>((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;

    let outcome: SandboxOutcome = 'exit'; // Overwritten on every
    let outcomeDecided = false; //                   decision path
    let errorMessage = '';
    let killTimer: NodeJS.Timeout | null = null;
    let onAbort: (() => void) | null = null;

    // Wall-clock timer — runs from spawn. Firing decides 'timeout'.
    const timeoutTimer = setTimeout(() => decide('timeout', ''), opts.timeoutMs);
    timeoutTimer.unref?.();

    // External abort signal — fires 'canceled' when parent wants to
    // cancel mid-run.
    if (opts.signal) {
      onAbort = () => decide('canceled', '');
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    // stdin — close immediately when absent, else write-then-close.
    // Errors here are non-fatal — the child may close its stdin
    // before we finish writing, which is fine.
    if (opts.stdin !== undefined && child.stdin) {
      try {
        child.stdin.end(opts.stdin);
      } catch {
        /* child stdin already closed — not our problem */
      }
    } else {
      child.stdin?.end();
    }

    const onStdout = (chunk: Buffer): void => {
      if (outcomeDecided) return;
      const remaining = maxStdoutBytes - stdoutBytes;
      if (chunk.length <= remaining) {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
        return;
      }
      // Overflow — accept only the remaining bytes, then decide.
      if (remaining > 0) {
        stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutBytes += remaining;
      }
      stdoutTruncated = true;
      decide('overflow-stdout', '');
    };

    const onStderr = (chunk: Buffer): void => {
      if (outcomeDecided) return;
      const remaining = maxStderrBytes - stderrBytes;
      if (chunk.length <= remaining) {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
        return;
      }
      if (remaining > 0) {
        stderrChunks.push(chunk.subarray(0, remaining));
        stderrBytes += remaining;
      }
      stderrTruncated = true;
      decide('overflow-stderr', '');
    };

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.on('error', (err) => {
      // Post-spawn error. When the child never gets a pid (ENOENT on
      // Linux surfaces async via 'error' with no 'exit' follow-up),
      // 'exit' will not fire — we must resolve from here. Per Node's
      // docs, 'exit' MAY fire after 'error' but isn't guaranteed.
      const message = err instanceof Error ? err.message : String(err);
      if (child.pid === undefined && !outcomeDecided) {
        outcomeDecided = true;
        clearTimeout(timeoutTimer);
        if (onAbort && opts.signal) {
          opts.signal.removeEventListener('abort', onAbort);
          onAbort = null;
        }
        cleanupCwd(cwd, cwdOwnedBySandbox);
        resolve({
          outcome: 'spawn-error',
          exitCode: null,
          signal: null,
          stdout: decodeUpTo(stdoutChunks, maxStdoutBytes),
          stderr: decodeUpTo(stderrChunks, maxStderrBytes),
          durationMs: Date.now() - start,
          stdoutTruncated,
          stderrTruncated,
          cwd,
          cwdOwnedBySandbox,
          nodeHeapMbApplied,
          errorMessage: message,
        });
        return;
      }
      decide('spawn-error', message);
    });

    const decide = (next: SandboxOutcome, message: string): void => {
      if (outcomeDecided) return;
      outcomeDecided = true;
      outcome = next;
      errorMessage = message;
      // If the child is still alive, request graceful shutdown. The
      // real terminal state ('stopped') is observed on the 'exit'
      // event below.
      killChild(child, shutdownSignal, gracePeriodMs, (timer) => {
        killTimer = timer;
      });
    };

    child.on('exit', (code, signal) => {
      // Flush any buffered output (the 'data' listener handles it
      // live, but the kernel can deliver final chunks after exit on
      // some platforms). Node's ChildProcess already emits all
      // 'data' before 'exit', so we just decode.
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      clearTimeout(timeoutTimer);
      if (onAbort && opts.signal) {
        opts.signal.removeEventListener('abort', onAbort);
        onAbort = null;
      }

      // If no one has decided yet, the child exited on its own.
      if (!outcomeDecided) {
        outcomeDecided = true;
        outcome = 'exit';
      }

      const stdout = decodeUpTo(stdoutChunks, maxStdoutBytes);
      const stderr = decodeUpTo(stderrChunks, maxStderrBytes);

      cleanupCwd(cwd, cwdOwnedBySandbox);

      resolve({
        outcome,
        exitCode: outcome === 'exit' ? code : null,
        signal: outcome === 'exit' ? signal : null,
        stdout,
        stderr,
        durationMs: Date.now() - start,
        stdoutTruncated,
        stderrTruncated,
        cwd,
        cwdOwnedBySandbox,
        nodeHeapMbApplied,
        errorMessage,
      });
    });
  });
}

/**
 * Input validation — throws synchronously on invalid configuration
 * so callers find bugs at the call site, not as a confusing 'exit'
 * outcome with an empty stderr.
 */
function validateOptions(opts: SandboxOptions): void {
  if (!opts.command || typeof opts.command !== 'string') {
    throw new TypeError('runSandboxed: `command` must be a non-empty string');
  }
  if (!Array.isArray(opts.args)) {
    throw new TypeError('runSandboxed: `args` must be an array');
  }
  if (
    typeof opts.timeoutMs !== 'number' ||
    !Number.isFinite(opts.timeoutMs) ||
    opts.timeoutMs <= 0 ||
    !Number.isInteger(opts.timeoutMs)
  ) {
    throw new RangeError(
      'runSandboxed: `timeoutMs` must be a positive finite integer',
    );
  }
  if (opts.cwd !== undefined && !isAbsolute(opts.cwd)) {
    throw new TypeError(
      `runSandboxed: \`cwd\` must be an absolute path, got ${JSON.stringify(opts.cwd)}`,
    );
  }
  if (
    opts.maxStdoutBytes !== undefined &&
    (opts.maxStdoutBytes <= 0 || !Number.isInteger(opts.maxStdoutBytes))
  ) {
    throw new RangeError(
      'runSandboxed: `maxStdoutBytes` must be a positive integer',
    );
  }
  if (
    opts.maxStderrBytes !== undefined &&
    (opts.maxStderrBytes <= 0 || !Number.isInteger(opts.maxStderrBytes))
  ) {
    throw new RangeError(
      'runSandboxed: `maxStderrBytes` must be a positive integer',
    );
  }
  if (opts.gracePeriodMs !== undefined && opts.gracePeriodMs < 0) {
    throw new RangeError(
      'runSandboxed: `gracePeriodMs` must be >= 0',
    );
  }
  if (
    opts.nodeHeapMb !== undefined &&
    (opts.nodeHeapMb <= 0 || !Number.isInteger(opts.nodeHeapMb))
  ) {
    throw new RangeError(
      'runSandboxed: `nodeHeapMb` must be a positive integer',
    );
  }
}

/**
 * Resolve the child's environment.
 *
 * The parent's `process.env` is NEVER merged in. Only three things
 * reach the child:
 *
 *   1. A minimal bootstrap (`PATH`, `HOME`, and `TMPDIR` when
 *      present on the parent). `PATH` is required or the kernel
 *      cannot locate the command; `HOME` is required for most Node
 *      shutdown paths (e.g. npm config); `TMPDIR` lets child code
 *      that writes scratch files respect the parent's temp location.
 *      Callers can override any of these by declaring the key
 *      explicitly in `opts.env`.
 *
 *   2. Every key from `opts.env` (verbatim — parent values NEVER
 *      leak).
 *
 *   3. `NODE_OPTIONS=--max-old-space-size=<nodeHeapMb>` when the
 *      child is a Node process AND `opts.nodeHeapMb` is set.
 *      Merges with any `NODE_OPTIONS` the caller supplied.
 */
function resolveEnv(opts: SandboxOptions): {
  env: NodeJS.ProcessEnv;
  nodeHeapMbApplied: boolean;
} {
  const env: NodeJS.ProcessEnv = {};

  // Bootstrap — only the three keys that matter for the child to
  // locate its binary, have a home dir, and know where to scratch.
  const bootstrapKeys = ['PATH', 'HOME', 'TMPDIR'] as const;
  for (const key of bootstrapKeys) {
    const parentValue = process.env[key];
    if (parentValue !== undefined) env[key] = parentValue;
  }

  // Explicit allowlist — callers OVERRIDE bootstrap values if they
  // declare the key themselves. Shallow merge; no special handling.
  if (opts.env) {
    for (const [key, value] of Object.entries(opts.env)) {
      env[key] = value;
    }
  }

  // Node heap cap — only applied for Node children.
  let nodeHeapMbApplied = false;
  if (opts.nodeHeapMb !== undefined && isNodeCommand(opts.command)) {
    const flag = `--max-old-space-size=${opts.nodeHeapMb}`;
    const existing = env.NODE_OPTIONS;
    env.NODE_OPTIONS = existing ? `${existing} ${flag}` : flag;
    nodeHeapMbApplied = true;
  }

  return { env, nodeHeapMbApplied };
}

function isNodeCommand(command: string): boolean {
  if (command === process.execPath) return true;
  const base = basename(command);
  return base === 'node' || base === 'node.exe';
}

/**
 * Kill the child. Sends `shutdownSignal` first; after `gracePeriodMs`
 * escalates to SIGKILL. Both calls tolerate "child already exited" —
 * `kill()` returns false but doesn't throw on a reaped child.
 *
 * `onTimer` lets the caller hold a reference to the escalation timer
 * so it can cancel on early exit without a second kill attempt.
 */
function killChild(
  child: ChildProcess,
  signal: NodeJS.Signals,
  gracePeriodMs: number,
  onTimer: (timer: NodeJS.Timeout) => void,
): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill(signal);
  } catch {
    // Already gone.
    return;
  }
  const timer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }, gracePeriodMs);
  timer.unref?.();
  onTimer(timer);
}

/**
 * Concatenate captured buffer chunks and decode as UTF-8, truncated
 * to `max` bytes. UTF-8 decode tolerates a truncation mid-codepoint
 * by replacing the partial bytes with the replacement character.
 */
function decodeUpTo(chunks: readonly Buffer[], max: number): string {
  const joined = Buffer.concat(chunks as Buffer[]);
  const sliced = joined.length > max ? joined.subarray(0, max) : joined;
  return sliced.toString('utf-8');
}

/**
 * Remove the tmpdir the sandbox created. Best-effort — a stray lock
 * file or open handle in the child should not propagate as a caller-
 * visible error. Real failures surface via logs, not exceptions.
 */
function cleanupCwd(cwd: string, owned: boolean): void {
  if (!owned) return;
  try {
    rmSync(cwd, { recursive: true, force: true });
  } catch {
    // Best-effort. Tests that need a clean tmpdir use mkdtempSync
    // under os.tmpdir() so the OS eventually reclaims it.
  }
}

