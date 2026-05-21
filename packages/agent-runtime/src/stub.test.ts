/**
 * Contract tests for the adapter seam — the stub is both the
 * reference implementation and the oracle we measure other adapters
 * against. Every assertion here is a statement about what any
 * conforming adapter MUST guarantee.
 */
import { describe, expect, it } from 'vitest';
import { createStubAgentRuntime } from './stub.js';
import type {
  AgentRuntimeEvent,
  AgentRuntimeStartInput,
} from './types.js';

const BASE_INPUT: AgentRuntimeStartInput = {
  projectRoot: '/tmp/fake-project',
  project: { slug: 'weather', name: 'Weather Bot', protocol: '1.1' },
};

describe('AgentRuntimeAdapter (stub reference)', () => {
  it('exposes a stable name and honest capability probe', () => {
    const { adapter } = createStubAgentRuntime({ name: 'weather-stub' });
    expect(adapter.name).toBe('weather-stub');
    expect(adapter.capabilities.observable).toBe(true);
    expect(adapter.capabilities.restartable).toBe(false);
  });

  it('start() resolves with a handle whose runId is unique per call', async () => {
    const { adapter } = createStubAgentRuntime();
    const a = await adapter.start(BASE_INPUT);
    const b = await adapter.start(BASE_INPUT);
    expect(a.runId).not.toEqual(b.runId);
  });

  it('auto-emits status: ready after start() (default mode)', async () => {
    const { adapter } = createStubAgentRuntime();
    const events: AgentRuntimeEvent[] = [];
    const handle = await adapter.start(BASE_INPUT);
    handle.subscribe((e) => events.push(e));
    // Ready is emitted on a macrotask so subscribers attached after
    // `await start()` still catch it. Flush the timer queue.
    await new Promise((r) => setTimeout(r, 5));
    expect(events.some((e) => e.type === 'status' && e.status === 'ready')).toBe(
      true,
    );
    expect(handle.status).toBe('ready');
  });

  it('manualReady skips auto-emit so tests can drive the transition', async () => {
    const { adapter, controller } = createStubAgentRuntime({ manualReady: true });
    const events: AgentRuntimeEvent[] = [];
    const handle = await adapter.start(BASE_INPUT);
    handle.subscribe((e) => events.push(e));
    await Promise.resolve();
    expect(handle.status).toBe('starting');
    controller.emitStatus('ready');
    expect(handle.status).toBe('ready');
    expect(events.filter((e) => e.type === 'status')).toHaveLength(1);
  });

  it('stop() transitions to stopped and is idempotent', async () => {
    const { adapter } = createStubAgentRuntime();
    const handle = await adapter.start(BASE_INPUT);
    const events: AgentRuntimeEvent[] = [];
    handle.subscribe((e) => events.push(e));
    await handle.stop();
    await handle.stop();
    const stops = events.filter(
      (e) => e.type === 'status' && e.status === 'stopped',
    );
    expect(stops).toHaveLength(1);
    expect(handle.status).toBe('stopped');
  });

  it('start() throws when the adapter is primed to fail (and handle is not created)', async () => {
    const { adapter, controller } = createStubAgentRuntime();
    controller.failNextStart(new Error('boot failure'));
    await expect(adapter.start(BASE_INPUT)).rejects.toThrow('boot failure');
    // A failed start MUST NOT leave a dangling handle in the
    // controller — subsequent starts begin from a clean slate.
    const succeeded = await adapter.start(BASE_INPUT);
    expect(succeeded.runId).toBe('stub-run-1');
    expect(controller.handles()).toHaveLength(1);
  });

  it('subscribers see log and error events in order of emission', async () => {
    const { adapter, controller } = createStubAgentRuntime();
    const events: AgentRuntimeEvent[] = [];
    const handle = await adapter.start(BASE_INPUT);
    handle.subscribe((e) => events.push(e));
    await Promise.resolve();

    controller.emitLog('stderr', 'compiler warning');
    controller.emitError('recoverable glitch');
    controller.emitLog('stdout', 'agent ready');

    const relevant = events.filter((e) => e.type !== 'status');
    expect(relevant).toEqual([
      expect.objectContaining({ type: 'log', stream: 'stderr', line: 'compiler warning' }),
      expect.objectContaining({ type: 'error', message: 'recoverable glitch' }),
      expect.objectContaining({ type: 'log', stream: 'stdout', line: 'agent ready' }),
    ]);
  });

  it('unsubscribe stops future events from reaching the listener', async () => {
    const { adapter, controller } = createStubAgentRuntime();
    const handle = await adapter.start(BASE_INPUT);
    const events: AgentRuntimeEvent[] = [];
    const unsubscribe = handle.subscribe((e) => events.push(e));
    await Promise.resolve();
    const seenAfterReady = events.length;
    unsubscribe();
    controller.emitLog('stderr', 'after unsubscribe');
    expect(events.length).toBe(seenAfterReady);
  });

  it('a throwing listener does not break fanout to other listeners', async () => {
    const { adapter, controller } = createStubAgentRuntime();
    const handle = await adapter.start(BASE_INPUT);
    const seen: string[] = [];
    handle.subscribe(() => {
      throw new Error('listener is broken');
    });
    handle.subscribe((e) => {
      if (e.type === 'log') seen.push(e.line);
    });
    await Promise.resolve();
    controller.emitLog('stderr', 'line A');
    controller.emitLog('stderr', 'line B');
    expect(seen).toEqual(['line A', 'line B']);
  });

  it('abort signal triggers stop() on the returned handle', async () => {
    const { adapter } = createStubAgentRuntime();
    const controller = new AbortController();
    const handle = await adapter.start({ ...BASE_INPUT, signal: controller.signal });
    const statuses: string[] = [];
    handle.subscribe((e) => {
      if (e.type === 'status') statuses.push(e.status);
    });
    controller.abort();
    // Abort is dispatched on a microtask; wait for it.
    await Promise.resolve();
    await Promise.resolve();
    expect(handle.status).toBe('stopped');
    expect(statuses).toContain('stopped');
  });

  it('already-aborted signal yields a stopped handle after microtasks flush', async () => {
    const { adapter } = createStubAgentRuntime();
    const controller = new AbortController();
    controller.abort();
    const handle = await adapter.start({ ...BASE_INPUT, signal: controller.signal });
    await Promise.resolve();
    await Promise.resolve();
    expect(handle.status).toBe('stopped');
  });

  it('controller.lastInput() echoes the most recent start() inputs', async () => {
    const { adapter, controller } = createStubAgentRuntime();
    expect(controller.lastInput()).toBeNull();
    await adapter.start({
      ...BASE_INPUT,
      entry: './src/agent.ts',
      env: { FOO: 'bar' },
      portHint: 7000,
    });
    const last = controller.lastInput();
    expect(last?.entry).toBe('./src/agent.ts');
    expect(last?.env?.FOO).toBe('bar');
    expect(last?.portHint).toBe(7000);
  });
});
