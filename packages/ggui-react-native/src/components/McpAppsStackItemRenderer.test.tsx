/**
 * Tests for the React Native `McpAppsStackItemRenderer` + the shared
 * host-role bridge.
 *
 * Coverage:
 *
 *   - Pure bridge (`handleHostBridgeRequest`): dispatches ui/initialize,
 *     ping, ui/open-link, tools/call, unknown-method correctly; rejects
 *     malformed JSON-RPC; never trusts `tools/call` locally — always
 *     forwards to the server proxy; rejects non-http(s) open-link URLs.
 *   - Injected bridge script (`buildInjectedBridgeScript`): contains
 *     the `window.postMessage` override + `window.parent` alias + the
 *     `__ggui_mcp_apps` envelope wrapper.
 *   - Delivery script (`buildDeliveryScript`): escapes the message
 *     payload through `JSON.parse(JSON.stringify(...))` so caller-
 *     controlled strings cannot break out into executable JS.
 *   - Native renderer: mounts a WebView pointing at the ggui server
 *     `/mcp-apps/resource` URL with the injected bridge script.
 *   - Web renderer (web branch): iframe unchanged.
 *   - `StackItemRenderer` dispatches mcpApps items to the new renderer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { create, act, type ReactTestRenderer } from 'react-test-renderer';
import { Platform, Linking } from 'react-native';
import type { McpAppsStackItem } from '@ggui-ai/protocol/integrations/mcp-apps';
import {
  McpAppsStackItemRenderer,
  handleHostBridgeRequest,
  buildInjectedBridgeScript,
  buildDeliveryScript,
  NATIVE_BRIDGE_ENVELOPE_KEY,
  type HostBridgeContext,
} from './McpAppsStackItemRenderer';
import { StackItemRenderer } from './DynamicComponent';

function makeMcpItem(overrides?: Partial<McpAppsStackItem>): McpAppsStackItem {
  return {
    type: 'mcpApps',
    id: 'item-1',
    createdAt: '2026-04-19T00:00:00Z',
    source: {
      connectorId: 'stripe',
      toolName: 'checkout',
      resourceUri: 'ui://stripe/checkout',
    },
    ...overrides,
  };
}

function makeCtx(overrides?: Partial<HostBridgeContext>): HostBridgeContext {
  return {
    sessionId: 'sess-1',
    stackItem: makeMcpItem(),
    toolsCallUrl: 'https://ggui.example/mcp-apps/tools-call',
    ...overrides,
  };
}

function findNode(
  tree: ReactTestRenderer,
  type: string,
): ReturnType<ReactTestRenderer['root']['findByType']> | null {
  try {
    return tree.root.findByType(type);
  } catch {
    return null;
  }
}

/**
 * Find the mocked WebView in the tree. The test-setup.ts mock wraps
 * `react-native-webview`'s default export in a `forwardRef` that
 * creates an element of type 'WebView'. Find it by walking the tree
 * and matching on the `source.uri` prop shape — robust to any minor
 * shape differences between React major versions.
 */
function findWebViewNode(
  tree: ReactTestRenderer,
): ReturnType<ReactTestRenderer['root']['findAll']>[number] | null {
  const matches = tree.root.findAll((node) => {
    const src = node.props?.source as { uri?: string } | undefined;
    return typeof src?.uri === 'string' && src.uri.includes('/mcp-apps/resource');
  });
  return matches[0] ?? null;
}

// =============================================================================
// Pure bridge switch — handleHostBridgeRequest
// =============================================================================

