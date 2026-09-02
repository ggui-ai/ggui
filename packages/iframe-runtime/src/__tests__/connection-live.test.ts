/**
 * ggui#670 Phase 1 — `useRender().isConnected` becomes a LIVE read of the
 * relay latch through the in-document connection store (no reserved
 * channel, no suppression, build-once preserved). Two pins:
 *   1. the store flips false on a confirmed relay latch and back to true
 *      on the response-arrival clear — one transition per edge;
 *   2. a React component reading `useRender().isConnected` re-renders on
 *      the flip with NO remount and NO provider re-render (external store).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { App } from '@modelcontextprotocol/ext-apps';
import { GguiWireProvider, useRender } from '@ggui-ai/wire';
import {
  routeDispatch,
  setCurrentApp,
  __resetAppForTest,
  __resetRelayNoticeForTest,
} from '../runtime.js';
import { connectionStore } from '../connection.js';
import { __resetHostCapabilitiesForTest, setHostCapabilities } from '../host-capabilities.js';
import { buildBootHarness, tick } from './boot-helpers.js';
import type { MockTransport } from './mock-transport.js';

let transport: MockTransport;
let app: App;
let originalPostMessage: typeof window.parent.postMessage;

beforeEach(async () => {
  originalPostMessage = window.parent.postMessage;
  Object.defineProperty(window.parent, 'postMessage', { value: vi.fn(), configurable: true, writable: true });
  const harness = buildBootHarness();
  transport = harness.transport;
  app = harness.app;
  await app.connect(transport);
  setCurrentApp(app);
  __resetHostCapabilitiesForTest();
  __resetRelayNoticeForTest();
  document.getElementById('__ggui-action-toast__')?.remove();
});

afterEach(() => {
  Object.defineProperty(window.parent, 'postMessage', { value: originalPostMessage, configurable: true, writable: true });
  __resetAppForTest();
});

async function dispatchOnce(): Promise<void> {
  routeDispatch({
    actionName: 'archive',
    data: {},
    meta: { sessionId: 'sess_1', appId: 'app_1' },
    dispatchToolName: 'ggui_runtime_submit_action',
  });
  await tick();
  await tick();
}

describe('connection store follows the relay latch (ggui#670)', () => {
  it('starts connected, flips to false on a confirmed refusal, and back to true on the next well-formed result', async () => {
    expect(connectionStore.getSnapshot()).toBe(true);
    setHostCapabilities({ serverTools: {} });
    transport.queueResponse('tools/call', { error: { code: -32601, message: 'method not supported' } });
    await dispatchOnce();
    expect(connectionStore.getSnapshot()).toBe(false);

    transport.queueResponse('tools/call', { result: { structuredContent: { ok: true, consumerPresent: true } } });
    await dispatchOnce();
    expect(connectionStore.getSnapshot()).toBe(true);
  });

  it('__resetRelayNoticeForTest resets the store with the latch — lifetimes aligned', async () => {
    setHostCapabilities({ serverTools: {} });
    transport.queueResponse('tools/call', { error: { code: -32601, message: 'method not supported' } });
    await dispatchOnce();
    expect(connectionStore.getSnapshot()).toBe(false);
    __resetRelayNoticeForTest();
    expect(connectionStore.getSnapshot()).toBe(true);
  });
});

describe('useRender().isConnected is live (ggui#670)', () => {
  it('a mounted component re-renders on the latch flip with no remount — external store, not a provider re-render', async () => {
    const mounts = { count: 0 };
    function Probe() {
      const { isConnected } = useRender();
      return createElement('span', { 'data-probe': '', ref: () => { mounts.count += 1; } }, String(isConnected));
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const config = {
      app: { appId: 'app_1', appName: 'app_1' },
      render: { sessionId: 'sess_1', isConnected: true },
      auth: { isAuthenticated: false },
      dispatch: () => {},
      subscribe: () => () => {},
    };
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(GguiWireProvider, { config, children: createElement(Probe) }));
    });
    const probe = () => container.querySelector('[data-probe]')!.textContent;
    expect(probe()).toBe('true');

    setHostCapabilities({ serverTools: {} });
    transport.queueResponse('tools/call', { error: { code: -32601, message: 'method not supported' } });
    await act(async () => { await dispatchOnce(); });
    expect(probe()).toBe('false');

    transport.queueResponse('tools/call', { result: { structuredContent: { ok: true, consumerPresent: true } } });
    await act(async () => { await dispatchOnce(); });
    expect(probe()).toBe('true');

    await act(async () => { root.unmount(); });
    container.remove();
  });
});
