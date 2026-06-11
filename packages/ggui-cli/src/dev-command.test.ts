/**
 * Unit tests for `ggui dev`'s flag parsing + entry-to-command
 * resolution + hub auto-open helpers. These are the pure bits of
 * the CLI — no subprocess spawn, no HTTP, no dev-stack boot.
 *
 * Auto-open tests use the injectable `spawner` + `env` + `platform`
 * seams so every branch is exercised without touching the real
 * child_process or the real environment.
 */
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_DEV_HOST, DEFAULT_DEV_PORT } from '@ggui-ai/dev-stack';
import {
  describeTunnelSession,
  DEV_HELP,
  launchBrowser,
  openTunnel,
  parseDevFlags,
  resolveAgentCommand,
  resolveHubUrl,
  resolveLaunchCommand,
  shouldAutoOpen,
  type TunnelProvider,
  type TunnelSession,
} from './dev-command.js';

describe('parseDevFlags', () => {
  it('defaults to noServe: false and leaves agent unset', () => {
    const out = parseDevFlags([]);
    expect(out.noServe).toBe(false);
    expect(out.agent).toBeUndefined();
    expect(out.error).toBeUndefined();
  });

  it('defaults tunnel: false', () => {
    // Default path — `ggui dev` alone is local-only. Managed mode
    // is strictly opt-in via `--tunnel`.
    expect(parseDevFlags([]).tunnel).toBe(false);
  });

  it('sets tunnel on --tunnel', () => {
    expect(parseDevFlags(['--tunnel']).tunnel).toBe(true);
  });

  it('combines --tunnel with other flags', () => {
    const out = parseDevFlags(['--tunnel', '--port', '7777']);
    expect(out.tunnel).toBe(true);
    expect(out.port).toBe(7777);
    expect(out.error).toBeUndefined();
  });

  it('sets noServe on --no-serve', () => {
    expect(parseDevFlags(['--no-serve']).noServe).toBe(true);
  });

  it('parses --port as a valid integer', () => {
    expect(parseDevFlags(['--port', '6789']).port).toBe(6789);
    expect(parseDevFlags(['--port', '0']).port).toBe(0);
  });

  it('rejects --port with non-integer or out-of-range value', () => {
    expect(parseDevFlags(['--port', 'abc']).error).toContain('--port');
    expect(parseDevFlags(['--port', '70000']).error).toContain('--port');
    expect(parseDevFlags(['--port']).error).toContain('requires a value');
  });

  it('parses --host', () => {
    expect(parseDevFlags(['--host', '0.0.0.0']).host).toBe('0.0.0.0');
    expect(parseDevFlags(['--host']).error).toContain('requires a value');
  });

  it('parses --agent with a path', () => {
    const out = parseDevFlags(['--agent', 'src/agent.ts']);
    expect(out.agent).toBe('src/agent.ts');
  });

  it('rejects --agent without a value', () => {
    const out = parseDevFlags(['--agent']);
    expect(out.error).toContain('--agent');
  });

  it('rejects unknown flags with a stable message', () => {
    const out = parseDevFlags(['--mystery']);
    expect(out.error).toBe('unknown flag "--mystery"');
  });

  it('surfaces --help / -h via the `__help__` sentinel', () => {
    expect(parseDevFlags(['--help']).error).toBe('__help__');
    expect(parseDevFlags(['-h']).error).toBe('__help__');
  });

  it('accepts compound flag sets', () => {
    const out = parseDevFlags([
      '--port',
      '7000',
      '--host',
      '127.0.0.1',
      '--agent',
      'src/index.ts',
      '--no-serve',
    ]);
    expect(out).toMatchObject({
      port: 7000,
      host: '127.0.0.1',
      agent: 'src/index.ts',
      noServe: true,
    });
    expect(out.error).toBeUndefined();
  });
});

