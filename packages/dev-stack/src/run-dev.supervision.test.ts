/**
 * Supervision hook — tests that `runDev` correctly wires an
 * {@link AgentRuntimeAdapter} into the dev-server lifetime.
 *
 * Uses the in-memory stub adapter from `@ggui-ai/agent-runtime` as
 * the oracle. No subprocesses, no framework assumptions — the
 * supervision hook is framework-neutral on both ends.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStubAgentRuntime } from '@ggui-ai/agent-runtime';
import { runDev } from './run-dev.js';

const PROJECT_JSON = JSON.stringify({
  schema: '1',
  protocol: '1.1',
  app: { slug: 'weather', name: 'Weather Bot' },
});

describe('runDev — agent runtime supervision', () => {
  let tmp: string;
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ggui-runtime-supervision-'));
    writeFileSync(join(tmp, 'ggui.json'), PROJECT_JSON);
    lines.length = 0;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('starts the supplied runtime after the HTTP server is listening', async () => {
    const { adapter, controller } = createStubAgentRuntime({ name: 'stub-agent' });

    const bootstrap = await runDev({
      cwd: tmp,
      log,
      serve: true,
      port: 0,
      runtime: adapter,
    });

    try {
      expect(bootstrap.server).not.toBeNull();
      expect(bootstrap.runtime).not.toBeNull();
      expect(bootstrap.runtime?.runId).toBe('stub-run-1');

      // Adapter saw the right project identity from ggui.json.
      const inputs = controller.lastInput();
      expect(inputs?.project.slug).toBe('weather');
      expect(inputs?.project.name).toBe('Weather Bot');
      expect(inputs?.project.protocol).toBe('1.1');
      expect(inputs?.projectRoot).toBe(tmp);

      expect(lines.join('\n')).toContain('runtime: stub-agent (stub-run-1)');
    } finally {
      await bootstrap.server?.close();
    }
  });

  it('server.close() stops the runtime before closing the socket', async () => {
    const { adapter } = createStubAgentRuntime({ name: 'stub-agent' });

    const bootstrap = await runDev({
      cwd: tmp,
      log,
      serve: true,
      port: 0,
      runtime: adapter,
    });

    expect(bootstrap.runtime?.status).toBe('starting');
    await bootstrap.server?.close();

    // After close, the stub handle's status has transitioned to
    // `stopped` — the supervision hook orchestrated the teardown.
    expect(bootstrap.runtime?.status).toBe('stopped');
  });

  it('returns runtime: null when no adapter is supplied', async () => {
    const bootstrap = await runDev({ cwd: tmp, log, serve: true, port: 0 });
    try {
      expect(bootstrap.runtime).toBeNull();
    } finally {
      await bootstrap.server?.close();
    }
  });

  it('surfaces a failed start without tearing the HTTP server down', async () => {
    const { adapter, controller } = createStubAgentRuntime({ name: 'stub-agent' });
    controller.failNextStart(new Error('agent crash on boot'));

    const bootstrap = await runDev({
      cwd: tmp,
      log,
      serve: true,
      port: 0,
      runtime: adapter,
    });

    try {
      // Server is still up so the developer can read diagnostics.
      expect(bootstrap.server).not.toBeNull();
      // Runtime is null because the adapter failed to produce a handle.
      expect(bootstrap.runtime).toBeNull();
      expect(lines.join('\n')).toContain('runtime: failed to start — agent crash on boot');
    } finally {
      await bootstrap.server?.close();
    }
  });

  it('does not call runtime.start when serve: false', async () => {
    const { adapter, controller } = createStubAgentRuntime({ name: 'stub-agent' });

    const bootstrap = await runDev({
      cwd: tmp,
      log,
      serve: false,
      runtime: adapter,
    });

    expect(bootstrap.server).toBeNull();
    expect(bootstrap.runtime).toBeNull();
    expect(bootstrap.runtimeSupervisor).toBeNull();
    expect(controller.lastInput()).toBeNull();
  });

  it('attaches a RuntimeSupervisor whose snapshot reflects status + events', async () => {
    const { adapter, controller } = createStubAgentRuntime({ name: 'stub-agent' });

    const bootstrap = await runDev({
      cwd: tmp,
      log,
      serve: true,
      port: 0,
      runtime: adapter,
    });

    try {
      expect(bootstrap.runtimeSupervisor).not.toBeNull();
      const supervisor = bootstrap.runtimeSupervisor!;

      // Emit a couple of events through the adapter's controller.
      controller.emitLog('stderr', 'starting weather bot');
      controller.emitStatus('ready');
      controller.emitLog('stdout', 'listening on 7001');

      const snapshot = supervisor.snapshot();
      expect(snapshot.present).toBe(true);
      expect(snapshot.name).toBe('stub-agent');
      expect(snapshot.runId).toBe('stub-run-1');
      expect(snapshot.status).toBe('ready');
      expect(snapshot.recentEvents.length).toBeGreaterThanOrEqual(3);
      expect(snapshot.recentEvents.at(-1)).toMatchObject({
        type: 'log',
        stream: 'stdout',
        line: 'listening on 7001',
      });
      // sequence numbers are monotonically increasing.
      const seqs = snapshot.recentEvents.map((e) => e.sequence);
      for (let i = 1; i < seqs.length; i++) {
        expect(seqs[i]).toBeGreaterThan(seqs[i - 1] ?? 0);
      }
    } finally {
      await bootstrap.server?.close();
    }
  });

  it('forwards runtime events into the log stream with a [runtime ...] prefix', async () => {
    const { adapter, controller } = createStubAgentRuntime({ name: 'stub-agent' });

    const bootstrap = await runDev({
      cwd: tmp,
      log,
      serve: true,
      port: 0,
      runtime: adapter,
    });

    try {
      controller.emitStatus('ready');
      controller.emitLog('stderr', 'compiler warning');
      controller.emitError('recoverable glitch');

      const joined = lines.join('\n');
      expect(joined).toContain('[runtime status] ready');
      expect(joined).toContain('[runtime stderr] compiler warning');
      expect(joined).toContain('[runtime error]  recoverable glitch');
    } finally {
      await bootstrap.server?.close();
    }
  });

  it('forwards runtimePort to the runtime adapter as portHint + env.PORT', async () => {
    const { adapter, controller } = createStubAgentRuntime({ name: 'stub-agent' });

    const bootstrap = await runDev({
      cwd: tmp,
      log,
      serve: true,
      port: 0,
      runtime: adapter,
      runtimePort: 6781,
    });

    try {
      const input = controller.lastInput();
      expect(input).not.toBeNull();
      expect(input?.portHint).toBe(6781);
      expect(input?.env).toEqual({ PORT: '6781' });
      // Bootstrap echoes the requested port so the CLI can forward
      // it to a tunnel provider without re-reading options.
      expect(bootstrap.runtimePort).toBe(6781);
    } finally {
      await bootstrap.server?.close();
    }
  });

  it('omits portHint + env.PORT when runtimePort is not set (current behaviour preserved)', async () => {
    const { adapter, controller } = createStubAgentRuntime({ name: 'stub-agent' });

    const bootstrap = await runDev({
      cwd: tmp,
      log,
      serve: true,
      port: 0,
      runtime: adapter,
    });

    try {
      const input = controller.lastInput();
      expect(input?.portHint).toBeUndefined();
      expect(input?.env).toBeUndefined();
      expect(bootstrap.runtimePort).toBeNull();
    } finally {
      await bootstrap.server?.close();
    }
  });

  it('runtimePort on the bootstrap is null when no runtime was supplied', async () => {
    const bootstrap = await runDev({
      cwd: tmp,
      log,
      serve: true,
      port: 0,
      runtimePort: 6781,
    });
    try {
      expect(bootstrap.runtime).toBeNull();
      // `runtimePort` was supplied but there's no runtime to apply it
      // to — bootstrap reports null so the CLI doesn't forward a port
      // that was never actually bound.
      expect(bootstrap.runtimePort).toBeNull();
    } finally {
      await bootstrap.server?.close();
    }
  });

  it('supervisor detaches on server.close() so late events do not leak', async () => {
    const { adapter, controller } = createStubAgentRuntime({ name: 'stub-agent' });

    const bootstrap = await runDev({
      cwd: tmp,
      log,
      serve: true,
      port: 0,
      runtime: adapter,
    });

    await bootstrap.server?.close();
    // Buffer snapshot should now be frozen against new emits.
    const before = bootstrap.runtimeSupervisor!.snapshot().recentEvents.length;
    controller.emitLog('stderr', 'late emit after close');
    const after = bootstrap.runtimeSupervisor!.snapshot().recentEvents.length;
    expect(after).toBe(before);
    // And the log stream didn't pick up the late emit either.
    expect(lines.join('\n')).not.toContain('late emit after close');
  });
});
