/**
 * Tests for the pure bits of `ggui serve`. Flag parsing, banner
 * rendering, and the lifecycle driver (`runServe`) — all exercised
 * without binding a real port. A separate end-to-end smoke test
 * (`serve-command.e2e.test.ts`) covers the real `@ggui-ai/mcp-server`
 * bind + HTTP roundtrip.
 */
import { describe, expect, it } from 'vitest';
import type {
  AgentRuntimeAdapter,
  AgentRuntimeEvent,
  AgentRuntimeHandle,
  AgentRuntimeListener,
} from '@ggui-ai/agent-runtime';
import {
  DEFAULT_SERVE_HOST,
  DEFAULT_SERVE_PORT,
  describeAgentStatus,
  describeServeBanner,
  parseServeFlags,
  runServe,
  SERVE_HELP,
  type AgentStatus,
  type ServeBackend,
} from './serve-command.js';

describe('parseServeFlags --seed-pool', () => {
  it('collects repeated --seed-pool paths into an array', () => {
    const f = parseServeFlags(['--seed-pool', './a', '--seed-pool', './b']);
    expect(f.error).toBeUndefined();
    expect(f.seedPools).toEqual(['./a', './b']);
  });
  it('defaults seedPools to an empty array', () => {
    expect(parseServeFlags([]).seedPools).toEqual([]);
  });
  it('errors when --seed-pool has no value', () => {
    expect(parseServeFlags(['--seed-pool']).error).toBe(
      '--seed-pool requires a path',
    );
  });
});

