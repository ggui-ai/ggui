/**
 * Platform-agnostic JSON-RPC dispatch for `<McpAppIframe>` on React
 * Native — the canonical RN MCP-Apps host primitive. The web side
 * retired its `<McpAppIframe>` in favor of `<AppRenderer>` from
 * `@mcp-ui/client`, which is built around iframes + a two-iframe
 * sandbox-proxy model that has no meaningful WebView equivalent;
 * `<McpAppIframe>` on RN stays as the host primitive for mobile.
 *
 * The host responds to:
 *
 *   - `ping` → `{ok: true, pong: true}`.
 *   - `ui/initialize` → `{theme, containerDimensions, locale}` ONLY
 *     — the adapter-boundary rule (no outer-app state leaks). NEVER
 *     carries `toolOutput._meta` — see "Reading-B retired" note below.
 *   - `ui/open-link` with http(s) URLs → caller opens externally;
 *     other schemes → reject `unsupported-scheme`.
 *   - `tools/call` → caller-provided handler, or reject
 *     `no-tool-handler` when none.
 *   - any other method → `method_not_supported`.
 *
 * Notifications (no `id`) return `null` — the caller MUST NOT post a
 * response back to the iframe.
 *
 * ── Reading-B retired (parity with iframe-runtime Phase 1.19b.3) ─────
 *
 * The legacy "stuff the `ai.ggui/render` slice on `ui/initialize`
 * result.toolOutput._meta" path is retired here. iframe-runtime's
 * App-class adoption means `App.connect()` does NOT expose
 * `result.toolOutput`, so any meta crammed into the initialize
 * response is silently dropped on the renderer side.
 *
 * The spec-canonical delivery channel is now {@link
 * buildToolResultNotification} — a `ui/notifications/tool-result`
 * notification (JSON-RPC) wrapping a `CallToolResult` whose `_meta`
 * carries the single `ai.ggui/render` slice. The McpAppIframe host
 * sends this notification immediately after the
 * `ui/initialize` response when `meta` is supplied, so the renderer's
 * `awaitToolResultMeta` window-message listener (autostart layer) or
 * its App-mediated `toolresult` event catches the meta and boots the
 * render. Wire shape matches what `@mcp-ui/client`'s `<AppRenderer
 * toolResult={...}>` forwards on web.
 *
 * The shared host-role switch (`handleHostBridgeRequest`) lives in the
 * sibling `components/mcp-apps-bridge.ts`; it covers the same methods
 * but bakes in the ggui-server `/mcp-apps/tools-call` proxy URL,
 * whereas this dispatcher leaves `tools/call` to a caller-supplied
 * handler so the iframe stays generic across hosts.
 */

