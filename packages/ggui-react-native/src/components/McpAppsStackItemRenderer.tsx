/**
 * Renderer for `McpAppsStackItem` on React Native — the embedded
 * third-party MCP Apps iframe variant of a session stack entry.
 *
 * Two platform paths, both driven by the same conceptual host-role
 * bridge the web SDK uses (`ui/initialize`, `tools/call`, `ping`,
 * `ui/open-link`, `ui/resource-teardown`). Server trust boundaries
 * stay at the `/mcp-apps/tools-call` + `/mcp-apps/resource` proxy
 * routes — the RN bridge forwards only.
 *
 *   - **Web (Expo Web, Platform.OS === 'web')**: renders an iframe
 *     pointing at the ggui server's `/mcp-apps/resource` proxy route
 *     with the full postMessage host bridge. Mirrors the
 *     `@ggui-ai/react` web renderer.
 *   - **Native (iOS / Android)**: renders a `react-native-webview`
 *     loading the same proxy URL, with a minimal injected shim that
 *     aliases `window.parent.postMessage` onto
 *     `window.ReactNativeWebView.postMessage`. RN side receives
 *     outbound JSON-RPC via `onMessage`, handles it with the SAME
 *     switch as web, and injects responses back into the WebView via
 *     `injectJavaScript` that synthesizes `MessageEvent`s on `window`.
 *
 * Adapter boundary rule — ENFORCED on both paths:
 *   - Lifecycle messages from the embedded view do NOT mutate outer
 *     ggui session state, actionSpec, streamSpec, or any core
 *     contract.
 *   - Everything the view can do reduces to: (a) self-render, and
 *     (b) call source-server tools through the server-side gate via
 *     the proxy route. No side channels into the outer ggui session.
 */

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Linking, Platform, View } from 'react-native';
import WebView, {
  type WebView as WebViewType,
  type WebViewMessageEvent,
} from 'react-native-webview';
import type { McpAppsStackItem } from '@ggui-ai/protocol/integrations/mcp-apps';

/**
 * @deprecated Session-bound legacy host — consumes a `McpAppsStackItem`
 * and routes every `tools/call` through the ggui server's
 * `/mcp-apps/tools-call` proxy. Superseded by `<McpAppIframe>`
 * (exported from the root `@ggui-ai/react-native` barrel), which is a
 * GENERIC MCP Apps host: any host app can render ANY MCP Apps-
 * conformant resource through a caller-provided `onToolCall`
 * callback, with zero ggui-specific coupling.
 *
 * This component is retired once every consumer has migrated. Do NOT
 * add new callers — reach for `<McpAppIframe>` instead.
 */
export interface McpAppsStackItemRendererProps {
  /** Discriminator already narrowed to the mcpApps variant. */
  readonly stackItem: McpAppsStackItem;
  /** Session id the stack item belongs to — threaded into the proxy URL. */
  readonly sessionId: string;
  /**
   * Base URL of the ggui server (origin). Appended with
   * `/mcp-apps/resource` + `/mcp-apps/tools-call`. No trailing slash.
   * Defaults to same-origin empty string on web. On native this MUST
   * be an absolute http(s) URL — WebView cannot resolve a relative
   * `src` against an implicit origin.
   */
  readonly serverBaseUrl?: string;
  /** Optional theme override passed in `ui/initialize` context. */
  readonly theme?: Record<string, string>;
  /** Optional locale passed in `ui/initialize` context. */
  readonly locale?: string;
  /** Called when the host explicitly rejects or cannot render this variant. */
  readonly onError?: (err: Error) => void;
}

