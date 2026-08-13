/**
 * `handleHostBridgeRequest` — the composable host-role bridge switch.
 *
 * The load-bearing pin is the `ui/initialize` result shape:
 * `@modelcontextprotocol/ext-apps` `App.connect` zod-validates the
 * response against `McpUiInitializeResultSchema` (`protocolVersion` +
 * `hostInfo` + `hostCapabilities` + `hostContext` ALL required), so a
 * draft-shaped result kills every embedded-page mount before the
 * renderer boots. Same bug class the `McpAppIframe` dispatcher had —
 * caught live by the npx-bootstrap e2e (ggui#425 item 5).
 */
import { describe, expect, it, vi } from 'vitest';
import type { McpAppsGguiSession } from '@ggui-ai/protocol/integrations/mcp-apps';
import {
  LATEST_PROTOCOL_VERSION,
  McpUiInitializeResultSchema,
} from '@modelcontextprotocol/ext-apps';
import {
  buildDeliveryScript,
  buildInjectedBridgeScript,
  handleHostBridgeRequest,
  NATIVE_BRIDGE_ENVELOPE_KEY,
  type HostBridgeContext,
} from './mcp-apps-bridge';

// ---------------------------------------------------------------------------
// Executable-script harness — the WebView transport bugs from guuey's
// first-integrator device report (ggui#425) were invisible to tests
// that string-parse the injected scripts; these tests EXECUTE them
// against a fake window that enforces WebKit's `MessageEvent.source`
// legality rule (source must be a WindowProxy / MessagePort / null —
// a plain object throws TypeError).
// ---------------------------------------------------------------------------

type MessageListener = (ev: unknown) => void;

interface FakeWebViewWindow {
  __gguiMcpAppsBridge?: { version: number; ready?: boolean };
  __gguiDeliver?: (data: unknown) => void;
  ReactNativeWebView: { postMessage: ReturnType<typeof vi.fn> };
  addEventListener: (type: string, fn: MessageListener) => void;
  removeEventListener: (type: string, fn: MessageListener) => void;
  dispatchEvent: (ev: { type: string }) => boolean;
  postMessage: (data: unknown) => void;
  onmessage?: MessageListener | null;
  parent?: unknown;
}

function makeWebKitWindow(): {
  win: FakeWebViewWindow;
  run: (script: string) => void;
} {
  const listeners: MessageListener[] = [];
  const win: FakeWebViewWindow = {
    ReactNativeWebView: { postMessage: vi.fn() },
    addEventListener: (type, fn) => {
      if (type === 'message') listeners.push(fn);
    },
    removeEventListener: (type, fn) => {
      if (type === 'message') {
        const i = listeners.indexOf(fn);
        if (i !== -1) listeners.splice(i, 1);
      }
    },
    dispatchEvent: (ev) => {
      if (ev.type === 'message') {
        for (const fn of [...listeners]) fn(ev);
      }
      return true;
    },
    postMessage: () => undefined,
  };
  // WebKit-strict MessageEvent: a `source` that is neither null nor a
  // real window (here: the fake window itself) throws — the exact
  // failure mode the device report diagnosed (`TypeError` swallowed by
  // the delivery script's catch, nothing ever delivered).
  class StrictMessageEvent {
    readonly type: string;
    readonly data: unknown;
    readonly source: unknown;
    constructor(type: string, init?: { data?: unknown; source?: unknown }) {
      const source = init?.source ?? null;
      if (source !== null && source !== win) {
        throw new TypeError(
          'MessageEvent.source must be a WindowProxy, MessagePort, or null',
        );
      }
      this.type = type;
      this.data = init?.data;
      this.source = source;
    }
  }
  const run = (script: string): void => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- executing the bridge's own generated script IS the unit under test
    new Function('window', 'MessageEvent', script)(win, StrictMessageEvent);
  };
  return { win, run };
}

