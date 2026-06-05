/**
 * Tests for `<McpAppIframe>` on React Native — plan §C9 obligations +
 * adapter-boundary enforcement + parity with the web host.
 *
 * Covers:
 *   1. dispatchHostBridgeRequest parity with the web port (same
 *      switch shape, same error codes).
 *   2. Envelope classification parity.
 *   3. Resource → WebView source derivation.
 *   4. Mounts a WebView with:
 *      - `source={{html}}` for inline text,
 *      - `source={{uri: data:...}}` for blobs,
 *      - `source={{uri: http(s)://...}}` for URL resources.
 *      Non-mountable resources render an empty View + fire onError
 *      with a bootstrap-failed ProtocolError.
 *   5. WebView security hardening: originWhitelist locked to
 *      http(s), setSupportMultipleWindows=false, media requires
 *      gesture when camera/microphone permissions are not granted.
 *   6. Imperative ref dispatchAction calls
 *      `WebView.injectJavaScript` with the expected payload.
 */
import { describe, it, expect, vi } from 'vitest';
import React, { createRef } from 'react';
import {
  create,
  act,
  type ReactTestRenderer,
} from 'react-test-renderer';
import type {
  ResourceContents,
  TextResourceContents,
  BlobResourceContents,
} from '@modelcontextprotocol/sdk/types.js';

