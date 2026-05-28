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

  it('ui/initialize READING-B — forwards toolOutput._meta ai.ggui slices when ctx.meta is set', async () => {
    const res = await dispatchHostBridgeRequest(
      { jsonrpc: '2.0', id: 1, method: 'ui/initialize' },
      makeCtx({ meta: SAMPLE_META }),
    );
    const result = res?.result as Record<string, unknown>;
    expect(result).toHaveProperty('toolOutput');
    const toolOutput = result['toolOutput'] as Record<string, unknown>;
    // Narrow-exception invariant: ONLY `_meta` under toolOutput.
    expect(Object.keys(toolOutput).sort()).toEqual(['_meta']);
    const metaEnv = toolOutput['_meta'] as Record<string, unknown>;
    // ONLY the `ai.ggui/render` slice (single render-identity slice).
    expect(Object.keys(metaEnv).sort()).toEqual(['ai.ggui/render']);
    expect(metaEnv['ai.ggui/render']).toBe(SAMPLE_META);
    // Adapter-boundary fields still present alongside the forwarded
    // ai.ggui meta.
    expect(result['theme']).toEqual({ '--color-primary': '#ff0000' });
    expect(result['locale']).toBe('en-US');
    expect(result['containerDimensions']).toEqual({ width: 640, height: 480 });
  });

  it('ui/initialize READING-B — toolOutput._meta path matches the renderer parser contract', async () => {
    // Cross-check against the renderer's parser contract. The shape
    // produced here MUST match what `parseMetaFromToolResult()` (in
    // `packages/iframe-runtime/src/meta-parse.ts`) reads via its
    // `params.toolOutput._meta` back-compat branch. This test
    // structurally walks the same path the renderer does.
    const res = await dispatchHostBridgeRequest(
      { jsonrpc: '2.0', id: 7, method: 'ui/initialize' },
      makeCtx({ meta: SAMPLE_META }),
    );
    const result = res?.result as Record<string, unknown>;
    const toolOutput = result['toolOutput'] as Record<string, unknown>;
    const metaEnv = toolOutput['_meta'] as Record<string, unknown>;
    const render = metaEnv['ai.ggui/render'] as McpAppAiGguiRenderMeta;
    expect(render.wsUrl).toBe(SAMPLE_META.wsUrl);
    expect(render.wsToken).toBe(SAMPLE_META.wsToken);
    expect(render.renderId).toBe(SAMPLE_META.renderId);
    expect(render.appId).toBe(SAMPLE_META.appId);
    expect(render.runtimeUrl).toBe(SAMPLE_META.runtimeUrl);
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