describe('parseServeFlags', () => {
  it('uses defaults when no flags are supplied', () => {
    // `publicBaseUrl` is intentionally absent on the default object —
    // it's optional and only meaningful when explicitly set.
    expect(parseServeFlags([])).toEqual({
      port: DEFAULT_SERVE_PORT,
      host: DEFAULT_SERVE_HOST,
      mcpOnly: false,
      devAllowAll: false,
      publicDemo: false,
      multiTenant: false,
      oauth: false,
      seedPools: [],
    });
  });

  it('parses --oauth', () => {
    expect(parseServeFlags(['--oauth']).oauth).toBe(true);
    expect(parseServeFlags([]).oauth).toBe(false);
  });

  it('parses --dev-allow-all', () => {
    expect(parseServeFlags(['--dev-allow-all']).devAllowAll).toBe(true);
    expect(parseServeFlags([]).devAllowAll).toBe(false);
  });

  it('parses --public-demo', () => {
    expect(parseServeFlags(['--public-demo']).publicDemo).toBe(true);
    expect(parseServeFlags([]).publicDemo).toBe(false);
  });

  it('parses --multi-tenant', () => {
    expect(parseServeFlags(['--multi-tenant']).multiTenant).toBe(true);
    expect(parseServeFlags([]).multiTenant).toBe(false);
  });

  it('parses --ephemeral', () => {
    // Default-off — `ggui serve` without flags persists HMAC secrets +
    // (in later slices) RenderStore / ShortCodeIndex / keysFile under
    // `getPersistentDir(projectRoot)` so cached MCP Apps tokens survive
    // a restart. `--ephemeral` reverts to legacy behavior.
    expect(parseServeFlags(['--ephemeral']).ephemeral).toBe(true);
    expect(parseServeFlags([]).ephemeral).toBeUndefined();
  });

  it('rejects --dev-allow-all + --public-demo combo', () => {
    const result = parseServeFlags(['--dev-allow-all', '--public-demo']);
    expect(result.error).toMatch(/mutually exclusive/);
  });

  it('rejects --multi-tenant + --dev-allow-all combo', () => {
    const result = parseServeFlags(['--multi-tenant', '--dev-allow-all']);
    expect(result.error).toMatch(/incompatible/);
  });

  it('rejects --multi-tenant + --public-demo combo', () => {
    const result = parseServeFlags(['--multi-tenant', '--public-demo']);
    expect(result.error).toMatch(/incompatible/);
  });

  it('parses --public-base-url and strips trailing slashes', () => {
    expect(
      parseServeFlags(['--public-base-url', 'https://example.trycloudflare.com'])
        .publicBaseUrl,
    ).toBe('https://example.trycloudflare.com');
    expect(
      parseServeFlags([
        '--public-base-url',
        'https://example.trycloudflare.com/',
      ]).publicBaseUrl,
    ).toBe('https://example.trycloudflare.com');
    expect(parseServeFlags([]).publicBaseUrl).toBeUndefined();
  });

  it('rejects --public-base-url without a value', () => {
    expect(parseServeFlags(['--public-base-url']).error).toBe(
      '--public-base-url requires a value',
    );
  });

  it('rejects --public-base-url without an http(s) scheme', () => {
    const parsed = parseServeFlags([
      '--public-base-url',
      'ws://localhost:6781',
    ]);
    expect(parsed.error).toContain('http:// or https://');
  });

  it('parses --port', () => {
    expect(parseServeFlags(['--port', '8080']).port).toBe(8080);
    expect(parseServeFlags(['--port', '0']).port).toBe(0);
  });

  it('parses --host', () => {
    expect(parseServeFlags(['--host', '0.0.0.0']).host).toBe('0.0.0.0');
  });

  it('parses --port + --host together', () => {
    const parsed = parseServeFlags(['--host', '::', '--port', '9000']);
    expect(parsed.host).toBe('::');
    expect(parsed.port).toBe(9000);
  });

  it('parses --mcp-only', () => {
    expect(parseServeFlags(['--mcp-only']).mcpOnly).toBe(true);
    expect(parseServeFlags([]).mcpOnly).toBe(false);
  });

  it('rejects --all with a pointer to --mcp-only (§10.2a lock)', () => {
    const parsed = parseServeFlags(['--all']);
    expect(parsed.error).toContain('--all is not a flag');
    expect(parsed.error).toContain('--mcp-only');
  });

  it('rejects --port without a value', () => {
    const parsed = parseServeFlags(['--port']);
    expect(parsed.error).toBe('--port requires a value');
  });

  it('rejects non-integer --port', () => {
    const parsed = parseServeFlags(['--port', 'abc']);
    expect(parsed.error).toContain('--port must be an integer');
  });

  it('rejects negative --port', () => {
    const parsed = parseServeFlags(['--port', '-1']);
    expect(parsed.error).toContain('--port must be an integer');
  });

  it('rejects --port > 65535', () => {
    const parsed = parseServeFlags(['--port', '65536']);
    expect(parsed.error).toContain('--port must be an integer');
  });

  it('rejects --host without a value', () => {
    expect(parseServeFlags(['--host']).error).toBe('--host requires a value');
    expect(parseServeFlags(['--host', '']).error).toBe(
      '--host requires a value',
    );
  });

  it('surfaces --help / -h via the `__help__` sentinel', () => {
    expect(parseServeFlags(['--help']).error).toBe('__help__');
    expect(parseServeFlags(['-h']).error).toBe('__help__');
  });

  it('rejects unknown options by echoing the offender', () => {
    const parsed = parseServeFlags(['--weird-flag']);
    expect(parsed.error).toContain('--weird-flag');
  });
});