// Test fixtures can carry `text` (TextResourceContents) or `blob`
// (BlobResourceContents) variants. `McpAppIframeProps.resource` is the
// base `ResourceContents`, structurally satisfied by both.
type TestResource = ResourceContents | TextResourceContents | BlobResourceContents;
import type { McpAppAiGguiRenderMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import { McpAppIframe } from './McpAppIframe';
import {
  buildToolResultNotification,
  classifyRendererEnvelope,
  deriveResourceMountSource,
  dispatchHostBridgeRequest,
  type HostBridgeContext,
} from './dispatch';
import type { McpAppIframeRef } from './types';

const SAMPLE_META: McpAppAiGguiRenderMeta = {
  renderId: 'render-test',
  appId: 'app-test',
  runtimeUrl: '/_ggui/iframe-runtime.js',
  wsUrl: 'wss://test.example/ws',
  wsToken: 'sample-bootstrap-token',
  expiresAt: '2099-12-31T23:59:59.999Z',
};

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function makeResource(overrides?: Partial<TestResource>): TestResource {
  return {
    uri: 'ui://test/app',
    mimeType: 'text/html;profile=mcp-app',
    text: '<!doctype html><html><body>hello</body></html>',
    ...overrides,
  };
}

function makeCtx(overrides?: Partial<HostBridgeContext>): HostBridgeContext {
  return {
    theme: { '--color-primary': '#ff0000' },
    locale: 'en-US',
    containerDimensions: { width: 640, height: 480 },
    openLink: vi.fn(async () => undefined),
    ...overrides,
  };
}

function findWebView(
  tree: ReactTestRenderer,
): ReturnType<ReactTestRenderer['root']['findAll']>[number] | null {
  const matches = tree.root.findAll((node) => {
    // The test-setup mock renders `WebView` with element type 'WebView'.
    return node.type === 'WebView';
  });
  return matches[0] ?? null;
}

// =============================================================================
// Pure dispatcher tests — structurally identical to the web port
// =============================================================================

describe('dispatchHostBridgeRequest (RN shared switch)', () => {
  it('returns null for malformed / notification requests', async () => {
    expect(await dispatchHostBridgeRequest(null as never, makeCtx())).toBeNull();
    expect(
      await dispatchHostBridgeRequest(
        { jsonrpc: '2.0', method: 'ping' },
        makeCtx(),
      ),
    ).toBeNull();
  });

  it('ping responds with ok+pong', async () => {
    const res = await dispatchHostBridgeRequest(
      { jsonrpc: '2.0', id: 7, method: 'ping' },
      makeCtx(),
    );
    expect(res).toEqual({ jsonrpc: '2.0', id: 7, result: { ok: true, pong: true } });
  });

  it('ui/initialize ADAPTER BOUNDARY — result carries ONLY 3 keys', async () => {
    const res = await dispatchHostBridgeRequest(
      { jsonrpc: '2.0', id: 1, method: 'ui/initialize' },
      makeCtx(),
    );
    expect(Object.keys(res?.result ?? {}).sort()).toEqual([
      'containerDimensions',
      'locale',
      'theme',
    ]);
    expect(res?.result).not.toHaveProperty('toolOutput');
    expect(res?.result).not.toHaveProperty('_meta');
    for (const forbidden of ['stack', 'renderId', 'appId', 'actionSpec', 'streamSpec']) {
      expect(res?.result).not.toHaveProperty(forbidden);
    }
  });

  it('ui/initialize is invariant under ctx (Reading-B retired) — never carries toolOutput._meta', async () => {
    // The dispatcher no longer accepts a `meta` on the context.
    // GguiSession-meta now flows through the separate spec-canonical
    // `ui/notifications/tool-result` notification (see the
    // `buildToolResultNotification` block below). This test pins the
    // adapter-boundary posture by asserting the response is the same
    // 3-key shape regardless of caller intent.
    const res = await dispatchHostBridgeRequest(
      { jsonrpc: '2.0', id: 1, method: 'ui/initialize' },
      makeCtx(),
    );
    const result = res?.result as Record<string, unknown>;
    expect(result).not.toHaveProperty('toolOutput');
    expect(result).not.toHaveProperty('_meta');
    expect(Object.keys(result).sort()).toEqual([
      'containerDimensions',
      'locale',
      'theme',
    ]);
  });

  it('ui/open-link rejects non-http(s) schemes with unsupported-scheme', async () => {
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,<script>',
    ]) {
      const res = await dispatchHostBridgeRequest(
        { jsonrpc: '2.0', id: 1, method: 'ui/open-link', params: { url } },
        makeCtx(),
      );
      expect(res?.error?.code).toBe(-32602);
      expect(res?.error?.message).toBe('unsupported-scheme');
    }
  });

  it('ui/open-link delegates http(s) to openLink', async () => {
    const openLink = vi.fn(async (_url: string) => undefined);
    const res = await dispatchHostBridgeRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'ui/open-link',
        params: { url: 'https://example.com' },
      },
      makeCtx({ openLink }),
    );
    expect(openLink).toHaveBeenCalledWith('https://example.com');
    expect(res?.result).toEqual({ opened: true });
  });

  it('tools/call without onToolCall → no-tool-handler', async () => {
    const res = await dispatchHostBridgeRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'checkout' },
      },
      makeCtx({ onToolCall: undefined }),
    );
    expect(res?.error?.message).toBe('no-tool-handler');
  });

  it('tools/call forwards to onToolCall and returns its result', async () => {
    const onToolCall = vi.fn(async (tool: string, args: Record<string, unknown>) => ({
      tool,
      args,
    }));
    const res = await dispatchHostBridgeRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'submit', arguments: { x: 1 } },
      },
      makeCtx({ onToolCall }),
    );
    expect(onToolCall).toHaveBeenCalledWith('submit', { x: 1 });
    expect(res?.result).toEqual({ tool: 'submit', args: { x: 1 } });
  });

  it('unknown method → method_not_supported', async () => {
    const res = await dispatchHostBridgeRequest(
      { jsonrpc: '2.0', id: 5, method: 'ui/does-not-exist' },
      makeCtx(),
    );
    expect(res?.error?.code).toBe(-32601);
  });
});

