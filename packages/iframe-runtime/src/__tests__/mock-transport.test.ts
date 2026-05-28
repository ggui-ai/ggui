/**
 * Sanity tests for {@link MockTransport} round-tripping JSON-RPC
 * envelopes against `App.connect` / `App.callServerTool` from
 * `@modelcontextprotocol/ext-apps`.
 *
 * These tests pin the transport contract that bootSequence relies on
 * post-Phase-1.19b.3 — the App's ui/initialize handshake completes,
 * notification listeners fire on inbound notifications, and outbound
 * tools/call calls round-trip through `app.callServerTool`.
 */
import { describe, it, expect } from 'vitest';
import { App } from '@modelcontextprotocol/ext-apps';
import { MockTransport } from './mock-transport.js';

const PROTOCOL_VERSION = '2026-01-26';

function queueHandshakeResponse(transport: MockTransport): void {
  transport.queueResponse('ui/initialize', {
    result: {
      protocolVersion: PROTOCOL_VERSION,
      hostInfo: { name: 'mock-host', version: '1.0' },
      hostCapabilities: {},
      hostContext: { availableDisplayModes: ['inline'] },
    },
  });
}

describe('MockTransport — App handshake', () => {
  it('App.connect() completes the ui/initialize handshake', async () => {
    const transport = new MockTransport();
    queueHandshakeResponse(transport);

    const app = new App(
      { name: 'mock-app', version: '0.0.1' },
      {},
      { autoResize: false },
    );

    await app.connect(transport);

    expect(transport.methodsSeen).toContain('ui/initialize');
    expect(transport.methodsSeen).toContain('ui/notifications/initialized');
    expect(app.getHostContext()?.availableDisplayModes).toEqual(['inline']);
    expect(app.getHostVersion()?.name).toBe('mock-host');
  });

  it('App.connect() throws when ui/initialize returns an error', async () => {
    const transport = new MockTransport();
    transport.queueResponse('ui/initialize', {
      error: { message: 'host refused' },
    });

    const app = new App(
      { name: 'mock-app', version: '0.0.1' },
      {},
      { autoResize: false },
    );

    await expect(app.connect(transport)).rejects.toThrow(/host refused/);
  });

  it('App.callServerTool round-trips through MockTransport', async () => {
    const transport = new MockTransport();
    queueHandshakeResponse(transport);
    transport.queueResponse('tools/call', {
      result: {
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: { ok: true },
      },
    });

    const app = new App(
      { name: 'mock-app', version: '0.0.1' },
      {},
      { autoResize: false },
    );
    await app.connect(transport);

    const result = await app.callServerTool({
      name: 'my_tool',
      arguments: { x: 1 },
    });

    expect(result.structuredContent).toEqual({ ok: true });
    // ui/initialize, ui/notifications/initialized, then tools/call.
    expect(transport.methodsSeen).toContain('tools/call');
  });

  it('inbound ui/notifications/tool-result fires the toolresult event', async () => {
    const transport = new MockTransport();
    queueHandshakeResponse(transport);

    const app = new App(
      { name: 'mock-app', version: '0.0.1' },
      {},
      { autoResize: false },
    );
    const received: unknown[] = [];
    app.addEventListener('toolresult', (params) => {
      received.push(params);
    });
    await app.connect(transport);

    transport.pushNotification({
      method: 'ui/notifications/tool-result',
      params: {
        _meta: { 'ai.ggui/render': { renderId: 'r1' } },
        content: [{ type: 'text', text: 'done' }],
        structuredContent: { renderId: 'r1' },
      },
    });

    // App dispatches notifications via the SDK Protocol layer, which
    // parses + validates with zod asynchronously. Let the microtask
    // queue drain before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(received).toHaveLength(1);
    const evt = received[0] as { _meta?: Record<string, unknown> };
    expect(evt._meta?.['ai.ggui/render']).toEqual({ renderId: 'r1' });
  });

  it('host-context-changed updates getHostContext()', async () => {
    const transport = new MockTransport();
    queueHandshakeResponse(transport);

    const app = new App(
      { name: 'mock-app', version: '0.0.1' },
      {},
      { autoResize: false },
    );
    await app.connect(transport);

    expect(app.getHostContext()?.theme).toBeUndefined();

    transport.pushNotification({
      method: 'ui/notifications/host-context-changed',
      params: { theme: 'dark' },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(app.getHostContext()?.theme).toBe('dark');
  });
});