describe('handleHostBridgeRequest', () => {
  describe('malformed / untrusted frames', () => {
    it('returns null for non-object requests', async () => {
      expect(await handleHostBridgeRequest(null as never, makeCtx())).toBeNull();
      expect(
        await handleHostBridgeRequest(undefined as never, makeCtx()),
      ).toBeNull();
      expect(await handleHostBridgeRequest('string' as never, makeCtx())).toBeNull();
    });

    it('returns null for non-JSON-RPC-2.0 requests', async () => {
      expect(
        await handleHostBridgeRequest(
          { jsonrpc: '1.0', method: 'ui/initialize' } as never,
          makeCtx(),
        ),
      ).toBeNull();
      expect(
        await handleHostBridgeRequest(
          { jsonrpc: '2.0', method: 42 } as never,
          makeCtx(),
        ),
      ).toBeNull();
    });
  });

  describe('ping', () => {
    it('responds with pong', async () => {
      const res = await handleHostBridgeRequest(
        { jsonrpc: '2.0', id: 7, method: 'ping' },
        makeCtx(),
      );
      expect(res).toEqual({ jsonrpc: '2.0', id: 7, result: { pong: true } });
    });

    it('defaults id to 0 when absent', async () => {
      const res = await handleHostBridgeRequest(
        { jsonrpc: '2.0', method: 'ping' },
        makeCtx(),
      );
      expect(res?.id).toBe(0);
    });
  });

  describe('ui/initialize', () => {
    it('forwards theme + locale + containerDimensions from context', async () => {
      const res = await handleHostBridgeRequest(
        { jsonrpc: '2.0', id: 1, method: 'ui/initialize' },
        makeCtx({
          theme: { '--color-primary': '#ff0000' },
          locale: 'fr-FR',
          containerDimensions: { width: 640, height: 480 },
        }),
      );
      expect(res?.result?.theme).toEqual({ '--color-primary': '#ff0000' });
      expect(res?.result?.locale).toBe('fr-FR');
      expect(res?.result?.containerDimensions).toEqual({ width: 640, height: 480 });
    });

    it('ADAPTER BOUNDARY: result carries ONLY theme / containerDimensions / locale', async () => {
      const res = await handleHostBridgeRequest(
        { jsonrpc: '2.0', id: 1, method: 'ui/initialize' },
        makeCtx(),
      );
      const result = res?.result ?? {};
      const keys = Object.keys(result).sort();
      expect(keys).toEqual(['containerDimensions', 'locale', 'theme']);
      for (const forbidden of [
        'stack',
        'sessionId',
        'appId',
        'currentStackIndex',
        'actionSpec',
        'streamSpec',
        'propsSpec',
      ]) {
        expect(result).not.toHaveProperty(forbidden);
      }
    });
  });

  describe('ui/open-link', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('rejects non-http(s) schemes with -32602', async () => {
      for (const url of [
        'javascript:alert(1)',
        'file:///etc/passwd',
        'data:text/html,<script>',
        'ftp://example.com',
        'chrome://settings',
        '',
      ]) {
        const res = await handleHostBridgeRequest(
          { jsonrpc: '2.0', id: 1, method: 'ui/open-link', params: { url } },
          makeCtx(),
        );
        expect(res?.error?.code).toBe(-32602);
        expect(res?.error?.message).toContain('http(s)');
      }
    });

    it('delegates to Linking.openURL on native', async () => {
      const spy = vi
        .spyOn(Linking, 'openURL')
        .mockImplementation(async () => undefined);
      const res = await handleHostBridgeRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'ui/open-link',
          params: { url: 'https://stripe.com/checkout' },
        },
        makeCtx(),
      );
      expect(spy).toHaveBeenCalledWith('https://stripe.com/checkout');
      expect(res?.result).toEqual({ opened: true });
    });

    it('surfaces Linking.openURL failures as -32000', async () => {
      vi.spyOn(Linking, 'openURL').mockImplementation(async () => {
        throw new Error('no handler');
      });
      const res = await handleHostBridgeRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'ui/open-link',
          params: { url: 'https://example.com' },
        },
        makeCtx(),
      );
      expect(res?.error?.code).toBe(-32000);
      expect(res?.error?.message).toContain('open_link_failed');
    });
  });

  describe('tools/call — TRUST BOUNDARY: always round-trips through the server', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('forwards to the toolsCallUrl with the server-expected body shape', async () => {
      const fetchSpy = vi.fn(
        async () =>
          new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      );
      vi.stubGlobal('fetch', fetchSpy);
      const ctx = makeCtx();
      const res = await handleHostBridgeRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'checkout', arguments: { amount: 4200 } },
        },
        ctx,
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const call = fetchSpy.mock.calls[0]!;
      expect(call[0]).toBe(ctx.toolsCallUrl);
      const init = call[1] as RequestInit;
      expect(init.method).toBe('POST');
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      // Server receives the stack-item id + session id + tool name +
      // arguments — NOT the connector id. The route resolves the
      // connector from the stack item in the session store, so a
      // forged-connector-id in the WebView message has no effect.
      expect(body.session).toBe(ctx.sessionId);
      expect(body.item).toBe(ctx.stackItem.id);
      expect(body.tool).toBe('checkout');
      expect(body.arguments).toEqual({ amount: 4200 });
      expect(body.connectorId).toBeUndefined();
      expect(res?.result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
    });

    it('rejects missing tool name with -32602 BEFORE any network call', async () => {
      const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
      vi.stubGlobal('fetch', fetchSpy);
      const res = await handleHostBridgeRequest(
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} },
        makeCtx(),
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(res?.error?.code).toBe(-32602);
    });

    it('maps 403 visibility_denied from the server to -32003', async () => {
      vi.stubGlobal(
        'fetch',
        async () =>
          new Response(JSON.stringify({ error: 'visibility_denied' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          }),
      );
      const res = await handleHostBridgeRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'model_only' },
        },
        makeCtx(),
      );
      expect(res?.error?.code).toBe(-32003);
      expect(res?.error?.message).toBe('visibility_denied');
    });

    it('surfaces fetch failures as -32000', async () => {
      vi.stubGlobal('fetch', async () => {
        throw new TypeError('network error');
      });
      const res = await handleHostBridgeRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'checkout' },
        },
        makeCtx(),
      );
      expect(res?.error?.code).toBe(-32000);
      expect(res?.error?.message).toContain('proxy_fetch_failed');
    });
  });

  describe('unknown method', () => {
    it('responds with -32601 method_not_supported', async () => {
      const res = await handleHostBridgeRequest(
        { jsonrpc: '2.0', id: 5, method: 'ui/request-display-mode' },
        makeCtx(),
      );
      expect(res?.error?.code).toBe(-32601);
      expect(res?.error?.message).toBe('method_not_supported');
    });
  });
});