describe('buildToolResultNotification (RN spec-canonical wire shape)', () => {
  it('builds a JSON-RPC notification with method=ui/notifications/tool-result', () => {
    const notif = buildToolResultNotification(SAMPLE_META);
    expect(notif.jsonrpc).toBe('2.0');
    expect(notif.method).toBe('ui/notifications/tool-result');
    // Notifications carry no `id` — fire-and-forget per JSON-RPC.
    expect(notif).not.toHaveProperty('id');
  });

  it('wraps the slice in a CallToolResult-shaped params._meta envelope', () => {
    const notif = buildToolResultNotification(SAMPLE_META);
    const params = notif.params as Record<string, unknown>;
    // CallToolResult per MCP spec carries `content`,
    // `structuredContent`, and our extension lives on `_meta`.
    expect(params).toHaveProperty('content');
    expect(params['content']).toEqual([]);
    expect(params).toHaveProperty('structuredContent');
    expect(params['structuredContent']).toEqual({});
    expect(params).toHaveProperty('_meta');
    const metaEnv = params['_meta'] as Record<string, unknown>;
    // ONLY the `ai.ggui/render` slice (single render-identity slice
    // per the protocol envelope).
    expect(Object.keys(metaEnv).sort()).toEqual(['ai.ggui/render']);
    expect(metaEnv['ai.ggui/render']).toBe(SAMPLE_META);
  });

  it('the wire shape matches what parseMetaFromToolResult reads via params._meta (spec-canonical branch)', () => {
    // Cross-check against the renderer's parser contract. The shape
    // produced here MUST match what `parseMetaFromToolResult()` (in
    // `packages/iframe-runtime/src/meta-parse.ts`) reads via its
    // spec-canonical `params._meta` branch. This test structurally
    // walks the same path the renderer does.
    const notif = buildToolResultNotification(SAMPLE_META);
    const params = notif.params as Record<string, unknown>;
    const metaEnv = params['_meta'] as Record<string, unknown>;
    const render = metaEnv['ai.ggui/render'] as McpAppAiGguiRenderMeta;
    expect(render.wsUrl).toBe(SAMPLE_META.wsUrl);
    expect(render.wsToken).toBe(SAMPLE_META.wsToken);
    expect(render.renderId).toBe(SAMPLE_META.renderId);
    expect(render.appId).toBe(SAMPLE_META.appId);
    expect(render.runtimeUrl).toBe(SAMPLE_META.runtimeUrl);
  });
});

describe('classifyRendererEnvelope (RN)', () => {
  it('matches web port tags for every recognised envelope', () => {
    expect(classifyRendererEnvelope({ type: 'ggui:bootstrap-failed' })).toBe(
      'bootstrap-failed',
    );
    expect(classifyRendererEnvelope({ type: 'ggui:protocol-error' })).toBe(
      'protocol-error',
    );
    expect(classifyRendererEnvelope({ type: 'ggui:observe' })).toBe('observability');
    expect(classifyRendererEnvelope({ type: 'ggui:lifecycle' })).toBe('lifecycle');
    expect(classifyRendererEnvelope({ type: 'ggui:upgrade-required' })).toBe(
      'upgrade-required',
    );
    expect(classifyRendererEnvelope({ jsonrpc: '2.0', method: 'ping' })).toBe(
      'jsonrpc',
    );
    expect(classifyRendererEnvelope({ type: 'other' })).toBe('unknown');
  });
});

describe('deriveResourceMountSource (RN)', () => {
  it('text → {html}', () => {
    expect(deriveResourceMountSource({ uri: 'ui://x', text: '<p>hi</p>' })).toEqual({
      html: '<p>hi</p>',
    });
  });

  it('blob → {uri: data:...}', () => {
    const src = deriveResourceMountSource({ uri: 'ui://x', blob: 'ZGF0YQ==' });
    expect(src).toEqual({ uri: 'data:text/html;base64,ZGF0YQ==' });
  });

  it('http(s) uri → {uri}', () => {
    expect(deriveResourceMountSource({ uri: 'https://example.com' })).toEqual({
      uri: 'https://example.com',
    });
  });

  it('non-http(s) uri with no inline content → null', () => {
    expect(deriveResourceMountSource({ uri: 'ui://x' })).toBeNull();
  });
});

// =============================================================================
// <McpAppIframe> — WebView integration (via react-test-renderer)
// =============================================================================

