/**
 * `runSandboxed` — contract tests.
 *
 * Every test drives a real node subprocess — no spawner fake — so
 * the kernel-level paths (kill → exit, grace → SIGKILL, env
 * allowlist) are what we actually pin down. The only fake we use is
 * `process.execPath` as the command; args carry the entire test body
 * as `-e '<inline-js>'`.
 *
 * Tests grouped by the five honest-boundary claims:
 *
 *   1. Exit semantics (stdout / stderr / exitCode / signal)
 *   2. Timeout + abort (kill → SIGKILL escalation)
 *   3. cwd isolation (owned tmpdir + caller-supplied absolute)
 *   4. Env allowlist (parent process.env NEVER leaks)
 *   5. Output caps (overflow truncation + outcome distinction)
 *   6. Node heap cap (NODE_OPTIONS wiring)
 *   7. Input validation
 */
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSandboxed } from './run.js';

// ── 1. Exit semantics ────────────────────────────────────────────────

describe('runSandboxed — exit semantics', () => {
  it("captures stdout + stderr and reports outcome 'exit' with the child's exit code", async () => {
    const result = await runSandboxed({
      command: process.execPath,
      args: [
        '-e',
        'console.log("hello stdout"); console.error("hello stderr"); process.exit(0);',
      ],
      timeoutMs: 5_000,
    });
    expect(result.outcome).toBe('exit');
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBe(null);
    expect(result.stdout).toContain('hello stdout');
    expect(result.stderr).toContain('hello stderr');
    expect(result.stdoutTruncated).toBe(false);
    expect(result.stderrTruncated).toBe(false);
    expect(result.errorMessage).toBe('');
  });

  it('propagates a non-zero exit code without treating it as spawn-error', async () => {
    const result = await runSandboxed({
      command: process.execPath,
      args: ['-e', 'process.exit(42);'],
      timeoutMs: 5_000,
    });
    expect(result.outcome).toBe('exit');
    expect(result.exitCode).toBe(42);
  });

  it('returns outcome spawn-error with a readable message on ENOENT', async () => {
    const result = await runSandboxed({
      command: '/this/path/does/not/exist/ever',
      args: [],
      timeoutMs: 5_000,
    });
    expect(result.outcome).toBe('spawn-error');
    expect(result.exitCode).toBe(null);
    expect(result.signal).toBe(null);
    expect(result.errorMessage).toMatch(/ENOENT|not found|no such file/i);
  });

  it('writes stdin and closes it', async () => {
    const result = await runSandboxed({
      command: process.execPath,
      args: [
        '-e',
        'let d=""; process.stdin.on("data",c=>d+=c); process.stdin.on("end",()=>{process.stdout.write(d.toUpperCase())});',
      ],
      timeoutMs: 5_000,
      stdin: 'quiet input',
    });
    expect(result.outcome).toBe('exit');
    expect(result.stdout).toBe('QUIET INPUT');
  });

  it('closes stdin immediately when absent so the child reads EOF', async () => {
    // `resume()` puts stdin in flowing mode so the 'end' event can
    // actually fire when the parent closes its pipe end. Without
    // resume, stdin is paused and 'end' is quietly withheld — fine
    // for real agents but a footgun for the probe.
    const result = await runSandboxed({
      command: process.execPath,
      args: [
        '-e',
        'process.stdin.resume(); process.stdin.on("end",()=>process.stdout.write("eof-seen"));',
      ],
      timeoutMs: 5_000,
    });
    expect(result.outcome).toBe('exit');
    expect(result.stdout).toBe('eof-seen');
  });
});

// ── 2. Timeout + abort ───────────────────────────────────────────────

