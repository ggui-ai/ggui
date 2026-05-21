/**
 * HTTP tests for the `/runtime/status` + `/runtime/events` snapshot
 * endpoints. Drives the dev server through `startDevServer` with a
 * stub-adapter-backed `RuntimeSupervisor` so assertions cover the
 * real wire shape hosts (CLI, future hub) consume.
 *
 * No subprocess spawn — the stub adapter fakes lifecycle events
 * the supervisor buffers; the tests hit HTTP and assert on the
 * serialized snapshot.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStubAgentRuntime } from '@ggui-ai/agent-runtime';
import type { GguiJsonV1 } from '@ggui-ai/project-config';
import { LocalUiRegistry } from '../local-registry/local-registry.js';
import { startDevServer, type DevServerHandle } from './http.js';
import { RuntimeSupervisor } from '../runtime-supervisor.js';

function makeGgui(): GguiJsonV1 {
  return {
    schema: '1',
    protocol: '1.1',
    app: { slug: 'smoke', name: 'Smoke' },
    blueprints: { include: [] },
    primitives: { packages: ['@ggui-ai/design/primitives'], local: [] },
    adapters: [],
  };
}

describe('dev server /runtime/* endpoints', () => {
  let tmp: string;
  let handle: DevServerHandle | null = null;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ggui-runtime-http-'));
  });

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = null;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  async function boot(opts: {
    supervisor?: RuntimeSupervisor | null;
    getSupervisor?: () => RuntimeSupervisor | null;
  } = {}): Promise<DevServerHandle> {
    const manifest = makeGgui();
    const registry = new LocalUiRegistry({ projectRoot: tmp, manifest });
    const getSupervisor =
      opts.getSupervisor ?? (() => opts.supervisor ?? null);
    const h = await startDevServer({
      registry,
      manifest,
      port: 0,
      getRuntimeSupervisor: getSupervisor,
    });
    handle = h;
    return h;
  }

  function url(h: DevServerHandle, p: string): string {
    return `http://${h.host}:${h.port}${p}`;
  }

  it('returns { present: false } for /runtime/status when no supervisor is wired', async () => {
    const h = await boot();
    const res = await fetch(url(h, '/runtime/status'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ present: false });
  });

  it('returns { present: false } for /runtime/events when no supervisor is wired', async () => {
    const h = await boot();
    const res = await fetch(url(h, '/runtime/events'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ present: false });
  });

  it('treats /runtime as /runtime/status (bare path)', async () => {
    const h = await boot();
    const res = await fetch(url(h, '/runtime'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ present: false });
  });

  it('/runtime/status returns snapshot MINUS recentEvents when supervised', async () => {
    const { adapter, controller } = createStubAgentRuntime({
      name: 'test-agent',
      manualReady: true,
    });
    const agentHandle = await adapter.start({
      projectRoot: tmp,
      project: { slug: 'smoke', name: 'Smoke', protocol: '1.1' },
    });
    const supervisor = new RuntimeSupervisor({ adapter, handle: agentHandle });

    controller.emitStatus('ready');
    controller.emitLog('stderr', 'a');
    controller.emitLog('stdout', 'b');

    const h = await boot({ supervisor });
    const res = await fetch(url(h, '/runtime/status'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      present: true,
      name: 'test-agent',
      runId: 'stub-run-1',
      status: 'ready',
      capabilities: { observable: true, restartable: false },
    });
    expect(typeof body.startedAt).toBe('number');
    expect(typeof body.lastEventAt).toBe('number');
    // Status endpoint MUST NOT include the event buffer — that's
    // the point of the split.
    expect('recentEvents' in body).toBe(false);
    supervisor.close();
    await agentHandle.stop();
  });

  it('/runtime/events returns the buffered events alongside lifecycle state', async () => {
    const { adapter, controller } = createStubAgentRuntime({
      name: 'test-agent',
      manualReady: true,
    });
    const agentHandle = await adapter.start({
      projectRoot: tmp,
      project: { slug: 'smoke', name: 'Smoke', protocol: '1.1' },
    });
    const supervisor = new RuntimeSupervisor({ adapter, handle: agentHandle });

    controller.emitStatus('ready');
    controller.emitLog('stderr', 'boot warning');
    controller.emitError('recoverable glitch');
    controller.emitLog('stdout', 'listening');

    const h = await boot({ supervisor });
    const res = await fetch(url(h, '/runtime/events'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      present: boolean;
      name: string;
      runId: string;
      status: string;
      events: Array<{ type: string; sequence: number }>;
    };
    expect(body.present).toBe(true);
    expect(body.status).toBe('ready');
    expect(body.events.length).toBeGreaterThanOrEqual(4);
    // Monotonic sequences, oldest-first.
    for (let i = 1; i < body.events.length; i++) {
      const cur = body.events[i]?.sequence ?? 0;
      const prev = body.events[i - 1]?.sequence ?? 0;
      expect(cur).toBeGreaterThan(prev);
    }
    supervisor.close();
    await agentHandle.stop();
  });

  it('late-bound supervisor is picked up by getRuntimeSupervisor on next request', async () => {
    // Mimics the `runDev` ordering: server starts first, supervisor
    // attaches asynchronously. The accessor closure captures a
    // variable that's still null when startDevServer resolves.
    let supervisor: RuntimeSupervisor | null = null;
    const h = await boot({ getSupervisor: () => supervisor });

    let res = await fetch(url(h, '/runtime/status'));
    expect(await res.json()).toEqual({ present: false });

    const { adapter } = createStubAgentRuntime({ name: 'late-agent' });
    const agentHandle = await adapter.start({
      projectRoot: tmp,
      project: { slug: 'smoke', name: 'Smoke', protocol: '1.1' },
    });
    supervisor = new RuntimeSupervisor({ adapter, handle: agentHandle });

    res = await fetch(url(h, '/runtime/status'));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ present: true, name: 'late-agent' });
    supervisor.close();
    await agentHandle.stop();
  });
});