describe('resolveAgentCommand', () => {
  const CWD = '/tmp/fake-project';

  it('rejects an empty entry', () => {
    const out = resolveAgentCommand('', CWD);
    expect(out.ok).toBe(false);
  });

  it('maps .js → node <abs entry>', () => {
    const out = resolveAgentCommand('src/index.js', CWD);
    if (!out.ok) throw new Error(out.error);
    expect(out.command).toBe(process.execPath);
    expect(out.args).toEqual(['/tmp/fake-project/src/index.js']);
    expect(out.language).toBe('js');
  });

  it('maps .mjs → node <abs entry>', () => {
    const out = resolveAgentCommand('src/index.mjs', CWD);
    if (!out.ok) throw new Error(out.error);
    expect(out.args).toEqual(['/tmp/fake-project/src/index.mjs']);
    expect(out.language).toBe('js');
  });

  it('maps .cjs → node <abs entry>', () => {
    const out = resolveAgentCommand('src/index.cjs', CWD);
    if (!out.ok) throw new Error(out.error);
    expect(out.args).toEqual(['/tmp/fake-project/src/index.cjs']);
    expect(out.language).toBe('js');
  });

  it('maps .ts → node --import=tsx <abs entry>', () => {
    const out = resolveAgentCommand('src/agent.ts', CWD);
    if (!out.ok) throw new Error(out.error);
    expect(out.command).toBe(process.execPath);
    expect(out.args).toEqual(['--import=tsx', '/tmp/fake-project/src/agent.ts']);
    expect(out.language).toBe('ts');
  });

  it('maps .tsx → node --import=tsx <abs entry>', () => {
    const out = resolveAgentCommand('src/agent.tsx', CWD);
    if (!out.ok) throw new Error(out.error);
    expect(out.args).toEqual(['--import=tsx', '/tmp/fake-project/src/agent.tsx']);
    expect(out.language).toBe('ts');
  });

  it('maps .mts → node --import=tsx <abs entry>', () => {
    const out = resolveAgentCommand('src/agent.mts', CWD);
    if (!out.ok) throw new Error(out.error);
    expect(out.args).toEqual(['--import=tsx', '/tmp/fake-project/src/agent.mts']);
    expect(out.language).toBe('ts');
  });

  it('absolute paths pass through unchanged', () => {
    const out = resolveAgentCommand('/srv/agent.js', CWD);
    if (!out.ok) throw new Error(out.error);
    expect(out.args).toEqual(['/srv/agent.js']);
  });

  it('rejects unsupported extensions with an actionable message', () => {
    const out = resolveAgentCommand('agent.py', CWD);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected failure');
    expect(out.error).toMatch(/unsupported extension/);
    expect(out.error).toMatch(/\.py/);
  });

  it('rejects files without an extension', () => {
    const out = resolveAgentCommand('bin/agent', CWD);
    expect(out.ok).toBe(false);
  });
});

describe('parseDevFlags — --no-open', () => {
  it('defaults to noOpen: false', () => {
    expect(parseDevFlags([]).noOpen).toBe(false);
  });

  it('sets noOpen on --no-open', () => {
    expect(parseDevFlags(['--no-open']).noOpen).toBe(true);
  });

  it('combines with other flags without interference', () => {
    const out = parseDevFlags(['--port', '7000', '--no-open', '--agent', 'x.ts']);
    expect(out).toMatchObject({
      port: 7000,
      noOpen: true,
      agent: 'x.ts',
    });
    expect(out.error).toBeUndefined();
  });
});

describe('resolveHubUrl', () => {
  it('composes a loopback URL when host is 127.0.0.1', () => {
    expect(resolveHubUrl('127.0.0.1', 6780)).toBe('http://127.0.0.1:6780/hub');
  });

  it('normalises the IPv4 wildcard 0.0.0.0 to 127.0.0.1', () => {
    // Browsers cannot dial 0.0.0.0; the link must be clickable.
    expect(resolveHubUrl('0.0.0.0', 7000)).toBe('http://127.0.0.1:7000/hub');
  });

  it('normalises the IPv6 wildcard :: to 127.0.0.1', () => {
    expect(resolveHubUrl('::', 7001)).toBe('http://127.0.0.1:7001/hub');
  });

  it('normalises an empty host to 127.0.0.1', () => {
    expect(resolveHubUrl('', 7002)).toBe('http://127.0.0.1:7002/hub');
  });

  it('passes a real hostname through untouched', () => {
    expect(resolveHubUrl('localhost', 9000)).toBe('http://localhost:9000/hub');
  });
});