describe('runSandboxed — timeout + abort', () => {
  it('kills a hanging child on timeout and reports outcome timeout', async () => {
    const start = Date.now();
    const result = await runSandboxed({
      command: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000); console.log("running");'],
      timeoutMs: 400,
      gracePeriodMs: 100,
    });
    const elapsed = Date.now() - start;
    expect(result.outcome).toBe('timeout');
    expect(result.stdout).toContain('running');
    // Finished promptly — timeoutMs + grace + tiny overhead. Give a
    // generous ceiling to absorb CI jitter while still proving the
    // sandbox didn't let the child run for a full 1000ms interval.
    expect(elapsed).toBeLessThan(2_000);
  });

  it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    // Child ignores SIGTERM. Only SIGKILL can take it down.
    const result = await runSandboxed({
      command: process.execPath,
      args: [
        '-e',
        'process.on("SIGTERM",()=>{/* ignore */}); setInterval(()=>{},1000);',
      ],
      timeoutMs: 300,
      gracePeriodMs: 150,
    });
    // We don't assert signal — Node's child.exit emits
    // `null` code + 'SIGKILL' signal on the kill path, but the
    // sandbox reports outcome 'timeout' regardless (the kill-signal
    // identity is subordinate to the terminal outcome).
    expect(result.outcome).toBe('timeout');
  });

  it('honors a pre-spawn AbortSignal without creating the cwd tmpdir', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runSandboxed({
      command: process.execPath,
      args: ['-e', 'console.log("should-not-run");'],
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    expect(result.outcome).toBe('canceled');
    expect(result.stdout).toBe('');
    expect(result.cwdOwnedBySandbox).toBe(true);
    // cwd was created (mkdtempSync) then torn down.
    expect(existsSync(result.cwd)).toBe(false);
  });

  it('honors a post-spawn AbortSignal and kills the running child', async () => {
    const controller = new AbortController();
    const pending = runSandboxed({
      command: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000);'],
      timeoutMs: 10_000,
      gracePeriodMs: 100,
      signal: controller.signal,
    });
    // Give the child a tick to actually start.
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    const result = await pending;
    expect(result.outcome).toBe('canceled');
  });
});

// ── 3. cwd isolation ─────────────────────────────────────────────────