describe('describeServeBanner', () => {
  const AGENT_RUNNING: AgentStatus = {
    kind: 'running',
    entry: './agent.ts',
    language: 'ts',
  };

  it('surfaces URL, tool count, strict-auth caveat, and shutdown hint', () => {
    const lines = describeServeBanner({
      port: 6781,
      host: '127.0.0.1',
      toolCount: 3,
      serverName: 'ggui-mcp-server',
      serverVersion: '1.2.3',
      agent: AGENT_RUNNING,
    });
    const joined = lines.join('\n');
    expect(joined).toContain('ggui-mcp-server v1.2.3');
    // Landing-page URL is the operator-facing entrypoint — the banner
    // MUST advertise it so the first-run story ("open a browser at
    // this URL") closes. Regression signal: if this line disappears
    // the user has nowhere visible to go first.
    expect(joined).toContain('open      →  http://127.0.0.1:6781/');
    expect(joined).toContain('http://127.0.0.1:6781/mcp');
    expect(joined).toContain('http://127.0.0.1:6781/ggui/health');
    expect(joined).toContain('3 registered');
    // Auth caveat now reflects strict-auth + the `POST /pair` story;
    // the old `DEV MODE` wording is gone. Regression signal: if this
    // phrasing drifts without the banner copy being intentionally
    // rewritten, /mcp may have silently re-entered devAllowAll.
    expect(joined).toContain('strict');
    expect(joined).toContain('pair-minted');
    expect(joined).toContain('Ctrl-C');
  });

  it('replaces the strict-auth blurb with a DEV ALLOW-ALL warning when devAllowAll', () => {
    const lines = describeServeBanner({
      port: 6781,
      host: '127.0.0.1',
      toolCount: 3,
      serverName: 'ggui-mcp-server',
      serverVersion: '1.2.3',
      agent: AGENT_RUNNING,
      devAllowAll: true,
      // Pair code under devAllowAll is meaningless — banner should
      // suppress it (verified below by absence).
      pairCode: 'IGNORED',
      pairCodeExpiresAt: 0,
    });
    const joined = lines.join('\n');
    expect(joined).toContain('DEV ALLOW-ALL');
    expect(joined).toContain('every bearer authenticates as builder');
    // The strict-auth blurb's distinctive phrase MUST be gone — it
    // would mislead operators about the actual auth posture.
    expect(joined).not.toContain('pair-minted');
    expect(joined).not.toContain('IGNORED');
  });

  it('advertises OAuth discovery in the auth section under --oauth', () => {
    const lines = describeServeBanner({
      port: 6781,
      host: '127.0.0.1',
      toolCount: 3,
      serverName: 'ggui-mcp-server',
      serverVersion: '1.2.3',
      agent: AGENT_RUNNING,
      oauth: true,
    });
    const joined = lines.join('\n');
    // The OAuth blurb names the discovery endpoints + tells the
    // operator where to paste the bearer. Both load-bearing — drift
    // would silently leave operators wondering why claude.ai's
    // connector form fails.
    expect(joined).toContain('oauth: enabled');
    expect(joined).toContain('/.well-known/oauth-');
    expect(joined).toContain('paired bearer');
  });

  it('omits the OAuth blurb when --oauth is absent', () => {
    const lines = describeServeBanner({
      port: 6781,
      host: '127.0.0.1',
      toolCount: 3,
      serverName: 'ggui-mcp-server',
      serverVersion: '1.2.3',
      agent: AGENT_RUNNING,
    });
    expect(lines.join('\n')).not.toContain('oauth:');
  });

  it('renders a public URL line under --public-base-url', () => {
    const lines = describeServeBanner({
      port: 6781,
      host: '127.0.0.1',
      toolCount: 3,
      serverName: 'ggui-mcp-server',
      serverVersion: '1.2.3',
      agent: AGENT_RUNNING,
      publicBaseUrl: 'https://example.trycloudflare.com',
    });
    const joined = lines.join('\n');
    expect(joined).toContain('public');
    expect(joined).toContain('https://example.trycloudflare.com/');
  });

  it('renders the actual bound port even when it differs from requested', () => {
    // Simulates `--port 0` resolving to an OS-chosen port.
    const lines = describeServeBanner({
      port: 41405,
      host: '127.0.0.1',
      toolCount: 3,
      serverName: 'x',
      serverVersion: '0.0.0',
      agent: AGENT_RUNNING,
    });
    expect(lines.join('\n')).toContain(':41405/mcp');
  });

  it('renders the pre-minted pair code when the backend supplied one', () => {
    // The CLI threads `pairingService.initPairing()`'s code through
    // `pairCode` — banner shows it so operators see what to enter in
    // the Portal without switching to the landing page.
    const lines = describeServeBanner({
      port: 6781,
      host: '127.0.0.1',
      toolCount: 3,
      serverName: 'ggui-mcp-server',
      serverVersion: '1.2.3',
      agent: AGENT_RUNNING,
      pairCode: '123456',
      pairCodeExpiresAt: Date.now() + 10 * 60 * 1000,
    });
    expect(lines.join('\n')).toContain('pair code →  123456');
  });

  it('omits the pair-code line when the backend had no pairing wired', () => {
    // Embedding hosts opting out of pairing pass no `pairCode` — the
    // banner must stay quiet instead of printing a blank line.
    const lines = describeServeBanner({
      port: 6781,
      host: '127.0.0.1',
      toolCount: 3,
      serverName: 'ggui-mcp-server',
      serverVersion: '1.2.3',
      agent: AGENT_RUNNING,
    });
    expect(lines.join('\n')).not.toMatch(/pair code/);
  });
});