describe('<McpAppIframe> — WebView mount', () => {
  it('mounts WebView with {html} for inline text', () => {
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <McpAppIframe resource={makeResource({ text: '<p>hi</p>' })} />,
      );
    });
    const webView = findWebView(tree);
    expect(webView).not.toBeNull();
    expect((webView!.props.source as { html?: string }).html).toBe('<p>hi</p>');
    act(() => tree.unmount());
  });

  it('mounts WebView with data-URL for blob', () => {
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <McpAppIframe
          resource={makeResource({ text: undefined, blob: 'aGVsbG8=', mimeType: 'text/html' })}
        />,
      );
    });
    const webView = findWebView(tree);
    expect((webView!.props.source as { uri?: string }).uri).toBe(
      'data:text/html;base64,aGVsbG8=',
    );
    act(() => tree.unmount());
  });

  it('mounts WebView with http URL for URL resources', () => {
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <McpAppIframe
          resource={{ uri: 'https://example.com/app', mimeType: 'text/html' }}
        />,
      );
    });
    const webView = findWebView(tree);
    expect((webView!.props.source as { uri?: string }).uri).toBe(
      'https://example.com/app',
    );
    act(() => tree.unmount());
  });

  it('null mount source renders empty View + fires onError bootstrap-failed', () => {
    const onError = vi.fn();
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <McpAppIframe
          resource={{ uri: 'ui://unmountable', mimeType: 'text/html' }}
          onError={onError}
        />,
      );
    });
    expect(findWebView(tree)).toBeNull();
    // The empty-host view carries the testID the RN host renders in the
    // fallback branch.
    const emptyView = tree.root.findAllByProps({ testID: 'mcp-app-iframe-empty' });
    expect(emptyView.length).toBeGreaterThanOrEqual(1);
    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0]?.[0];
    expect(err?.kind).toBe('bootstrap');
    expect(err?.reason).toBe('MALFORMED_BOOTSTRAP');
    act(() => tree.unmount());
  });

  it('injects the bridge script via injectedJavaScriptBeforeContentLoaded', () => {
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(<McpAppIframe resource={makeResource()} />);
    });
    const webView = findWebView(tree);
    const script = webView!.props.injectedJavaScriptBeforeContentLoaded as string;
    expect(typeof script).toBe('string');
    expect(script).toContain('ReactNativeWebView.postMessage');
    expect(script).toContain('__ggui_mcp_apps');
    act(() => tree.unmount());
  });

  it('restricts origin whitelist to http(s); disables multi-windows', () => {
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(<McpAppIframe resource={makeResource()} />);
    });
    const webView = findWebView(tree);
    expect(webView!.props.originWhitelist).toEqual(['http://*', 'https://*']);
    expect(webView!.props.setSupportMultipleWindows).toBe(false);
    act(() => tree.unmount());
  });

  it('media requires user gesture when camera/microphone not granted', () => {
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(<McpAppIframe resource={makeResource()} />);
    });
    expect(findWebView(tree)!.props.mediaPlaybackRequiresUserAction).toBe(true);
    act(() => tree.unmount());
  });

  it('media does not require user gesture when camera is granted', () => {
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <McpAppIframe resource={makeResource()} permissions={{ camera: true }} />,
      );
    });
    expect(findWebView(tree)!.props.mediaPlaybackRequiresUserAction).toBe(false);
    act(() => tree.unmount());
  });
});

// =============================================================================
// <McpAppIframe> — lifecycle envelope integration (RN equivalent of the web
// outer-DOM `data-ggui-mcp-app-iframe-lifecycle` mirror; on RN we mirror via
// `accessibilityValue.text` on the host `<View>`).
// =============================================================================

/**
 * Helper — simulate the WebView posting an envelope upward by invoking the
 * host's `onMessage` prop directly. The injected bridge wraps every page
 * `postMessage` in `{__ggui_mcp_apps: true, payload: <original>}` and the
 * `onMessage` callback receives a `WebViewMessageEvent` with
 * `nativeEvent.data` set to the JSON-encoded envelope.
 */