// =============================================================================
// Injected bridge script + delivery script
// =============================================================================

describe('buildInjectedBridgeScript', () => {
  const script = buildInjectedBridgeScript();

  it('overrides window.postMessage to forward to ReactNativeWebView', () => {
    expect(script).toContain('window.postMessage = function');
    expect(script).toContain('ReactNativeWebView.postMessage');
  });

  it('wraps outgoing payloads with the __ggui_mcp_apps envelope key', () => {
    expect(script).toContain('__ggui_mcp_apps');
    expect(NATIVE_BRIDGE_ENVELOPE_KEY).toBe('__ggui_mcp_apps');
  });

  it('aliases window.parent with a postMessage-only object (prevents same-window loopback)', () => {
    expect(script).toContain("Object.defineProperty(window, 'parent'");
    expect(script).toContain('postMessage: forward');
  });

  it('ends with `true;` trailer required by iOS WebView', () => {
    expect(script.trimEnd().endsWith('true;')).toBe(true);
  });

  it('is idempotent — re-injection is a no-op', () => {
    expect(script).toContain('if (window.__gguiMcpAppsBridge) return');
  });
});

describe('buildDeliveryScript', () => {
  it('escapes caller-controlled payloads via double JSON encoding', () => {
    // The payload lands INSIDE JSON.parse(<string-literal>). Strings
    // are never interpreted as JS identifiers. A message containing
    // quotes / semicolons cannot break out into executable JS.
    const script = buildDeliveryScript({
      jsonrpc: '2.0',
      id: 1,
      result: { text: '"; alert(1); //' },
    });
    // Entry point MUST be JSON.parse of a single string literal — no
    // string concatenation of untrusted data into source code.
    expect(script).toContain('JSON.parse(');
    // The dangerous content `"; alert(1); //` is not sitting at the
    // top level: every double quote is backslash-escaped inside the
    // JSON.parse string argument.
    const parseCall = /JSON\.parse\(("(?:\\.|[^"\\])*")\)/.exec(script);
    expect(parseCall).not.toBeNull();
    const jsonStr = parseCall![1]!;
    // The literal bytes `\";` appear in the escaped form.
    expect(jsonStr).toContain('\\"');
    // Round-trip: re-parsing the JSON literal yields the original
    // untrusted string verbatim — it was carried as data, never code.
    // JavaScript string-literals and JSON strings share escape syntax
    // for these characters, so `eval`-equivalent JSON parse is fine
    // here as a test-only step.
    const innerJson = JSON.parse(jsonStr) as string;
    const payload = JSON.parse(innerJson) as {
      result: { text: string };
    };
    expect(payload.result.text).toBe('"; alert(1); //');
  });

  it('dispatches a `message` event on window with source=window.parent', () => {
    const script = buildDeliveryScript({
      jsonrpc: '2.0',
      method: 'ui/resource-teardown',
      params: { reason: 'host_unmount' },
    });
    expect(script).toContain("new MessageEvent('message'");
    expect(script).toContain('source: window.parent');
    expect(script).toContain('window.dispatchEvent');
  });

  it('emits the `true;` trailer for iOS WebView', () => {
    expect(buildDeliveryScript({ jsonrpc: '2.0', id: 1, result: {} }).trimEnd().endsWith('true;')).toBe(
      true,
    );
  });
});