import {
  toMcpAppEnvelope,
  type McpAppAiGguiRenderMeta,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import type {
  McpAppIframeDimensions,
  McpAppIframeProps,
} from './types.js';

export interface HostBridgeRequest {
  readonly jsonrpc?: '2.0';
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

export interface HostBridgeResponse {
  readonly jsonrpc: '2.0';
  readonly id: number | string;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code: number; readonly message: string };
}

export interface HostBridgeNotification {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface HostBridgeContext {
  readonly theme: Readonly<Record<string, string>>;
  readonly locale: string;
  readonly containerDimensions: McpAppIframeDimensions;
  readonly openLink: (url: string) => Promise<void> | void;
  readonly onToolCall?: McpAppIframeProps['onToolCall'];
}

export const DEFAULT_HOST_THEME: Readonly<Record<string, string>> = {
  '--color-primary': '#0284c7',
  '--color-surface': '#ffffff',
  '--color-text': '#111111',
  '--font-family': 'system-ui, -apple-system, sans-serif',
  '--border-radius-md': '8px',
};

function isJsonRpcRequest(value: unknown): value is HostBridgeRequest {
  if (value === null || typeof value !== 'object') return false;
  const v = value as { jsonrpc?: unknown; method?: unknown };
  return v.jsonrpc === '2.0' && typeof v.method === 'string';
}

function paramString(
  params: HostBridgeRequest['params'],
  key: string,
): string {
  if (!params) return '';
  const v = params[key];
  return typeof v === 'string' ? v : '';
}

function paramObject(
  params: HostBridgeRequest['params'],
  key: string,
): Record<string, unknown> {
  if (!params) return {};
  const v = params[key];
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return {};
  return v as Record<string, unknown>;
}

/**
 * Host-role method dispatcher. Returns a JSON-RPC response, or `null`
 * when the request is malformed / a notification. Pure function —
 * testable without a WebView present.
 */
export async function dispatchHostBridgeRequest(
  req: HostBridgeRequest,
  ctx: HostBridgeContext,
): Promise<HostBridgeResponse | null> {
  if (!isJsonRpcRequest(req)) return null;
  if (req.id === undefined) return null;

  const id = req.id;

  switch (req.method) {
    case 'ping': {
      return { jsonrpc: '2.0', id, result: { ok: true, pong: true } };
    }
    case 'ui/initialize': {
      // ADAPTER BOUNDARY. The result carries `{theme,
      // containerDimensions, locale}` ONLY — no outer-app state
      // leaks into the iframe. First-party `ai.ggui/render` meta is
      // delivered via the separate spec-canonical
      // `ui/notifications/tool-result` notification (see
      // {@link buildToolResultNotification}), NOT via this initialize
      // response.
      const result: Record<string, unknown> = {
        theme: ctx.theme,
        containerDimensions: ctx.containerDimensions,
        locale: ctx.locale,
      };
      return { jsonrpc: '2.0', id, result };
    }
    case 'ui/open-link': {
      const url = paramString(req.params, 'url');
      if (!/^https?:\/\//i.test(url)) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: 'unsupported-scheme' },
        };
      }
      try {
        await ctx.openLink(url);
        return { jsonrpc: '2.0', id, result: { opened: true } };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32000,
            message: `open_link_failed: ${String(err)}`,
          },
        };
      }
    }
    case 'tools/call': {
      if (ctx.onToolCall === undefined) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: 'no-tool-handler' },
        };
      }
      const tool = paramString(req.params, 'name');
      if (tool.length === 0) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: 'tools/call requires params.name' },
        };
      }
      const args = paramObject(req.params, 'arguments');
      try {
        const result: unknown = await ctx.onToolCall(tool, args);
        const wrapped: Record<string, unknown> =
          result !== null && typeof result === 'object' && !Array.isArray(result)
            ? (result as Record<string, unknown>)
            : { value: result };
        return { jsonrpc: '2.0', id, result: wrapped };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32000,
            message: `tool_call_failed: ${String(err)}`,
          },
        };
      }
    }
    default: {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: 'method_not_supported' },
      };
    }
  }
}

// =============================================================================
// Renderer → host envelope classification
// =============================================================================

export type RendererEnvelopeTag =
  | 'bootstrap-failed'
  | 'protocol-error'
  | 'observability'
  | 'lifecycle'
  | 'upgrade-required'
  | 'jsonrpc'
  | 'unknown';

/**
 * Classify a raw message payload received from the WebView. The
 * platform host routes each tag to the matching callback prop.
 */
export function classifyRendererEnvelope(data: unknown): RendererEnvelopeTag {
  if (data === null || typeof data !== 'object') return 'unknown';
  const d = data as { type?: unknown; jsonrpc?: unknown; method?: unknown };
  if (typeof d.type === 'string') {
    switch (d.type) {
      case 'ggui:bootstrap-failed':
        return 'bootstrap-failed';
      case 'ggui:protocol-error':
        return 'protocol-error';
      case 'ggui:observe':
        return 'observability';
      case 'ggui:lifecycle':
        return 'lifecycle';
      case 'ggui:upgrade-required':
        return 'upgrade-required';
      default:
        break;
    }
  }
  if (d.jsonrpc === '2.0' && typeof d.method === 'string') return 'jsonrpc';
  return 'unknown';
}