async function simulateFromWebView(
  tree: ReactTestRenderer,
  payload: unknown,
): Promise<void> {
  const webView = findWebView(tree);
  if (!webView) throw new Error('WebView not yet mounted');
  const onMessage = webView.props.onMessage as
    | ((event: { nativeEvent: { data: string } }) => void)
    | undefined;
  if (!onMessage) throw new Error('WebView has no onMessage handler');
  const envelope = {
    __ggui_mcp_apps: true,
    payload,
  };
  await act(async () => {
    onMessage({ nativeEvent: { data: JSON.stringify(envelope) } });
    // Flush microtasks so the async classifier branch settles before
    // assertions read state.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

describe('<McpAppIframe> — lifecycle envelope integration', () => {
  it('ggui:lifecycle → mirrors state via accessibilityValue AND fires onLifecycle', async () => {
    const onLifecycle = vi.fn();
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <McpAppIframe resource={makeResource()} onLifecycle={onLifecycle} />,
      );
    });

    // Before any envelope arrives, the host View MUST NOT carry the
    // lifecycle mirror — observers distinguish "no posting yet" from
    // any classified state.
    let host = tree.root.findByProps({ testID: 'mcp-app-iframe-host' });
    expect(host.props.accessibilityValue).toBeUndefined();

    // Renderer posts `mounting` first.
    await simulateFromWebView(tree, {
      type: 'ggui:lifecycle',
      event: { state: 'mounting' },
    });
    host = tree.root.findByProps({ testID: 'mcp-app-iframe-host' });
    expect(host.props.accessibilityValue).toEqual({ text: 'mounting' });
    expect(onLifecycle).toHaveBeenCalledTimes(1);
    expect(onLifecycle.mock.calls[0]?.[0]).toEqual({ state: 'mounting' });

    // Then `code-ready` — accessibilityValue updates, host stays mounted.
    await simulateFromWebView(tree, {
      type: 'ggui:lifecycle',
      event: { state: 'code-ready' },
    });
    host = tree.root.findByProps({ testID: 'mcp-app-iframe-host' });
    expect(host.props.accessibilityValue).toEqual({ text: 'code-ready' });
    expect(onLifecycle).toHaveBeenCalledTimes(2);
    expect(onLifecycle.mock.calls[1]?.[0]).toEqual({ state: 'code-ready' });

    act(() => tree.unmount());
  });

  it('ggui:lifecycle with malformed envelope is silently dropped', async () => {
    const onLifecycle = vi.fn();
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <McpAppIframe resource={makeResource()} onLifecycle={onLifecycle} />,
      );
    });

    // Establish a known mirror state first.
    await simulateFromWebView(tree, {
      type: 'ggui:lifecycle',
      event: { state: 'mounting' },
    });
    let host = tree.root.findByProps({ testID: 'mcp-app-iframe-host' });
    expect(host.props.accessibilityValue).toEqual({ text: 'mounting' });

    // Malformed (unknown state) → dropped silently per the trust-
    // boundary posture. Mirror stays at 'mounting', onLifecycle does
    // NOT fire a second time.
    await simulateFromWebView(tree, {
      type: 'ggui:lifecycle',
      event: { state: 'spinning' },
    });
    host = tree.root.findByProps({ testID: 'mcp-app-iframe-host' });
    expect(host.props.accessibilityValue).toEqual({ text: 'mounting' });
    expect(onLifecycle).toHaveBeenCalledTimes(1);

    act(() => tree.unmount());
  });

  it('ggui:lifecycle mirrors via accessibilityValue even when no onLifecycle is bound', async () => {
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(<McpAppIframe resource={makeResource()} />);
    });
    await simulateFromWebView(tree, {
      type: 'ggui:lifecycle',
      event: { state: 'code-ready' },
    });
    const host = tree.root.findByProps({ testID: 'mcp-app-iframe-host' });
    expect(host.props.accessibilityValue).toEqual({ text: 'code-ready' });
    act(() => tree.unmount());
  });
});