describe('shouldAutoOpen', () => {
  const BASE = { serving: true, noOpen: false, isTty: true, env: {} as Record<string, string | undefined> };

  it('opens in the interactive TTY default case', () => {
    expect(shouldAutoOpen(BASE)).toEqual({
      open: true,
      reason: 'interactive dev session',
    });
  });

  it('--no-open is the highest-priority skip (wins over TTY+env+serving)', () => {
    const result = shouldAutoOpen({ ...BASE, noOpen: true });
    expect(result.open).toBe(false);
    expect(result.reason).toBe('--no-open set');
  });

  it('--no-serve skips even in an interactive TTY', () => {
    const result = shouldAutoOpen({ ...BASE, serving: false });
    expect(result.open).toBe(false);
    expect(result.reason).toBe('--no-serve set');
  });

  it('CI=1 skips and echoes the CI value in the reason', () => {
    const result = shouldAutoOpen({ ...BASE, env: { CI: '1' } });
    expect(result.open).toBe(false);
    expect(result.reason).toBe('CI env detected (CI=1)');
  });

  it('CI=true skips', () => {
    const result = shouldAutoOpen({ ...BASE, env: { CI: 'true' } });
    expect(result.open).toBe(false);
    expect(result.reason).toBe('CI env detected (CI=true)');
  });

  it("CI=false is NOT treated as CI (truthiness honored)", () => {
    expect(shouldAutoOpen({ ...BASE, env: { CI: 'false' } }).open).toBe(true);
    expect(shouldAutoOpen({ ...BASE, env: { CI: '0' } }).open).toBe(true);
    expect(shouldAutoOpen({ ...BASE, env: { CI: '' } }).open).toBe(true);
  });

  it('BROWSER=none opts out explicitly (create-react-app / expo pattern)', () => {
    const result = shouldAutoOpen({ ...BASE, env: { BROWSER: 'none' } });
    expect(result.open).toBe(false);
    expect(result.reason).toBe('BROWSER=none');
  });

  it('BROWSER=<anything-else> does NOT skip — it will be honored by launcher', () => {
    expect(shouldAutoOpen({ ...BASE, env: { BROWSER: 'firefox' } }).open).toBe(true);
  });

  it('non-TTY stdout skips (piped / daemonised)', () => {
    const result = shouldAutoOpen({ ...BASE, isTty: false });
    expect(result.open).toBe(false);
    expect(result.reason).toBe('stdout is not a TTY');
  });

  it('precedence: --no-open wins over CI / BROWSER / TTY', () => {
    const result = shouldAutoOpen({
      serving: true,
      noOpen: true,
      isTty: false,
      env: { CI: '1', BROWSER: 'none' },
    });
    expect(result.reason).toBe('--no-open set');
  });

  it('precedence: --no-serve wins over CI / BROWSER / TTY', () => {
    const result = shouldAutoOpen({
      serving: false,
      noOpen: false,
      isTty: false,
      env: { CI: '1' },
    });
    expect(result.reason).toBe('--no-serve set');
  });
});

