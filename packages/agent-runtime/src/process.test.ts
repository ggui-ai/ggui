/**
 * Contract tests for the Node subprocess reference adapter.
 *
 * Uses `process.execPath` + `-e` one-liners as the under-test
 * "agent" so the suite is self-contained: no fixture project, no
 * build step, no TypeScript loader. Each scenario pins exactly the
 * lifecycle transition it asserts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeProcessAgentRuntime } from './process.js';
import type { AgentRuntimeEvent, AgentRuntimeHandle, AgentRuntimeStartInput } from './types.js';

const NODE = process.execPath;

const BASE_INPUT: AgentRuntimeStartInput = {
  projectRoot: process.cwd(),
  project: { slug: 'test', name: 'Test', protocol: '1.1' },
};

const tearDown: Array<() => Promise<void>> = [];

afterEach(async () => {
  // Ensure no orphaned child processes leak between tests.
  await Promise.all(tearDown.splice(0).map((fn) => fn().catch(() => undefined)));
});

function trackHandle(handle: AgentRuntimeHandle): AgentRuntimeHandle {
  tearDown.push(() => handle.stop());
  return handle;
}

async function collectEvents(
  handle: AgentRuntimeHandle,
  predicate: (events: AgentRuntimeEvent[]) => boolean,
  timeoutMs = 3_000,
): Promise<AgentRuntimeEvent[]> {
  return new Promise((resolve, reject) => {
    const events: AgentRuntimeEvent[] = [];
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timeout after ${timeoutMs}ms; saw ${events.length} events`));
    }, timeoutMs);
    const unsubscribe = handle.subscribe((e) => {
      events.push(e);
      if (predicate(events)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(events);
      }
    });
  });
}

describe('createNodeProcessAgentRuntime', () => {
  it('rejects missing command at construction time', () => {
    expect(() =>
      createNodeProcessAgentRuntime({ command: '', args: [] }),
    ).toThrow(/command/);
  });

  it('exposes honest capabilities and the declared name', () => {
    const adapter = createNodeProcessAgentRuntime({
      name: 'weather-agent',
      command: NODE,
      args: ['-e', ''],
    });
    expect(adapter.name).toBe('weather-agent');
    expect(adapter.capabilities.observable).toBe(true);
    expect(adapter.capabilities.restartable).toBe(false);
  });

  it('spawns the child and emits status: ready without a readyCheck', async () => {
    // Child keeps stdin open so the process doesn't exit before the
    // test sees `ready`. The `setInterval` is unref'd with a finite
    // counter so the process eventually self-exits if the test
    // forgets to stop it (safety net, not relied on by assertions).
    const adapter = createNodeProcessAgentRuntime({
      command: NODE,
      args: ['-e', 'setInterval(() => {}, 1000);'],
    });
    const handle = trackHandle(await adapter.start(BASE_INPUT));

    const seen = await collectEvents(handle, (events) =>
      events.some((e) => e.type === 'status' && e.status === 'ready'),
    );
    const ready = seen.find((e) => e.type === 'status' && e.status === 'ready');
    expect(ready).toBeDefined();
    expect(handle.status).toBe('ready');
  });

  it('emits stdout / stderr as per-line log events', async () => {
    const adapter = createNodeProcessAgentRuntime({
      command: NODE,
      args: [
        '-e',
        'console.log("hello-out");console.error("hello-err");setInterval(()=>{},1000);',
      ],
    });
    const handle = trackHandle(await adapter.start(BASE_INPUT));

    const seen = await collectEvents(handle, (events) => {
      const outs = events.filter(
        (e) => e.type === 'log' && e.stream === 'stdout' && e.line === 'hello-out',
      );
      const errs = events.filter(
        (e) => e.type === 'log' && e.stream === 'stderr' && e.line === 'hello-err',
      );
      return outs.length > 0 && errs.length > 0;
    });

    expect(seen.some((e) => e.type === 'log' && e.line === 'hello-out')).toBe(true);
    expect(seen.some((e) => e.type === 'log' && e.line === 'hello-err')).toBe(true);
  });

  it('stop() transitions to stopped and the child exits', async () => {
    const adapter = createNodeProcessAgentRuntime({
      command: NODE,
      args: ['-e', 'setInterval(() => {}, 1000);'],
      shutdownTimeoutMs: 500,
    });
    const handle = await adapter.start(BASE_INPUT);

    await collectEvents(handle, (events) =>
      events.some((e) => e.type === 'status' && e.status === 'ready'),
    );

    const stopPromise = collectEvents(handle, (events) =>
      events.some((e) => e.type === 'status' && e.status === 'stopped'),
    );
    await handle.stop();
    await stopPromise;
    expect(handle.status).toBe('stopped');
  });

  it('maps unexpected non-zero exit to status: crashed', async () => {
    const adapter = createNodeProcessAgentRuntime({
      command: NODE,
      args: ['-e', 'process.exit(7);'],
    });
    const handle = trackHandle(await adapter.start(BASE_INPUT));

    const seen = await collectEvents(handle, (events) =>
      events.some((e) => e.type === 'status' && e.status === 'crashed'),
    );
    const crashStatus = seen.find(
      (e) => e.type === 'status' && e.status === 'crashed',
    );
    const errorEvent = seen.find((e) => e.type === 'error');
    expect(crashStatus).toBeDefined();
    expect(errorEvent).toBeDefined();
    if (errorEvent && errorEvent.type === 'error') {
      expect(errorEvent.message).toContain('7');
    }
    expect(handle.status).toBe('crashed');
  });

  it('zero-exit self-shutdown maps to stopped, not crashed', async () => {
    const adapter = createNodeProcessAgentRuntime({
      command: NODE,
      args: ['-e', 'process.exit(0);'],
    });
    const handle = trackHandle(await adapter.start(BASE_INPUT));

    const seen = await collectEvents(handle, (events) =>
      events.some((e) => e.type === 'status' && e.status === 'stopped'),
    );
    expect(seen.some((e) => e.type === 'status' && e.status === 'crashed')).toBe(
      false,
    );
    expect(handle.status).toBe('stopped');
  });

  it('forwards env from startInput to the child, with collision precedence', async () => {
    const adapter = createNodeProcessAgentRuntime({
      command: NODE,
      args: [
        '-e',
        'console.log(JSON.stringify({A:process.env.FROM_OPTIONS,B:process.env.FROM_INPUT}));setInterval(()=>{},1000);',
      ],
      env: { FROM_OPTIONS: 'opt', FROM_INPUT: 'should-be-overridden' },
    });
    const handle = trackHandle(
      await adapter.start({
        ...BASE_INPUT,
        env: { FROM_INPUT: 'input' },
      }),
    );

    const seen = await collectEvents(handle, (events) =>
      events.some(
        (e) => e.type === 'log' && e.stream === 'stdout' && e.line.startsWith('{'),
      ),
    );
    const jsonLine = seen.find(
      (e) => e.type === 'log' && e.stream === 'stdout' && e.line.startsWith('{'),
    );
    if (!jsonLine || jsonLine.type !== 'log') throw new Error('json line missing');
    const parsed = JSON.parse(jsonLine.line) as { A: string; B: string };
    expect(parsed.A).toBe('opt');
    expect(parsed.B).toBe('input');
  });

  it('abort signal triggers stop()', async () => {
    const controller = new AbortController();
    const adapter = createNodeProcessAgentRuntime({
      command: NODE,
      args: ['-e', 'setInterval(() => {}, 1000);'],
      shutdownTimeoutMs: 500,
    });
    const handle = trackHandle(
      await adapter.start({ ...BASE_INPUT, signal: controller.signal }),
    );

    await collectEvents(handle, (events) =>
      events.some((e) => e.type === 'status' && e.status === 'ready'),
    );
    const stopPromise = collectEvents(handle, (events) =>
      events.some((e) => e.type === 'status' && e.status === 'stopped'),
    );
    controller.abort();
    await stopPromise;
    expect(handle.status).toBe('stopped');
  });

  it('listener errors do not break fanout to other listeners', async () => {
    const adapter = createNodeProcessAgentRuntime({
      command: NODE,
      args: ['-e', 'console.log("line");setInterval(()=>{},1000);'],
    });
    const handle = trackHandle(await adapter.start(BASE_INPUT));

    const seen: string[] = [];
    handle.subscribe(() => {
      throw new Error('listener A is broken');
    });
    handle.subscribe((e) => {
      if (e.type === 'log' && e.stream === 'stdout') seen.push(e.line);
    });

    await new Promise((r) => setTimeout(r, 400));
    expect(seen).toContain('line');
  });

  it('httpReadyCheck holds starting → ready until probe succeeds', async () => {
    // Spin up a tiny Node HTTP server in the child that binds on a
    // chosen port after a short delay. The adapter's readyCheck should
    // poll, fail initially, then see 200 and emit `ready`.
    const port = 19781 + Math.floor(Math.random() * 100);
    const script = `
      setTimeout(() => {
        require('node:http').createServer((_req, res) => {
          res.writeHead(200); res.end('ok');
        }).listen(${port});
      }, 200);
      setInterval(() => {}, 1000);
    `;
    const adapter = createNodeProcessAgentRuntime({
      command: NODE,
      args: ['-e', script],
      readyCheck: { type: 'http', port, path: '/', intervalMs: 50, timeoutMs: 5_000 },
    });
    const handle = trackHandle(await adapter.start(BASE_INPUT));

    // Before the probe succeeds, the handle MUST be `starting`.
    expect(handle.status).toBe('starting');

    const seen = await collectEvents(
      handle,
      (events) => events.some((e) => e.type === 'status' && e.status === 'ready'),
      5_000,
    );
    expect(seen.some((e) => e.type === 'status' && e.status === 'ready')).toBe(true);
    expect(handle.status).toBe('ready');
  });
});