describe('SERVE_HELP', () => {
  it('documents the default port + host + strict-auth caveat', () => {
    expect(SERVE_HELP).toContain(`default: ${DEFAULT_SERVE_PORT}`);
    expect(SERVE_HELP).toContain(`default: ${DEFAULT_SERVE_HOST}`);
    // Old wording: `Dev-mode auth`. New wording documents the
    // strict-auth + pair-code flow. Regression signal: if this
    // assertion fails without the SERVE_HELP copy being intentionally
    // rewritten, the CLI may have silently reverted to devAllowAll.
    expect(SERVE_HELP).toContain('Strict-auth only');
    expect(SERVE_HELP).toContain('PAIR_CODE');
  });

  it('documents --mcp-only + ggui.json/agent.entry wiring', () => {
    expect(SERVE_HELP).toContain('--mcp-only');
    expect(SERVE_HELP).toContain('agent.entry');
    expect(SERVE_HELP).toContain('ggui.json');
  });
});

describe('describeAgentStatus', () => {
  it('running + ts → shows entry + tsx runner', () => {
    expect(
      describeAgentStatus({
        kind: 'running',
        entry: './agent.ts',
        language: 'ts',
      }),
    ).toBe('./agent.ts (node --import=tsx) — running');
  });

  it('running + js → shows entry + plain node runner', () => {
    expect(
      describeAgentStatus({
        kind: 'running',
        entry: './agent.js',
        language: 'js',
      }),
    ).toBe('./agent.js (node) — running');
  });

  it('disabled reasons surface in a human-friendly form', () => {
    expect(
      describeAgentStatus({ kind: 'disabled', reason: '--mcp-only' }),
    ).toBe('disabled (--mcp-only)');
    expect(
      describeAgentStatus({ kind: 'disabled', reason: 'no ggui.json' }),
    ).toBe('disabled (no ggui.json)');
    expect(
      describeAgentStatus({
        kind: 'disabled',
        reason: 'ggui.json has no agent.entry',
      }),
    ).toBe('disabled (ggui.json has no agent.entry)');
  });
});