describe('resolveLaunchCommand', () => {
  const EMPTY_ENV = {} as Record<string, string | undefined>;

  it('darwin → open <url>', () => {
    expect(resolveLaunchCommand('http://x', 'darwin', EMPTY_ENV)).toEqual({
      command: 'open',
      args: ['http://x'],
    });
  });

  it("win32 → cmd /c start '' <url> (empty title avoids URL-as-title gotcha)", () => {
    expect(resolveLaunchCommand('http://x', 'win32', EMPTY_ENV)).toEqual({
      command: 'cmd',
      args: ['/c', 'start', '', 'http://x'],
    });
  });

  it('linux → xdg-open <url>', () => {
    expect(resolveLaunchCommand('http://x', 'linux', EMPTY_ENV)).toEqual({
      command: 'xdg-open',
      args: ['http://x'],
    });
  });

  it('freebsd (other) → xdg-open <url>', () => {
    expect(resolveLaunchCommand('http://x', 'freebsd', EMPTY_ENV)).toEqual({
      command: 'xdg-open',
      args: ['http://x'],
    });
  });

  it('$BROWSER env overrides the platform default', () => {
    expect(
      resolveLaunchCommand('http://x', 'darwin', { BROWSER: 'firefox' }),
    ).toEqual({ command: 'firefox', args: ['http://x'] });
    expect(
      resolveLaunchCommand('http://x', 'linux', { BROWSER: 'chromium' }),
    ).toEqual({ command: 'chromium', args: ['http://x'] });
  });

  it("BROWSER=none does NOT override — caller checks it upstream via shouldAutoOpen", () => {
    // shouldAutoOpen already short-circuits on BROWSER=none. If a
    // caller somehow passes it through, the launcher MUST fall back
    // to the platform default rather than literally running `none`.
    expect(resolveLaunchCommand('http://x', 'darwin', { BROWSER: 'none' })).toEqual({
      command: 'open',
      args: ['http://x'],
    });
  });
});