interface JsonRpcRequest {
  jsonrpc?: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

/** Default permissive-but-safe theme parroted to views that don't override. */
const DEFAULT_THEME: Record<string, string> = {
  '--color-primary': '#0284c7',
  '--color-surface': '#ffffff',
  '--color-text': '#111111',
  '--font-family': 'system-ui, -apple-system, sans-serif',
  '--border-radius-md': '8px',
};

// =============================================================================
// Shared host-role switch
// =============================================================================
//
// Both the web iframe bridge and the native WebView bridge compute the
// response to an embedded view's JSON-RPC request using this function.
// Keeping one switch keeps the web/native bridges conceptually identical
// — the transports differ, the protocol surface does not.

export interface HostBridgeContext {
  readonly sessionId: string;
  readonly stackItem: McpAppsStackItem;
  readonly toolsCallUrl: string;
  readonly theme?: Record<string, string>;
  readonly locale?: string;
  readonly containerDimensions?: McpAppsStackItem['containerDimensions'];
}

/**
 * Shared host-role method dispatcher. Returns a JSON-RPC response or
 * `null` when the request is a malformed / untrusted frame the host
 * should drop silently (no response).
 *
 * Exported for test coverage; production callers come through the web
 * iframe listener or the native `onMessage` handler in this module.
 */
export async function handleHostBridgeRequest(
  req: JsonRpcRequest,
  ctx: HostBridgeContext,
): Promise<JsonRpcResponse | null> {
  if (!req || typeof req !== 'object') return null;
  if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') return null;
  // Notifications (no `id`) get no response — they're fire-and-forget.
  // Server-side enforcement never lives on notifications; this is
  // effectively the only place we short-circuit.
  const id = req.id;

  switch (req.method) {
    case 'ping': {
      return {
        jsonrpc: '2.0',
        id: id ?? 0,
        result: { pong: true },
      };
    }
    case 'ui/initialize': {
      return {
        jsonrpc: '2.0',
        id: id ?? 0,
        result: {
          theme: ctx.theme ?? DEFAULT_THEME,
          containerDimensions: ctx.containerDimensions ?? {},
          locale:
            ctx.locale ??
            (typeof navigator !== 'undefined' ? navigator.language : 'en-US'),
          // Adapter boundary — NO outer session state leaks here.
        },
      };
    }
    case 'ui/open-link': {
      // iframe asks the host to open a URL out-of-band (system browser
      // on native, new tab on web). ENFORCEMENT stays at the proxy —
      // this method does NOT call any MCP tool and does NOT carry
      // credentials; it's a platform-level link hand-off.
      const url = typeof req.params?.url === 'string' ? req.params.url : '';
      // Validate scheme. Anything other than http(s) is rejected so an
      // iframe can't trick the host into opening `file://`, `javascript:`,
      // arbitrary URI schemes, etc.
      if (!/^https?:\/\//i.test(url)) {
        return {
          jsonrpc: '2.0',
          id: id ?? 0,
          error: { code: -32602, message: 'ui/open-link requires http(s) url' },
        };
      }
      try {
        if (Platform.OS === 'web') {
          if (typeof window !== 'undefined') {
            window.open(url, '_blank', 'noopener,noreferrer');
          }
        } else {
          await Linking.openURL(url);
        }
        return { jsonrpc: '2.0', id: id ?? 0, result: { opened: true } };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id: id ?? 0,
          error: { code: -32000, message: `open_link_failed: ${String(err)}` },
        };
      }
    }
    case 'tools/call': {
      const tool = typeof req.params?.name === 'string' ? req.params.name : '';
      const args =
        req.params?.arguments && typeof req.params.arguments === 'object'
          ? (req.params.arguments as Record<string, unknown>)
          : {};
      if (!tool) {
        return {
          jsonrpc: '2.0',
          id: id ?? 0,
          error: { code: -32602, message: 'tools/call requires params.name' },
        };
      }
      try {
        const resp = await fetch(ctx.toolsCallUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session: ctx.sessionId,
            item: ctx.stackItem.id,
            tool,
            arguments: args,
          }),
        });
        if (!resp.ok) {
          const body = (await resp.json().catch(() => ({}))) as {
            error?: string;
          };
          return {
            jsonrpc: '2.0',
            id: id ?? 0,
            error: {
              code: resp.status === 403 ? -32003 : -32000,
              message: body.error ?? `proxy_error_${resp.status}`,
            },
          };
        }
        const result = (await resp.json()) as Record<string, unknown>;
        return { jsonrpc: '2.0', id: id ?? 0, result };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id: id ?? 0,
          error: {
            code: -32000,
            message: `proxy_fetch_failed: ${String(err)}`,
          },
        };
      }
    }
    default: {
      return {
        jsonrpc: '2.0',
        id: id ?? 0,
        error: { code: -32601, message: 'method_not_supported' },
      };
    }
  }
}