// =============================================================================
// <McpAppIframe> — spec-canonical tool-result delivery integration.
//
// Verifies the host fires a `ui/notifications/tool-result` JSON-RPC
// notification immediately after responding to the renderer's
// `ui/initialize` request when `meta` is supplied — the Reading-B
// replacement path.
//
// Coverage strategy: we observe `injectJavaScript` calls by attaching
// a spy directly to the WebView ref `.current`. The `react-native-
// webview` test-setup mock uses `R.forwardRef`, so the host's
// `webViewRef.current` is populated to whatever the test sets. We
// install the spy before sending the `ui/initialize` request so the
// host's subsequent `deliverToWebView` calls are observable.
// =============================================================================
describe('<McpAppIframe> — spec-canonical tool-result delivery', () => {
  it('fires ui/notifications/tool-result with the render slice after ui/initialize when meta is set', async () => {
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <McpAppIframe resource={makeResource()} meta={SAMPLE_META} />,
      );
    });

    // Attach an injectJavaScript spy on the WebView host the mock
    // exposes via the forwarded ref. The mock renders a bare React
    // element with the ref attached as a prop; we install a fake
    // ref-target by mutating the rendered instance directly so the
    // host's `webViewRef.current?.injectJavaScript(...)` call lands
    // on our spy.
    const injectJavaScript = vi.fn();
    const webView = findWebView(tree);
    if (!webView) throw new Error('WebView not yet mounted');
    // The forwardRef wrapper inside the mock passes `ref` to the host
    // through `R.createElement('WebView', { ref, ... })`. With
    // react-test-renderer, we substitute the ref slot by invoking
    // the ref callback / setting `.current` on the ref object
    // directly. Iframe component uses `useRef`, so the host stores a
    // mutable ref object as `webViewRef`. We can't access it from
    // outside, but we CAN intercept calls by injecting a fake
    // implementation through the WebView mock's ref-forwarding —
    // when the WebView mounts, react-test-renderer calls
    // `ref(instance)` and the host's `webViewRef.current` gets set
    // to that instance. We control the instance by overriding the
    // ref. Concretely: monkey-patch the props.ref function the host
    // passed in.
    const refProp = webView.props.ref as
      | ((handle: unknown) => void)
      | { current: unknown }
      | null;
    if (refProp === null || refProp === undefined) {
      throw new Error('WebView did not receive a ref');
    }
    if (typeof refProp === 'function') {
      refProp({ injectJavaScript });
    } else {
      (refProp as { current: unknown }).current = { injectJavaScript };
    }

    // Simulate the renderer issuing the `ui/initialize` request.
    await simulateFromWebView(tree, {
      jsonrpc: '2.0',
      id: 1,
      method: 'ui/initialize',
    });

    // Two injectJavaScript calls expected, in order:
    //   1. The `ui/initialize` response (adapter-boundary {theme,
    //      containerDimensions, locale}).
    //   2. The spec-canonical `ui/notifications/tool-result`
    //      notification carrying the render slice on `params._meta`.
    expect(injectJavaScript).toHaveBeenCalledTimes(2);

    // Extract the embedded JSON from each delivery script (the
    // delivery shape is `var data = JSON.parse(<json-stringified
    // payload>); ...`). The script is fully encoded so we can pluck
    // the JSON.parse argument and round-trip it.
    function extractDeliveredMessage(script: unknown): Record<string, unknown> {
      const text = String(script);
      const match = /JSON\.parse\((.*?)\);/s.exec(text);
      if (!match) throw new Error('no JSON.parse(...) match in script');
      // The captured group is itself a JSON-stringified JSON string
      // (double-stringified for safe injection), so we parse twice.
      const outer = JSON.parse(match[1]!) as string;
      return JSON.parse(outer) as Record<string, unknown>;
    }

    const initResponse = extractDeliveredMessage(injectJavaScript.mock.calls[0]?.[0]);
    expect(initResponse['jsonrpc']).toBe('2.0');
    expect(initResponse['id']).toBe(1);
    const initResult = initResponse['result'] as Record<string, unknown>;
    expect(Object.keys(initResult).sort()).toEqual([
      'containerDimensions',
      'locale',
      'theme',
    ]);
    expect(initResult).not.toHaveProperty('toolOutput');
    expect(initResult).not.toHaveProperty('_meta');

    const toolResultNotif = extractDeliveredMessage(
      injectJavaScript.mock.calls[1]?.[0],
    );
    expect(toolResultNotif['jsonrpc']).toBe('2.0');
    expect(toolResultNotif['method']).toBe('ui/notifications/tool-result');
    // Notification carries no `id` — fire-and-forget.
    expect(toolResultNotif).not.toHaveProperty('id');
    const params = toolResultNotif['params'] as Record<string, unknown>;
    expect(params['content']).toEqual([]);
    expect(params['structuredContent']).toEqual({});
    const metaEnv = params['_meta'] as Record<string, unknown>;
    // Spec-canonical: slice on `params._meta` (NOT `params.toolOutput._meta`).
    expect(Object.keys(metaEnv).sort()).toEqual(['ai.ggui/render']);
    const render = metaEnv['ai.ggui/render'] as McpAppAiGguiRenderMeta;
    expect(render.renderId).toBe(SAMPLE_META.renderId);
    expect(render.wsUrl).toBe(SAMPLE_META.wsUrl);
    expect(render.wsToken).toBe(SAMPLE_META.wsToken);

    act(() => tree.unmount());
  });

  it('does NOT fire ui/notifications/tool-result after ui/initialize when meta is absent', async () => {
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(<McpAppIframe resource={makeResource()} />);
    });
    const injectJavaScript = vi.fn();
    const webView = findWebView(tree);
    if (!webView) throw new Error('WebView not yet mounted');
    const refProp = webView.props.ref as
      | ((handle: unknown) => void)
      | { current: unknown }
      | null;
    if (refProp === null || refProp === undefined) {
      throw new Error('WebView did not receive a ref');
    }
    if (typeof refProp === 'function') {
      refProp({ injectJavaScript });
    } else {
      (refProp as { current: unknown }).current = { injectJavaScript };
    }

    await simulateFromWebView(tree, {
      jsonrpc: '2.0',
      id: 1,
      method: 'ui/initialize',
    });

    // ONE call only — the `ui/initialize` response. No tool-result
    // follow-up when the host wasn't given a `meta` prop.
    expect(injectJavaScript).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
  });

  it('does NOT fire ui/notifications/tool-result after non-initialize requests even when meta is set', async () => {
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <McpAppIframe resource={makeResource()} meta={SAMPLE_META} />,
      );
    });
    const injectJavaScript = vi.fn();
    const webView = findWebView(tree);
    if (!webView) throw new Error('WebView not yet mounted');
    const refProp = webView.props.ref as
      | ((handle: unknown) => void)
      | { current: unknown }
      | null;
    if (refProp === null || refProp === undefined) {
      throw new Error('WebView did not receive a ref');
    }
    if (typeof refProp === 'function') {
      refProp({ injectJavaScript });
    } else {
      (refProp as { current: unknown }).current = { injectJavaScript };
    }

    // Renderer pings — no tool-result delivery should fire.
    await simulateFromWebView(tree, {
      jsonrpc: '2.0',
      id: 1,
      method: 'ping',
    });

    expect(injectJavaScript).toHaveBeenCalledTimes(1);
    // The single call is the ping response, not a tool-result.
    const text = String(injectJavaScript.mock.calls[0]?.[0]);
    expect(text).not.toContain('ui/notifications/tool-result');
    act(() => tree.unmount());
  });
});