// =============================================================================
// Native renderer
// =============================================================================

describe('McpAppsStackItemRenderer — native WebView', () => {
  it('mounts a WebView loading the ggui server /mcp-apps/resource URL', () => {
    expect(Platform.OS).toBe('ios');
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <McpAppsStackItemRenderer
          stackItem={makeMcpItem()}
          sessionId="sess-1"
          serverBaseUrl="https://ggui.example"
        />,
      );
    });
    const webView = findWebViewNode(tree);
    expect(webView).not.toBeNull();
    expect((webView!.props.source as { uri: string }).uri).toBe(
      'https://ggui.example/mcp-apps/resource?session=sess-1&item=item-1',
    );
    act(() => tree.unmount());
  });

  it('injects the bridge script via injectedJavaScriptBeforeContentLoaded', () => {
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <McpAppsStackItemRenderer
          stackItem={makeMcpItem()}
          sessionId="sess-1"
          serverBaseUrl="https://ggui.example"
        />,
      );
    });
    const webView = findWebViewNode(tree);
    expect(webView).not.toBeNull();
    const script = webView!.props
      .injectedJavaScriptBeforeContentLoaded as string;
    expect(typeof script).toBe('string');
    expect(script).toContain('ReactNativeWebView.postMessage');
    expect(script).toContain('__ggui_mcp_apps');
    act(() => tree.unmount());
  });

  it('restricts origin whitelist to http(s) only — no file:// / custom-scheme escapes', () => {
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <McpAppsStackItemRenderer
          stackItem={makeMcpItem()}
          sessionId="sess-1"
          serverBaseUrl="https://ggui.example"
        />,
      );
    });
    const webView = findWebViewNode(tree);
    expect(webView).not.toBeNull();
    expect(webView!.props.originWhitelist).toEqual(['http://*', 'https://*']);
    // Media must require user gesture so embedded views can't autoplay
    // camera/mic.
    expect(webView!.props.mediaPlaybackRequiresUserAction).toBe(true);
    // Pop-ups disabled — embedded views cannot spawn new native browser
    // windows that bypass the `ui/open-link` validation path.
    expect(webView!.props.setSupportMultipleWindows).toBe(false);
    act(() => tree.unmount());
  });
});

// =============================================================================
// Web renderer (unchanged behavior)
// =============================================================================

describe('McpAppsStackItemRenderer — web branch', () => {
  beforeEach(() => {
    // @ts-expect-error — runtime override of mocked Platform.OS.
    Platform.OS = 'web';
  });
  afterEach(() => {
    // @ts-expect-error — restore.
    Platform.OS = 'ios';
  });

  it('renders an iframe with the proxy URL and sandbox attributes', () => {
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <McpAppsStackItemRenderer
          stackItem={makeMcpItem({ permissions: { camera: true } })}
          sessionId="sess-1"
          serverBaseUrl="https://ggui.example"
        />,
      );
    });
    const iframe = findNode(tree, 'iframe');
    expect(iframe).not.toBeNull();
    const props = iframe?.props as {
      src?: string;
      sandbox?: string;
      allow?: string;
      'data-ggui-connector-id'?: string;
    };
    expect(props.src).toBe(
      'https://ggui.example/mcp-apps/resource?session=sess-1&item=item-1',
    );
    expect(props.sandbox).toContain('allow-scripts');
    expect(props.allow).toContain("camera 'self'");
    expect(props['data-ggui-connector-id']).toBe('stripe');
    act(() => tree.unmount());
  });
});

// =============================================================================
// StackItemRenderer dispatch
// =============================================================================

describe('StackItemRenderer — variant dispatch on native', () => {
  it('dispatches mcpApps items to the native WebView renderer', () => {
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <StackItemRenderer
          stackItem={makeMcpItem()}
          sessionId="sess-1"
          serverBaseUrl="https://ggui.example"
        />,
      );
    });
    // Native path — WebView visible, no iframe.
    expect(findNode(tree, 'iframe')).toBeNull();
    expect(findWebViewNode(tree)).not.toBeNull();
    act(() => tree.unmount());
  });
});