export function buildDispatchActionNotification(
  name: string,
  data: unknown,
): HostBridgeNotification {
  return {
    jsonrpc: '2.0',
    method: name,
    params: { data },
  };
}

export function buildResourceTeardownNotification(): HostBridgeNotification {
  return {
    jsonrpc: '2.0',
    method: 'ui/resource-teardown',
    params: { reason: 'host_unmount' },
  };
}

/**
 * Build a spec-canonical `ui/notifications/tool-result` JSON-RPC
 * notification carrying the `ai.ggui/render` slice on `params._meta`.
 *
 * Wire shape:
 * ```
 * {
 *   jsonrpc: '2.0',
 *   method: 'ui/notifications/tool-result',
 *   params: {                       // CallToolResult per MCP spec
 *     content: [],
 *     structuredContent: {},
 *     _meta: {
 *       'ai.ggui/render': { renderId, appId, runtimeUrl, ... },
 *     },
 *   },
 * }
 * ```
 *
 * Mirrors what `@mcp-ui/client`'s `<AppRenderer toolResult={...}>`
 * forwards to its inner iframe on web (per MCP-Apps SEP-1865 and
 * `McpUiToolResultNotification` in
 * `@modelcontextprotocol/ext-apps/spec.types`). The renderer's
 * `parseMetaFromToolResult` extractor
 * (`packages/iframe-runtime/src/meta-parse.ts`) reads `params._meta`
 * exactly.
 *
 * Sent immediately after the `ui/initialize` response when the host
 * was given a `meta` prop, so the renderer's pre-handshake
 * `awaitToolResultMeta` listener (Tier 2 in `bootSequence`) catches
 * it and boots the render.
 */
export function buildToolResultNotification(
  meta: McpAppAiGguiRenderMeta,
): HostBridgeNotification {
  return {
    jsonrpc: '2.0',
    method: 'ui/notifications/tool-result',
    params: {
      content: [],
      structuredContent: {},
      _meta: toMcpAppEnvelope(meta),
    },
  };
}

// =============================================================================
// Resource → WebView mount-source derivation
// =============================================================================

/**
 * RN WebView `source` shape. Matches react-native-webview's `source`
 * prop.
 */
export type ResourceWebViewSource =
  | { readonly html: string; readonly baseUrl?: string }
  | { readonly uri: string };

/**
 * Compute the WebView `source` from an MCP Apps `ResourceContents`.
 * Mirrors the web version's `deriveResourceMountSource` decision tree:
 *
 *   1. `text` present → `source={{html: text}}` (inline HTML;
 *      opaque origin, safest path).
 *   2. `blob` + `mimeType` → data-URL fallback (native WebView treats
 *      this as a top-level URL load). Opaque origin too.
 *   3. Else → `source={{uri}}` IF `uri` is http(s); else `null`
 *      (caller renders an empty WebView + emits a bootstrap failure).
 */
export function deriveResourceMountSource(resource: {
  readonly uri: string;
  readonly mimeType?: string;
  readonly text?: string;
  readonly blob?: string;
}): ResourceWebViewSource | null {
  if (typeof resource.text === 'string' && resource.text.length > 0) {
    return { html: resource.text };
  }
  if (typeof resource.blob === 'string' && resource.blob.length > 0) {
    const mime =
      typeof resource.mimeType === 'string' && resource.mimeType.length > 0
        ? resource.mimeType
        : 'text/html';
    return { uri: `data:${mime};base64,${resource.blob}` };
  }
  if (typeof resource.uri === 'string' && /^https?:\/\//i.test(resource.uri)) {
    return { uri: resource.uri };
  }
  return null;
}