describe('launchBrowser', () => {
  function fakeChild(): ChildProcess {
    const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
    return {
      on(event: string, fn: (...a: unknown[]) => void): ChildProcess {
        const arr = listeners.get(event) ?? [];
        arr.push(fn);
        listeners.set(event, arr);
        return this as unknown as ChildProcess;
      },
      unref: () => {
        /* noop */
      },
      _listeners: listeners,
    } as unknown as ChildProcess;
  }

  it('dispatches the platform-resolved command + args to the spawner', () => {
    const calls: Array<{ cmd: string; args: readonly string[]; options: SpawnOptions }> = [];
    const spawner = (cmd: string, args: readonly string[], options: SpawnOptions) => {
      calls.push({ cmd, args, options });
      return fakeChild();
    };
    const result = launchBrowser('http://127.0.0.1:6780/hub', {
      spawner,
      platform: 'darwin',
      env: {},
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe('open');
    expect(calls[0]?.args).toEqual(['http://127.0.0.1:6780/hub']);
    // Lifecycle flags: detached + ignored stdio + windowsHide so
    // the parent CLI is never blocked waiting on the launcher.
    expect(calls[0]?.options).toMatchObject({
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
  });

  it('honors $BROWSER when set in env', () => {
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const spawner = (cmd: string, args: readonly string[]) => {
      calls.push({ cmd, args });
      return fakeChild();
    };
    launchBrowser('http://x/hub', {
      spawner,
      platform: 'linux',
      env: { BROWSER: 'firefox' },
    });
    expect(calls[0]?.cmd).toBe('firefox');
  });

  it('falls back on a synchronous spawn throw with ok:false + the error message', () => {
    const spawner = () => {
      throw new Error('spawn EACCES');
    };
    const result = launchBrowser('http://x/hub', {
      spawner,
      platform: 'linux',
      env: {},
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('spawn EACCES');
  });

  it('attaches an error listener to swallow async ENOENT / permission events', () => {
    let errorListenerInstalled = false;
    const child: ChildProcess = {
      on(event: string) {
        if (event === 'error') errorListenerInstalled = true;
        return this as unknown as ChildProcess;
      },
      unref: vi.fn(),
    } as unknown as ChildProcess;
    const spawner = () => child;
    launchBrowser('http://x/hub', { spawner, platform: 'linux', env: {} });
    expect(errorListenerInstalled).toBe(true);
  });

  it('unref()s the child so the CLI event loop does not wait on it', () => {
    const unref = vi.fn();
    const child = {
      on() {
        return child as unknown as ChildProcess;
      },
      unref,
    } as unknown as ChildProcess;
    const spawner = () => child;
    launchBrowser('http://x', { spawner, platform: 'linux', env: {} });
    expect(unref).toHaveBeenCalledOnce();
  });
});

describe('openTunnel', () => {
  const ctx = {
    localUrl: 'http://127.0.0.1:6780',
    authToken: null,
    project: { slug: 'demo', name: 'Demo' },
    runtimePort: null,
    signal: new AbortController().signal,
  };

  it('returns the provider session unchanged when the shape is valid', async () => {
    const provider: TunnelProvider = {
      name: 'fake',
      async open() {
        return { status: 'unavailable', reason: 'under construction' };
      },
    };
    const session = await openTunnel(provider, ctx);
    expect(session).toEqual({ status: 'unavailable', reason: 'under construction' });
  });

  it('passes ready sessions through untouched', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const provider: TunnelProvider = {
      name: 'fake',
      async open() {
        return { status: 'ready', remoteUrl: 'https://x.example/', close };
      },
    };
    const session = await openTunnel(provider, ctx);
    expect(session.status).toBe('ready');
    if (session.status === 'ready') {
      expect(session.remoteUrl).toBe('https://x.example/');
      await session.close();
      expect(close).toHaveBeenCalledOnce();
    }
  });

  it('collapses a thrown provider error to unavailable (local dev never breaks)', async () => {
    const provider: TunnelProvider = {
      name: 'crash',
      async open() {
        throw new Error('boom');
      },
    };
    const session = await openTunnel(provider, ctx);
    expect(session.status).toBe('unavailable');
    if (session.status === 'unavailable') {
      expect(session.reason).toContain('crash');
      expect(session.reason).toContain('boom');
    }
  });

  it('defends against a malformed provider return', async () => {
    // A provider returning `undefined` or a non-discriminated
    // object would otherwise crash the CLI at `session.status`.
    const badProvider = {
      name: 'bad',
      // deliberately missing `status` on the result.
      open: async () => ({ remoteUrl: 'https://x' }) as unknown as TunnelSession,
    };
    const session = await openTunnel(badProvider, ctx);
    expect(session.status).toBe('unavailable');
    if (session.status === 'unavailable') {
      expect(session.reason).toContain('bad');
      expect(session.reason).toContain('invalid session shape');
    }
  });
});

describe('describeTunnelSession', () => {
  it('prints a single tunnel line for ready sessions', () => {
    const lines = describeTunnelSession({
      status: 'ready',
      remoteUrl: 'https://abc.tunnel.example/',
      async close() {
        /* noop */
      },
    });
    expect(lines).toEqual(['  tunnel  →  https://abc.tunnel.example/']);
  });

  it('prints a tunnel-skipped line for unavailable sessions without a hint', () => {
    const lines = describeTunnelSession({
      status: 'unavailable',
      reason: 'not configured',
    });
    expect(lines).toEqual(['  tunnel skipped: not configured']);
  });

  it('renders the hint on a second indented line when provided', () => {
    // The literal hint string is arbitrary fixture data — this test
    // exercises the FORMATTER (`describeTunnelSession` interpolates
    // whatever hint string the session carries). Use a brand-neutral
    // placeholder so the fixture doesn't pin a specific CLI command.
    const lines = describeTunnelSession({
      status: 'unavailable',
      reason: 'login expired',
      hint: 'run `<your-cli> login`',
    });
    expect(lines).toEqual([
      '  tunnel skipped: login expired',
      '          hint: run `<your-cli> login`',
    ]);
  });
});

describe('DEV_HELP', () => {
  it('documents the default port + host', () => {
    expect(DEV_HELP).toContain(`default: ${DEFAULT_DEV_PORT}`);
    expect(DEV_HELP).toContain(`default: ${DEFAULT_DEV_HOST}`);
  });

  it('documents every real flag', () => {
    for (const flag of [
      '--port',
      '--host',
      '--agent',
      '--no-serve',
      '--no-open',
      '--tunnel',
      '--help',
    ]) {
      expect(DEV_HELP).toContain(flag);
    }
  });
});