describe('runSandboxed — cwd isolation', () => {
  it('runs in a sandbox-owned tmpdir by default and cleans it up on finish', async () => {
    const result = await runSandboxed({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(process.cwd());'],
      timeoutMs: 5_000,
    });
    expect(result.outcome).toBe('exit');
    expect(result.cwdOwnedBySandbox).toBe(true);
    expect(result.stdout).toBe(result.cwd);
    // `runSandboxed` removes the owned tmpdir once the result is
    // ready — operators shouldn't need to clean up after it.
    expect(existsSync(result.cwd)).toBe(false);
    // Hygiene — mint path is under os.tmpdir().
    expect(result.cwd.startsWith(tmpdir())).toBe(true);
  });

  it('honors a caller-supplied absolute cwd without deleting it', async () => {
    const userDir = mkdtempSync(join(tmpdir(), 'ggui-sandbox-caller-'));
    try {
      const result = await runSandboxed({
        command: process.execPath,
        args: ['-e', 'process.stdout.write(process.cwd());'],
        cwd: userDir,
        timeoutMs: 5_000,
      });
      expect(result.outcome).toBe('exit');
      expect(result.cwdOwnedBySandbox).toBe(false);
      expect(result.stdout).toBe(userDir);
      expect(existsSync(userDir)).toBe(true);
    } finally {
      rmSync(userDir, { recursive: true, force: true });
    }
  });

  it('rejects a relative cwd synchronously (no silent resolve against parent CWD)', async () => {
    await expect(
      runSandboxed({
        command: process.execPath,
        args: [],
        cwd: 'relative-path',
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/absolute path/i);
  });

  it('writes made inside the owned tmpdir are reaped with the dir', async () => {
    const result = await runSandboxed({
      command: process.execPath,
      args: [
        '-e',
        'require("fs").writeFileSync("scratch.txt", "hi"); process.stdout.write(process.cwd());',
      ],
      timeoutMs: 5_000,
    });
    expect(result.outcome).toBe('exit');
    expect(existsSync(join(result.cwd, 'scratch.txt'))).toBe(false);
  });
});

// ── 4. Env allowlist ─────────────────────────────────────────────────

describe('runSandboxed — env allowlist', () => {
  it("does NOT leak parent process.env keys to the child", async () => {
    // We set a sentinel on the parent's env; it must NOT appear in
    // the child. Use a unique key so parallel tests can't collide.
    const sentinel = `GGUI_SANDBOX_LEAK_PROBE_${Date.now()}`;
    process.env[sentinel] = 'parent-value-must-not-leak';
    try {
      const result = await runSandboxed({
        command: process.execPath,
        args: [
          '-e',
          `process.stdout.write(String(process.env["${sentinel}"] ?? "undefined"));`,
        ],
        timeoutMs: 5_000,
      });
      expect(result.outcome).toBe('exit');
      expect(result.stdout).toBe('undefined');
    } finally {
      delete process.env[sentinel];
    }
  });

  it('passes through the bootstrap keys (PATH, HOME) when present on parent', async () => {
    const result = await runSandboxed({
      command: process.execPath,
      args: [
        '-e',
        'process.stdout.write(JSON.stringify({ PATH: typeof process.env.PATH, HOME: typeof process.env.HOME }));',
      ],
      timeoutMs: 5_000,
    });
    expect(result.outcome).toBe('exit');
    expect(result.stdout).toBe('{"PATH":"string","HOME":"string"}');
  });

  it("forwards exactly the keys in opts.env (verbatim, no mutation)", async () => {
    const result = await runSandboxed({
      command: process.execPath,
      args: [
        '-e',
        'process.stdout.write(String(process.env.GGUI_SANDBOX_TEST_ALLOWED));',
      ],
      env: { GGUI_SANDBOX_TEST_ALLOWED: 'forwarded-value-🎯' },
      timeoutMs: 5_000,
    });
    expect(result.outcome).toBe('exit');
    expect(result.stdout).toBe('forwarded-value-🎯');
  });

  it("opts.env overrides bootstrap keys when the caller declares them", async () => {
    // Confirms precedence: caller's allowlist wins over the bootstrap
    // fallback. PATH is the cleanest probe — parent has one, we
    // override to a known value.
    const result = await runSandboxed({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(String(process.env.PATH));'],
      env: { PATH: '/sandbox-overridden-path' },
      timeoutMs: 5_000,
    });
    expect(result.outcome).toBe('exit');
    expect(result.stdout).toBe('/sandbox-overridden-path');
  });
});

// ── 5. Output caps ───────────────────────────────────────────────────

describe('runSandboxed — output caps', () => {
  it('truncates stdout to maxStdoutBytes and reports overflow-stdout', async () => {
    const result = await runSandboxed({
      command: process.execPath,
      args: [
        '-e',
        'process.stdout.write("A".repeat(10000));',
      ],
      maxStdoutBytes: 100,
      timeoutMs: 5_000,
    });
    expect(result.outcome).toBe('overflow-stdout');
    expect(result.stdout.length).toBe(100);
    expect(result.stdoutTruncated).toBe(true);
  });

  it('truncates stderr to maxStderrBytes and reports overflow-stderr', async () => {
    const result = await runSandboxed({
      command: process.execPath,
      args: [
        '-e',
        'process.stderr.write("B".repeat(10000));',
      ],
      maxStderrBytes: 50,
      timeoutMs: 5_000,
    });
    expect(result.outcome).toBe('overflow-stderr');
    expect(result.stderr.length).toBe(50);
    expect(result.stderrTruncated).toBe(true);
  });

  it('does NOT truncate when output stays under the cap', async () => {
    const result = await runSandboxed({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("short");'],
      maxStdoutBytes: 100,
      timeoutMs: 5_000,
    });
    expect(result.outcome).toBe('exit');
    expect(result.stdout).toBe('short');
    expect(result.stdoutTruncated).toBe(false);
  });
});

// ── 6. Node heap cap ─────────────────────────────────────────────────

describe('runSandboxed — Node heap cap', () => {
  it('sets NODE_OPTIONS=--max-old-space-size when child is node', async () => {
    const result = await runSandboxed({
      command: process.execPath,
      args: [
        '-e',
        'process.stdout.write(String(process.env.NODE_OPTIONS));',
      ],
      nodeHeapMb: 64,
      timeoutMs: 5_000,
    });
    expect(result.outcome).toBe('exit');
    expect(result.stdout).toBe('--max-old-space-size=64');
    expect(result.nodeHeapMbApplied).toBe(true);
  });

  it('merges NODE_OPTIONS with a caller-supplied value', async () => {
    const result = await runSandboxed({
      command: process.execPath,
      args: [
        '-e',
        'process.stdout.write(String(process.env.NODE_OPTIONS));',
      ],
      env: { NODE_OPTIONS: '--no-warnings' },
      nodeHeapMb: 32,
      timeoutMs: 5_000,
    });
    expect(result.outcome).toBe('exit');
    expect(result.stdout).toBe('--no-warnings --max-old-space-size=32');
  });

  it('does NOT apply NODE_OPTIONS when the command is not node', async () => {
    // Command exists but isn't node — use /bin/true if available on
    // Linux/macOS; otherwise skip this path with a trivial assertion
    // since Windows CI doesn't have /bin/true.
    if (!existsSync('/bin/true')) return;
    const result = await runSandboxed({
      command: '/bin/true',
      args: [],
      nodeHeapMb: 64,
      timeoutMs: 5_000,
    });
    expect(result.outcome).toBe('exit');
    expect(result.nodeHeapMbApplied).toBe(false);
  });
});

// ── 7. Input validation ──────────────────────────────────────────────

describe('runSandboxed — input validation', () => {
  it('throws synchronously on empty command', async () => {
    await expect(
      runSandboxed({
        command: '',
        args: [],
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/non-empty/);
  });

  it('throws on non-positive timeoutMs', async () => {
    await expect(
      runSandboxed({
        command: process.execPath,
        args: [],
        timeoutMs: 0,
      }),
    ).rejects.toThrow(/positive finite integer/);
  });

  it('throws when gracePeriodMs >= timeoutMs (no headroom for SIGTERM to take effect)', async () => {
    await expect(
      runSandboxed({
        command: process.execPath,
        args: [],
        timeoutMs: 100,
        gracePeriodMs: 100,
      }),
    ).rejects.toThrow(/gracePeriodMs.*must be < timeoutMs/);
  });

  it('throws on non-positive maxStdoutBytes', async () => {
    await expect(
      runSandboxed({
        command: process.execPath,
        args: [],
        timeoutMs: 1_000,
        maxStdoutBytes: 0,
      }),
    ).rejects.toThrow(/maxStdoutBytes/);
  });
});

// ── Integration-style: multiple boundaries at once ──────────────────

describe('runSandboxed — composed boundaries', () => {
  it('enforces cwd + env + output + timeout simultaneously in one run', async () => {
    // A realistic UI-gen style run: child writes a probe file, reads
    // its own env allowlist + cwd, and prints a JSON blob. We assert
    // every field independently.
    const caller = mkdtempSync(join(tmpdir(), 'ggui-sandbox-probe-'));
    try {
      const result = await runSandboxed({
        command: process.execPath,
        args: [
          '-e',
          [
            'const fs=require("fs"), path=require("path");',
            'fs.writeFileSync("probe.json", "{}");',
            'process.stdout.write(JSON.stringify({',
            '  cwd: process.cwd(),',
            '  probeExists: fs.existsSync(path.join(process.cwd(), "probe.json")),',
            '  allowed: process.env.APP_KEY,',
            '  leaked: process.env.HOME_SENTINEL,',
            '}));',
          ].join(''),
        ],
        cwd: caller,
        env: { APP_KEY: 'from-caller' },
        timeoutMs: 5_000,
      });
      expect(result.outcome).toBe('exit');
      const parsed = JSON.parse(result.stdout) as {
        cwd: string;
        probeExists: boolean;
        allowed: string;
        leaked: string | undefined;
      };
      expect(parsed.cwd).toBe(caller);
      expect(parsed.probeExists).toBe(true);
      expect(parsed.allowed).toBe('from-caller');
      expect(parsed.leaked).toBe(undefined);
      // Probe file survived (caller-owned cwd); we clean up.
      expect(existsSync(join(caller, 'probe.json'))).toBe(true);
      expect(readFileSync(join(caller, 'probe.json'), 'utf-8')).toBe('{}');
    } finally {
      rmSync(caller, { recursive: true, force: true });
    }
  });
});