// =============================================================================
// Native WebView bridge
// =============================================================================
//
// The injected shim aliases `window.parent.postMessage` onto
// `window.ReactNativeWebView.postMessage` so MCP Apps pages authored
// against the iframe-host contract work unchanged in a top-level
// WebView (where `window.parent === window`).
//
// Wire format — wrap the original payload so the RN side can
// distinguish MCP Apps traffic from other message events the embedded
// page might legitimately generate.
export const NATIVE_BRIDGE_ENVELOPE_KEY = '__ggui_mcp_apps';

/** Script injected BEFORE the page's own scripts run. */
export function buildInjectedBridgeScript(): string {
  // The `true;` trailer is required by react-native-webview on iOS for
  // injected strings; without it iOS's JS runtime returns an `undefined`
  // result that confuses the loader.
  return `
(function() {
  try {
    if (window.__gguiMcpAppsBridge) return;
    window.__gguiMcpAppsBridge = { version: 1 };

    function forward(msg) {
      try {
        if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            ${JSON.stringify(NATIVE_BRIDGE_ENVELOPE_KEY)}: true,
            payload: msg,
          }));
        }
      } catch (_e) {}
    }

    // Intercept page → host posts.
    //
    // MCP Apps hosted as iframes use \`window.parent.postMessage(msg, '*')\`.
    // Inside react-native-webview \`window.parent === window\`, so calls
    // hit \`window.postMessage\`. Override it to forward to the RN bridge
    // instead of firing a same-window message event.
    var origPostMessage = window.postMessage;
    window.postMessage = function(data /*, targetOrigin */) {
      forward(data);
    };
    // Explicit \`parent.postMessage\` aliasing — some engines reify
    // \`window.parent\` lazily, so overriding it on \`window\` is the
    // canonical safety net.
    try {
      Object.defineProperty(window, 'parent', {
        configurable: true,
        get: function() {
          return { postMessage: forward };
        },
      });
    } catch (_e) {
      // If \`parent\` is non-configurable on this engine, leave the
      // \`window.postMessage\` override in place — it covers the
      // \`window.parent === window\` loopback for us.
    }

    // Mark that the shim loaded; tests and diagnostics may read this.
    window.__gguiMcpAppsBridge.ready = true;
  } catch (_e) {}
})();
true;
`;
}

/**
 * Build a script that delivers a host → WebView JSON-RPC message via a
 * synthesized `MessageEvent` on `window`. Escaped for safe injection —
 * every caller-controlled string lands inside a JSON.parse'd literal,
 * never as a JS identifier.
 */
export function buildDeliveryScript(
  message: JsonRpcResponse | JsonRpcNotification,
): string {
  // JSON.stringify produces valid JS when re-embedded as the argument
  // to JSON.parse. This is the canonical safe-injection pattern for
  // WebView.injectJavaScript — no string concatenation of untrusted
  // fields into executable JS.
  const json = JSON.stringify(JSON.stringify(message));
  return `
(function() {
  try {
    var data = JSON.parse(${json});
    var ev = new MessageEvent('message', { data: data, source: window.parent });
    window.dispatchEvent(ev);
  } catch (_e) {}
})();
true;
`;
}