describe('injected bridge + delivery script — executable transport contract', () => {
  it('page → host: window.postMessage forwards an enveloped payload to the RN bridge', () => {
    const { win, run } = makeWebKitWindow();
    run(buildInjectedBridgeScript());
    win.postMessage({ jsonrpc: '2.0', id: 1, method: 'ui/initialize' });
    expect(win.ReactNativeWebView.postMessage).toHaveBeenCalledTimes(1);
    const raw = win.ReactNativeWebView.postMessage.mock.calls[0]?.[0] as string;
    const envelope = JSON.parse(raw) as Record<string, unknown>;
    expect(envelope[NATIVE_BRIDGE_ENVELOPE_KEY]).toBe(true);
    expect(envelope.payload).toEqual({ jsonrpc: '2.0', id: 1, method: 'ui/initialize' });
  });

  it('window.parent identity is STABLE across accesses (transport equality checks)', () => {
    const { win, run } = makeWebKitWindow();
    run(buildInjectedBridgeScript());
    expect(win.parent).toBe(win.parent);
  });

  it('host → page: delivery reaches a page message listener under WebKit source rules', () => {
    const { win, run } = makeWebKitWindow();
    run(buildInjectedBridgeScript());
    // The shell / runtime registers its listener AFTER the
    // document-start bridge, exactly like the real load order.
    const received: unknown[] = [];
    win.addEventListener('message', (ev) => received.push(ev));
    run(buildDeliveryScript({ jsonrpc: '2.0', id: 7, result: { ok: true } }));
    expect(received).toHaveLength(1);
    const ev = received[0] as { data: unknown; source: unknown };
    expect(ev.data).toEqual({ jsonrpc: '2.0', id: 7, result: { ok: true } });
    // Replies must be attributable to the host: source === window.parent.
    expect(ev.source).toBe(win.parent);
  });

  it('host → page: a window.onmessage handler also receives the delivery', () => {
    const { win, run } = makeWebKitWindow();
    run(buildInjectedBridgeScript());
    const received: unknown[] = [];
    win.onmessage = (ev) => received.push(ev);
    run(buildDeliveryScript({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: {} }));
    expect(received).toHaveLength(1);
  });

  it('host → page: listeners removed via removeEventListener stop receiving', () => {
    const { win, run } = makeWebKitWindow();
    run(buildInjectedBridgeScript());
    const received: unknown[] = [];
    const listener: MessageListener = (ev) => received.push(ev);
    win.addEventListener('message', listener);
    win.removeEventListener('message', listener);
    run(buildDeliveryScript({ jsonrpc: '2.0', id: 8, result: {} }));
    expect(received).toHaveLength(0);
  });
});

const SAMPLE_RENDER: McpAppsGguiSession = {
  type: 'mcpApps',
  id: 'render-bridge-test',
  createdAt: '2026-08-07T00:00:00.000Z',
  source: {
    connectorId: 'test-connector',
    toolName: 'test_tool',
    resourceUri: 'ui://test/app',
  },
};

function makeCtx(overrides?: Partial<HostBridgeContext>): HostBridgeContext {
  return {
    sessionId: SAMPLE_RENDER.id,
    render: SAMPLE_RENDER,
    toolsCallUrl: 'https://ggui.test/mcp-apps/tools-call',
    ...overrides,
  };
}

describe('handleHostBridgeRequest — ui/initialize', () => {
  it('returns a spec-valid McpUiInitializeResult', async () => {
    const res = await handleHostBridgeRequest(
      { jsonrpc: '2.0', id: 3, method: 'ui/initialize' },
      makeCtx({
        locale: 'ko-KR',
        containerDimensions: { width: 320, height: 480 },
      }),
    );
    expect(res).not.toBeNull();
    const result = McpUiInitializeResultSchema.parse(res?.result);
    expect(result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    expect(result.hostContext.locale).toBe('ko-KR');
    expect(result.hostContext.containerDimensions).toEqual({
      width: 320,
      height: 480,
    });
  });

  it('echoes the requested protocolVersion when supplied', async () => {
    const res = await handleHostBridgeRequest(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'ui/initialize',
        params: { protocolVersion: '2026-01-26' },
      },
      makeCtx(),
    );
    const result = McpUiInitializeResultSchema.parse(res?.result);
    expect(result.protocolVersion).toBe('2026-01-26');
  });
});

describe('handleHostBridgeRequest — ui/update-model-context', () => {
  it('forwards params to onUpdateModelContext and acks with an empty result', async () => {
    const seen: unknown[] = [];
    const res = await handleHostBridgeRequest(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'ui/update-model-context',
        params: { content: [{ type: 'text', text: 'user checked item 2' }] },
      },
      makeCtx({ onUpdateModelContext: (params) => void seen.push(params) }),
    );
    expect(res).toEqual({ jsonrpc: '2.0', id: 5, result: {} });
    expect(seen).toHaveLength(1);
  });

  it('stays an honest method_not_supported when no handler is wired', async () => {
    const res = await handleHostBridgeRequest(
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'ui/update-model-context',
        params: { content: [] },
      },
      makeCtx(),
    );
    expect(res?.error?.code).toBe(-32601);
  });
});