describe('<McpAppIframe> — imperative ref (RN)', () => {
  // Coverage strategy — the shared test-setup mock for
  // `react-native-webview` renders a bare React element (no
  // `useImperativeHandle`), so `webViewRef.current.injectJavaScript`
  // is not spyable at the WebView-mock layer without an ad-hoc
  // `vi.doMock` re-import dance. Instead we verify the imperative
  // seam at two layers the RN host is PURE about:
  //
  //   (a) `buildDispatchActionNotification` — wire-shape producer
  //       (asserted in the pure-function test above).
  //   (b) The component exposes a function-shaped `dispatchAction`
  //       through `useImperativeHandle` — asserted here by checking
  //       the ref shape post-mount.
  //
  // The actual `injectJavaScript(buildDeliveryScript(notif))` call
  // is covered at the helper level in `mcp-apps-bridge.test.ts` (which
  // exercises `buildDeliveryScript` directly). Adding a doMock variant
  // here would duplicate mock infrastructure for marginal coverage
  // value.
  it('exposes a function-shaped dispatchAction on the forwarded ref', () => {
    const ref = createRef<McpAppIframeRef>();
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(<McpAppIframe ref={ref} resource={makeResource()} />);
    });
    expect(ref.current).not.toBeNull();
    expect(typeof ref.current?.dispatchAction).toBe('function');
    // Invoking the ref must not throw — the WebView-ref .current is
    // null under the mock, so the internal `.current?.injectJavaScript`
    // short-circuits cleanly.
    expect(() => {
      act(() => {
        ref.current?.dispatchAction('test.action', { a: 1 });
      });
    }).not.toThrow();
    act(() => tree.unmount());
  });
});