describe('runServe', () => {
  /** Matches the `--mcp-only` disabled status — the simplest shape
   *  for tests that don't exercise agent supervision. */
  const AGENT_DISABLED: AgentStatus = {
    kind: 'disabled',
    reason: '--mcp-only',
  };

  /** Default flags for the existing lifecycle tests. */
  const DEFAULT_FLAGS = {
    port: 6781,
    host: '127.0.0.1',
    mcpOnly: true,
  };

  /**
   * Build a fake backend that records listen + close calls. `listen`
   * resolves synchronously so the test runner doesn't wait on real
   * I/O.
   */
  function makeFake(opts: {
    boundPort?: number;
    serverName?: string;
    serverVersion?: string;
    toolCount?: number;
    listenThrows?: Error;
  } = {}): {
    backend: ServeBackend;
    calls: { listen: Array<[number, string]>; close: number };
  } {
    const calls = {
      listen: [] as Array<[number, string]>,
      close: 0,
    };
    const backend: ServeBackend = {
      toolCount: opts.toolCount ?? 3,
      serverName: opts.serverName ?? 'ggui-mcp-server',
      serverVersion: opts.serverVersion ?? '0.0.1',
      primitiveCatalogCount: 0,
      themeSource: 'default',
      adapters: [],
      // Null pairing service — exercises the "embedding host opted
      // out" branch. `runServe` MUST NOT emit a PAIR_CODE beacon in
      // this case. Tests that want the pre-mint branch override this
      // field on the returned backend.
      pairingService: null,
      // Null admin token — exercises the "no console" branch (banner
      // skips the admin-token line + ADMIN_TOKEN beacon). Tests that
      // want the printed branch override this field.
      adminToken: null,
      async listen(port, host) {
        calls.listen.push([port, host]);
        if (opts.listenThrows) throw opts.listenThrows;
        return opts.boundPort ?? port;
      },
      async close() {
        calls.close += 1;
      },
    };
    return { backend, calls };
  }

  function makeStdout(): {
    out: { write(chunk: string): void };
    buffer: string[];
  } {
    const buffer: string[] = [];
    return {
      out: {
        write(chunk: string) {
          buffer.push(chunk);
        },
      },
      buffer,
    };
  }

  it('listens, prints the banner, then blocks until abort', async () => {
    const { backend, calls } = makeFake();
    const { out, buffer } = makeStdout();
    const controller = new AbortController();

    const servePromise = runServe({
      flags: DEFAULT_FLAGS,
      backendFactory: () => backend,
      agentStatus: AGENT_DISABLED,
      stdout: out,
      shutdownSignal: controller.signal,
    });

    // Give the microtask queue a tick to let `listen` + banner land.
    await new Promise((resolve) => setImmediate(resolve));

    expect(calls.listen).toEqual([[6781, '127.0.0.1']]);
    expect(buffer.join('')).toContain(':6781/mcp');
    expect(calls.close).toBe(0); // still running

    controller.abort();
    const exitCode = await servePromise;
    expect(exitCode).toBe(0);
    expect(calls.close).toBe(1);
  });

  it('uses the backend-reported bound port in the banner, not the requested port', async () => {
    const { backend } = makeFake({ boundPort: 55555 });
    const { out, buffer } = makeStdout();
    const controller = new AbortController();

    const servePromise = runServe({
      flags: { ...DEFAULT_FLAGS, port: 0 },
      backendFactory: () => backend,
      agentStatus: AGENT_DISABLED,
      stdout: out,
      shutdownSignal: controller.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await servePromise;

    expect(buffer.join('')).toContain(':55555/mcp');
    expect(buffer.join('')).not.toContain(':0/mcp');
  });

  it('closes the backend immediately when the shutdown signal is already aborted', async () => {
    const { backend, calls } = makeFake();
    const controller = new AbortController();
    controller.abort();
    const { out } = makeStdout();

    const exitCode = await runServe({
      flags: DEFAULT_FLAGS,
      backendFactory: () => backend,
      agentStatus: AGENT_DISABLED,
      stdout: out,
      shutdownSignal: controller.signal,
    });

    expect(exitCode).toBe(0);
    expect(calls.close).toBe(1);
  });

  it('propagates listen failures to the caller', async () => {
    const boom = new Error('EADDRINUSE: 127.0.0.1:6781');
    const { backend } = makeFake({ listenThrows: boom });
    const { out } = makeStdout();
    const controller = new AbortController();

    await expect(
      runServe({
        flags: DEFAULT_FLAGS,
        backendFactory: () => backend,
        agentStatus: AGENT_DISABLED,
        stdout: out,
        shutdownSignal: controller.signal,
      }),
    ).rejects.toThrow(/EADDRINUSE/);
  });
});

describe('runServe — agent supervision', () => {
  /** Full-mode flags (not --mcp-only). Agent will be supervised. */
  const FULL_FLAGS = { port: 6781, host: '127.0.0.1', mcpOnly: false };
  const AGENT_RUNNING: AgentStatus = {
    kind: 'running',
    entry: './agent.ts',
    language: 'ts',
  };

  function makeBackend(): {
    backend: ServeBackend;
    calls: { listen: number; close: number };
  } {
    const calls = { listen: 0, close: 0 };
    return {
      backend: {
        toolCount: 3,
        serverName: 'ggui-mcp-server',
        serverVersion: '0.0.1',
        primitiveCatalogCount: 0,
        themeSource: 'default',
        adapters: [],
        // Same rationale as `makeFake` in the sibling describe — null
        // means the fake backend opted out of pairing, so `runServe`
        // takes the "no pre-mint, no PAIR_CODE beacon" branch.
        pairingService: null,
        // Null admin token — exercises the "no console" branch (banner
        // skips the admin-token line + ADMIN_TOKEN beacon).
        adminToken: null,
        async listen(port) {
          calls.listen += 1;
          return port || 55555;
        },
        async close() {
          calls.close += 1;
        },
      },
      calls,
    };
  }

  /**
   * Build a fake AgentRuntimeAdapter that records start/stop order
   * and exposes an emitter so tests can simulate crashes / logs.
   */
  function makeFakeAgent(opts: { startThrows?: Error } = {}): {
    adapter: AgentRuntimeAdapter;
    listeners: AgentRuntimeListener[];
    emit(event: AgentRuntimeEvent): void;
    calls: {
      start: number;
      stop: number;
      order: string[];
    };
  } {
    const calls = { start: 0, stop: 0, order: [] as string[] };
    const listeners: AgentRuntimeListener[] = [];
    const handle: AgentRuntimeHandle = {
      runId: 'fake-run-1',
      status: 'starting',
      subscribe(listener) {
        listeners.push(listener);
        return () => {
          const i = listeners.indexOf(listener);
          if (i !== -1) listeners.splice(i, 1);
        };
      },
      async stop() {
        calls.stop += 1;
        calls.order.push('agent.stop');
      },
    };
    const adapter: AgentRuntimeAdapter = {
      name: 'fake',
      capabilities: { observable: true, restartable: false },
      async start() {
        calls.start += 1;
        calls.order.push('agent.start');
        if (opts.startThrows) throw opts.startThrows;
        return handle;
      },
    };
    return {
      adapter,
      listeners,
      emit(event) {
        for (const listener of [...listeners]) listener(event);
      },
      calls,
    };
  }

  function makeStdout(): { out: { write(chunk: string): void }; buffer: string[] } {
    const buffer: string[] = [];
    return {
      out: { write: (c) => buffer.push(c) },
      buffer,
    };
  }

  it('starts agent AFTER listen + stops agent BEFORE close on shutdown', async () => {
    const { backend, calls: backendCalls } = makeBackend();
    const agent = makeFakeAgent();
    const { out } = makeStdout();
    const controller = new AbortController();

    // Track overall order so we can assert lifecycle.
    const order: string[] = [];
    const instrumentedBackend: ServeBackend = {
      ...backend,
      listen: async (p, h) => {
        order.push('backend.listen');
        return backend.listen(p, h);
      },
      close: async () => {
        order.push('backend.close');
        return backend.close();
      },
    };
    const instrumentedAdapter: AgentRuntimeAdapter = {
      ...agent.adapter,
      start: async (input) => {
        order.push('agent.start');
        return agent.adapter.start(input);
      },
    };

    const servePromise = runServe({
      flags: FULL_FLAGS,
      backendFactory: () => instrumentedBackend,
      agent: {
        adapter: instrumentedAdapter,
        startInput: {
          projectRoot: '/tmp/fake',
          project: { slug: 'fake', name: 'Fake', protocol: '1.1' },
          entry: '/tmp/fake/agent.ts',
        },
      },
      agentStatus: AGENT_RUNNING,
      stdout: out,
      shutdownSignal: controller.signal,
    });

    await new Promise((r) => setImmediate(r));

    // Ordering guarantee: MCP binds first so the agent's first
    // connect always succeeds.
    expect(order).toEqual(['backend.listen', 'agent.start']);
    expect(backendCalls.listen).toBe(1);
    expect(agent.calls.start).toBe(1);

    // Shut down and verify stop order.
    controller.abort();
    await servePromise;

    // Agent stopped BEFORE the MCP server closes (so the agent
    // doesn't make one last call into a torn-down surface).
    expect(agent.calls.order).toEqual(['agent.start', 'agent.stop']);
    expect(order).toEqual([
      'backend.listen',
      'agent.start',
      'backend.close',
    ]);
  });

  it('forwards agent events to onEvent between start and stop', async () => {
    const { backend } = makeBackend();
    const agent = makeFakeAgent();
    const events: AgentRuntimeEvent[] = [];
    const { out } = makeStdout();
    const controller = new AbortController();

    const servePromise = runServe({
      flags: FULL_FLAGS,
      backendFactory: () => backend,
      agent: {
        adapter: agent.adapter,
        startInput: {
          projectRoot: '/tmp/fake',
          project: { slug: 'fake', name: 'Fake', protocol: '1.1' },
          entry: '/tmp/fake/agent.ts',
        },
        onEvent: (e) => events.push(e),
      },
      agentStatus: AGENT_RUNNING,
      stdout: out,
      shutdownSignal: controller.signal,
    });

    await new Promise((r) => setImmediate(r));

    // Simulate a ready → log → crash sequence. The crash is a
    // `status: 'crashed'` event; per the §10.2a policy the serve
    // loop keeps MCP running until shutdown fires.
    agent.emit({ type: 'status', status: 'ready', timestamp: 1 });
    agent.emit({
      type: 'log',
      stream: 'stderr',
      line: 'oops',
      timestamp: 2,
    });
    agent.emit({ type: 'status', status: 'crashed', timestamp: 3 });

    expect(events).toHaveLength(3);
    expect(events[0]?.type).toBe('status');
    expect(events[1]?.type).toBe('log');
    expect(events[2]?.type).toBe('status');
    if (events[2]?.type === 'status') {
      expect(events[2].status).toBe('crashed');
    }

    // MCP is still running — we only close on abort.
    controller.abort();
    await servePromise;
  });

  it('closes the backend + rethrows when agent.start() throws', async () => {
    const { backend, calls: backendCalls } = makeBackend();
    const boom = new Error('spawn ENOENT');
    const agent = makeFakeAgent({ startThrows: boom });
    const { out } = makeStdout();
    const controller = new AbortController();

    await expect(
      runServe({
        flags: FULL_FLAGS,
        backendFactory: () => backend,
        agent: {
          adapter: agent.adapter,
          startInput: {
            projectRoot: '/tmp/fake',
            project: { slug: 'fake', name: 'Fake', protocol: '1.1' },
            entry: '/tmp/fake/agent.ts',
          },
        },
        agentStatus: AGENT_RUNNING,
        stdout: out,
        shutdownSignal: controller.signal,
      }),
    ).rejects.toThrow(/spawn ENOENT/);

    // Server was bound — must be closed so we don't leak a socket.
    expect(backendCalls.listen).toBe(1);
    expect(backendCalls.close).toBe(1);
    // Agent never reached stop — start threw before the handle returned.
    expect(agent.calls.stop).toBe(0);
  });
});
