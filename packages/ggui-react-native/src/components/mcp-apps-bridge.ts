/**
 * Generic MCP-Apps host-role bridge helpers — the transport-agnostic
 * JSON-RPC dispatcher plus the native WebView shim builders.
 *
 * Extracted from the (now-deleted) `McpAppsRenderRenderer` component
 * so the spec-canonical `<McpAppIframe>` can still reuse the bridge
 * surface without dragging in the render-bound legacy renderer.
 *
 * Both transports — the web iframe postMessage bridge and the native
 * `react-native-webview` `onMessage`/`injectJavaScript` bridge —
 * compute responses to embedded views' JSON-RPC requests via the
 * single {@link handleHostBridgeRequest} switch. Keeping one dispatcher
 * keeps the protocol surface identical across platforms; the
 * transports differ, the methods do not.
 *
 * Adapter boundary rule — ENFORCED:
 *   - Lifecycle messages from the embedded view do NOT mutate outer
 *     ggui render state, actionSpec, streamSpec, or any core contract.
 *   - Everything the view can do reduces to (a) self-render, and
 *     (b) call source-server tools through the ggui server's
 *     `/mcp-apps/tools-call` proxy. No side channels.
 */

import { Linking, Platform } from 'react-native';
import type { McpAppsRender } from '@ggui-ai/protocol/integrations/mcp-apps';

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

export interface HostBridgeContext {
  readonly renderId: string;
  readonly render: McpAppsRender;
  readonly toolsCallUrl: string;
  readonly theme?: Record<string, string>;
  readonly locale?: string;
  readonly containerDimensions?: McpAppsRender['containerDimensions'];
}

/**
 * Shared host-role method dispatcher. Returns a JSON-RPC response or
 * `null` when the request is a malformed / untrusted frame the host
 * should drop silently (no response).
 *
 * Exported for test coverage; production callers come through the web
 * iframe listener or the native `onMessage` handler in
 * {@link McpAppIframe}.
 */
export async function handleHostBridgeRequest(
  req: JsonRpcRequest,
  ctx: HostBridgeContext,
): Promise<JsonRpcResponse | null> {
  if (!req || typeof req !== 'object') return null;
  if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') return null;
  // Notifications (no `id`) get no response — they're fire-and-forget.
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
          // Adapter boundary — NO outer render state leaks here.
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
            render: ctx.renderId,
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