function NativeWebViewMcpAppsRenderer({
  stackItem,
  sessionId,
  serverBaseUrl = '',
  theme,
  locale,
  onError,
}: McpAppsStackItemRendererProps): React.JSX.Element {
  const webViewRef = useRef<WebViewType | null>(null);

  const resourceUrl = useMemo(() => {
    const base = serverBaseUrl.replace(/\/$/, '');
    const qs = new URLSearchParams({ session: sessionId, item: stackItem.id });
    return `${base}/mcp-apps/resource?${qs.toString()}`;
  }, [serverBaseUrl, sessionId, stackItem.id]);

  const toolsCallUrl = useMemo(
    () => `${serverBaseUrl.replace(/\/$/, '')}/mcp-apps/tools-call`,
    [serverBaseUrl],
  );

  const containerDimensions = stackItem.containerDimensions;
  const ctxRef = useRef<HostBridgeContext>({
    sessionId,
    stackItem,
    toolsCallUrl,
    ...(theme !== undefined ? { theme } : {}),
    ...(locale !== undefined ? { locale } : {}),
    ...(containerDimensions !== undefined ? { containerDimensions } : {}),
  });
  useEffect(() => {
    ctxRef.current = {
      sessionId,
      stackItem,
      toolsCallUrl,
      ...(theme !== undefined ? { theme } : {}),
      ...(locale !== undefined ? { locale } : {}),
      ...(containerDimensions !== undefined ? { containerDimensions } : {}),
    };
  }, [sessionId, stackItem, toolsCallUrl, theme, locale, containerDimensions]);

  const injectedScript = useMemo(() => buildInjectedBridgeScript(), []);

  const deliverToWebView = useCallback(
    (msg: JsonRpcResponse | JsonRpcNotification) => {
      webViewRef.current?.injectJavaScript(buildDeliveryScript(msg));
    },
    [],
  );

  const handleMessage = useCallback(
    async (event: WebViewMessageEvent) => {
      const raw = event.nativeEvent.data;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== 'object') return;
      const env = parsed as Record<string, unknown>;
      if (env[NATIVE_BRIDGE_ENVELOPE_KEY] !== true) return;
      const req = env.payload as JsonRpcRequest | undefined;
      if (!req || typeof req !== 'object') return;
      const response = await handleHostBridgeRequest(req, ctxRef.current);
      if (response) deliverToWebView(response);
    },
    [deliverToWebView],
  );

  // Teardown notification on unmount. We send it via `injectJavaScript`
  // before the WebView is unmounted — matches the web SDK's ref-callback
  // detach pattern. react-native-webview in practice still has a live
  // JS context during the effect cleanup phase.
  useEffect(() => {
    const webView = webViewRef.current;
    return () => {
      webView?.injectJavaScript(
        buildDeliveryScript({
          jsonrpc: '2.0',
          method: 'ui/resource-teardown',
          params: { reason: 'host_unmount' },
        }),
      );
    };
  }, []);

  const dims = containerDimensions ?? {};

  return (
    <View
      testID="mcp-apps-native-host"
      style={{
        width: dims.width ?? '100%',
        height: dims.height ?? 480,
        maxWidth: dims.maxWidth,
        maxHeight: dims.maxHeight,
        borderWidth: 1,
        borderColor: '#e5e5e5',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      <WebView
        ref={webViewRef}
        testID="mcp-apps-webview"
        source={{ uri: resourceUrl }}
        originWhitelist={['http://*', 'https://*']}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        setSupportMultipleWindows={false}
        mediaPlaybackRequiresUserAction={true}
        injectedJavaScriptBeforeContentLoaded={injectedScript}
        onMessage={handleMessage}
        onError={(e: unknown) => {
          const err = e instanceof Error ? e : new Error(String(e));
          onError?.(err);
        }}
      />
    </View>
  );
}

// =============================================================================
// Web iframe bridge (unchanged behavior, refactored onto the shared switch)
// =============================================================================

function WebIframeMcpAppsRenderer({
  stackItem,
  sessionId,
  serverBaseUrl = '',
  theme,
  locale,
}: McpAppsStackItemRendererProps): React.JSX.Element {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const iframeWindowRef = useRef<Window | null>(null);

  const resourceUrl = useMemo(() => {
    const base = serverBaseUrl.replace(/\/$/, '');
    const qs = new URLSearchParams({ session: sessionId, item: stackItem.id });
    return `${base}/mcp-apps/resource?${qs.toString()}`;
  }, [serverBaseUrl, sessionId, stackItem.id]);

  const toolsCallUrl = useMemo(
    () => `${serverBaseUrl.replace(/\/$/, '')}/mcp-apps/tools-call`,
    [serverBaseUrl],
  );

  const containerDimensions = stackItem.containerDimensions;
  const dims = useMemo(
    () => ({
      width: stackItem.containerDimensions?.width,
      height: stackItem.containerDimensions?.height,
      maxWidth: stackItem.containerDimensions?.maxWidth,
      maxHeight: stackItem.containerDimensions?.maxHeight,
    }),
    [stackItem.containerDimensions],
  );

  const ctxRef = useRef<HostBridgeContext>({
    sessionId,
    stackItem,
    toolsCallUrl,
    ...(theme !== undefined ? { theme } : {}),
    ...(locale !== undefined ? { locale } : {}),
    ...(containerDimensions !== undefined ? { containerDimensions } : {}),
  });
  useEffect(() => {
    ctxRef.current = {
      sessionId,
      stackItem,
      toolsCallUrl,
      ...(theme !== undefined ? { theme } : {}),
      ...(locale !== undefined ? { locale } : {}),
      ...(containerDimensions !== undefined ? { containerDimensions } : {}),
    };
  }, [sessionId, stackItem, toolsCallUrl, theme, locale, containerDimensions]);

  const handleMessage = useCallback(async (ev: MessageEvent) => {
    const iframe = iframeRef.current;
    if (!iframe || ev.source !== iframe.contentWindow) return;
    const response = await handleHostBridgeRequest(
      ev.data as JsonRpcRequest,
      ctxRef.current,
    );
    if (response) iframe.contentWindow?.postMessage(response, '*');
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [handleMessage]);

  const sandbox = useMemo(() => ['allow-scripts', 'allow-forms'].join(' '), []);

  const allow = useMemo(() => {
    const perms = stackItem.permissions;
    if (!perms) return undefined;
    const parts: string[] = [];
    if (perms.camera) parts.push("camera 'self'");
    if (perms.microphone) parts.push("microphone 'self'");
    if (perms.geolocation) parts.push("geolocation 'self'");
    if (perms.clipboardWrite) parts.push("clipboard-write 'self'");
    return parts.length > 0 ? parts.join('; ') : undefined;
  }, [stackItem.permissions]);

  return (
    <iframe
      ref={(el) => {
        if (el) {
          iframeRef.current = el;
          iframeWindowRef.current = el.contentWindow;
        } else {
          const iframeWindow = iframeWindowRef.current;
          iframeWindow?.postMessage(
            {
              jsonrpc: '2.0',
              method: 'ui/resource-teardown',
              params: { reason: 'host_unmount' },
            },
            '*',
          );
          iframeRef.current = null;
          iframeWindowRef.current = null;
        }
      }}
      data-ggui-mcp-apps="iframe"
      data-ggui-stack-item-id={stackItem.id}
      data-ggui-connector-id={stackItem.source.connectorId}
      src={resourceUrl}
      title={stackItem.description ?? 'MCP App'}
      sandbox={sandbox}
      {...(allow ? { allow } : {})}
      style={{
        width: dims.width ?? '100%',
        height: dims.height ?? 480,
        maxWidth: dims.maxWidth ?? '100%',
        maxHeight: dims.maxHeight ?? undefined,
        border: '1px solid #e5e5e5',
        borderRadius: 8,
        display: 'block',
      }}
    />
  );
}

/**
 * @deprecated Prefer `<McpAppIframe>` from `@ggui-ai/react-native` for
 * any new code — a generic MCP Apps iframe host with no ggui-server
 * coupling. See {@link McpAppsStackItemRendererProps} for the
 * retirement context.
 */
export function McpAppsStackItemRenderer(
  props: McpAppsStackItemRendererProps,
): React.JSX.Element {
  if (Platform.OS === 'web') {
    return <WebIframeMcpAppsRenderer {...props} />;
  }
  return <NativeWebViewMcpAppsRenderer {...props} />;
}
