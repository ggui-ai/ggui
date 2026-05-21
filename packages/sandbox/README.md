# @ggui-ai/sandbox

Bounded process-isolation runner for untrusted Node subprocesses.

## Usage

```ts
import { runSandboxed } from "@ggui-ai/sandbox";

const result = await runSandboxed({
  command: process.execPath, // node
  args: ["./build-probe.js"],
  timeoutMs: 15_000,
  env: { NODE_ENV: "production" }, // parent process.env NEVER merged
  maxStdoutBytes: 4 * 1024 * 1024, // 4 MiB cap
  nodeHeapMb: 256,
});

if (result.outcome === "exit" && result.exitCode === 0) {
  // result.stdout + result.stderr captured, child gone, tmpdir cleaned.
}
```

## What it actually enforces (MVP)

One subprocess, one bounded run, one pinned outcome. Portably, from pure Node user-space:

- **Process boundary.** `spawn` with `shell: false`, `detached: false`, `windowsHide: true`, `stdio: ['pipe','pipe','pipe']`. Child cannot attach to the parent's controlling terminal, cannot fork into a new process group, cannot inherit open fds.
- **Working-directory isolation.** Caller supplies an absolute `cwd`, or the sandbox mints an owned `mkdtempSync` dir and removes it at the end of the run. Relative `cwd` values are rejected at validation — no silent resolve against the parent's CWD.
- **Environment allowlist.** The parent's `process.env` is **never** merged in. Only the caller's `env` keys plus a minimal bootstrap (`PATH`, `HOME`, `TMPDIR` when present on the parent) reach the child. Callers that want to forward extra vars copy them in explicitly.
- **Wall-clock timeout.** `timeoutMs` is required. On overrun the sandbox sends `SIGTERM`, waits `gracePeriodMs`, then escalates to `SIGKILL`. Outcome is `'timeout'`.
- **Output byte caps.** `stdout` and `stderr` are captured up to `maxStdoutBytes` / `maxStderrBytes` (defaults: 8 MiB / 1 MiB). Exceeding the cap terminates the child with outcome `'overflow-stdout'` / `'overflow-stderr'` and the captured output is truncated to exactly the cap.
- **No stdin leakage.** Absent `stdin` → closed immediately. Present → written then closed. Parent stdin is never forwarded.
- **V8 heap cap (Node children only).** When `nodeHeapMb` is set AND the command basename is `node` / equals `process.execPath`, the sandbox prepends `--max-old-space-size=<mb>` to `NODE_OPTIONS`. Caps V8's old-generation heap only.

Every decision path funnels through a single `finish()` closure — no fd, timer, or tmpdir leaks regardless of which termination path fires first.

## What it does NOT enforce

All of the following need OS-level primitives (network namespaces, seccomp, cgroups, chroot/Landlock) that aren't portable from Node user-space. Consumers who need these run the sandbox under a stronger layer (Docker `network:none`, gVisor, firecracker, systemd with the right ambient config):

- **Network egress blocking.** Not enforced. The child has the same network access as the parent.
- **Filesystem read boundaries.** Not enforced. The child runs as the parent's UID/GID and can read anything the parent can. Relative paths resolve under `cwd`; absolute paths and `..` traversal remain reachable.
- **CPU share / scheduling cap.** Not enforced. Node has no portable rlimit surface for CPU time. Total RSS is not capped either — only V8's old-gen heap (and only when the child is Node).
- **Syscall filtering.** Not enforced. No seccomp, no LSM hooks. The child can make any syscall the parent could.
- **Fork-bomb / grandchild containment.** Not enforced. The sandbox kills only its direct child; descendants that reparent (the classic daemon / double-fork trick) survive.

If the threat model requires any of these guarantees, **do not rely on this package alone**. The sandbox is the portable MVP; stacking it under Docker / gVisor / firecracker is the production posture, not a "later" improvement.

## API

```ts
runSandboxed(opts: SandboxOptions): Promise<SandboxResult>
```

### `SandboxOptions`

| Field            | Required | Default      | Notes                                                     |
| ---------------- | -------- | ------------ | --------------------------------------------------------- |
| `command`        | ✅       | —            | Absolute path to the executable. No shell interpretation. |
| `args`           | ✅       | —            | Forwarded verbatim. Pass `[]` for no args.                |
| `cwd`            | ❌       | owned tmpdir | Must be absolute when supplied.                           |
| `env`            | ❌       | `{}`         | Allowlist. Parent's `process.env` is NEVER merged.        |
| `timeoutMs`      | ✅       | —            | Positive finite integer. No "infinity".                   |
| `shutdownSignal` | ❌       | `'SIGTERM'`  | Soft-kill signal; SIGKILL escalation is unconditional.    |
| `gracePeriodMs`  | ❌       | `2000`       | Must be `< timeoutMs`.                                    |
| `stdin`          | ❌       | closed       | `string \| Uint8Array`. Absent = immediate EOF.           |
| `maxStdoutBytes` | ❌       | 8 MiB        | Positive integer. Overflow → `'overflow-stdout'`.         |
| `maxStderrBytes` | ❌       | 1 MiB        | Positive integer. Overflow → `'overflow-stderr'`.         |
| `nodeHeapMb`     | ❌       | —            | Node children only. Sets `--max-old-space-size`.          |
| `signal`         | ❌       | —            | External `AbortSignal` → outcome `'canceled'`.            |
| `spawner`        | ❌       | real `spawn` | Test seam; production leaves unset.                       |

### `SandboxResult`

```ts
interface SandboxResult {
  outcome: "exit" | "timeout" | "canceled" | "overflow-stdout" | "overflow-stderr" | "spawn-error";
  exitCode: number | null; // present only on 'exit'
  signal: NodeJS.Signals | null; // present only on 'exit'
  stdout: string; // UTF-8, truncated to maxStdoutBytes
  stderr: string; // UTF-8, truncated to maxStderrBytes
  durationMs: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  cwd: string; // absolute
  cwdOwnedBySandbox: boolean; // true → already cleaned up
  nodeHeapMbApplied: boolean;
  errorMessage: string; // non-empty only on 'spawn-error'
}
```

## Typical use

The UI-gen render-probe path uses this package so LLM-generated TSX never executes in the parent Node process — each render spawns a subprocess through `runSandboxed` with a short timeout, a bounded stdout cap, a V8 heap cap, a sandbox-owned tmpdir cwd, and an env allowlist forwarding only `NODE_ENV`.

## License

Apache 2.0
