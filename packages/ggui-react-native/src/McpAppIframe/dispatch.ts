/**
 * Platform-agnostic JSON-RPC dispatch for `<McpAppIframe>` on React
 * Native. Sibling of the web version at
 * `@ggui-ai/react::McpAppIframe/dispatch.ts` — the two ports MUST stay
 * structurally identical. Any protocol-shape change to one lands in
 * both at once.
 *
 * The host responds to:
 *
 *   - `ping` → `{ok: true, pong: true}`.
 *   - `ui/initialize` → `{theme, containerDimensions, locale}` ONLY
 *     — the adapter-boundary rule (no outer-app state leaks).
 *   - `ui/open-link` with http(s) URLs → caller opens externally;
 *     other schemes → reject `unsupported-scheme`.
 *   - `tools/call` → caller-provided handler, or reject
 *     `no-tool-handler` when none.
 *   - any other method → `method_not_supported`.
 *
 * Notifications (no `id`) return `null` — the caller MUST NOT post a
 * response back to the iframe.
 *
 * The `handleHostBridgeRequest` helper in the sibling
 * `components/McpAppsStackItemRenderer.tsx` stays in place for the
 * session-bound legacy host. Both retire together once every consumer
 * has migrated.
 */

import {
  mountViewToMcpAppMeta,
  type McpAppAiGguiMountView,
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
  /**
   * Opt-in first-party bootstrap forwarding.
   *
   * When present, `dispatchHostBridgeRequest`'s `ui/initialize`
   * branch adds `toolOutput._meta.ggui.bootstrap = bootstrap` to the
   * response alongside the existing `theme` / `containerDimensions` /
   * `locale` adapter-boundary fields. The renderer's `parseBootstrap`
   * (`packages/iframe-runtime/src/bootstrap.ts`) reads this exact shape.
   *
   * When absent (default), the response is `{theme,
   * containerDimensions, locale}` only — no `toolOutput`, no `_meta`.
   * Third-party MCP App iframes MUST NOT be given a `bootstrap` here:
   * leaking outer-app state into a generic MCP App's `ui/initialize`
   * response is exactly the adapter-boundary violation the rule
   * exists to prevent.
   *
   * Carrier shape mirrors the wire — the same `McpAppAiGguiMountView`
   * type the server stamps onto the `ggui_push` tool result's
   * `_meta.ggui.bootstrap` ends up here verbatim. No transformation,
   * no per-namespace whitelisting; the host's contract is "thread the
   * forwarded bootstrap through" and that's it.
   */
  readonly bootstrap?: McpAppAiGguiMountView;
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
      // ADAPTER BOUNDARY (default posture). The result carries
      // `{theme, containerDimensions, locale}` ONLY — no outer-app
      // state leaks into the iframe.
      //
      // READING-B EXCEPTION (opt-in via `ctx.bootstrap`). When the
      // host has explicitly threaded a `McpAppAiGguiMountView` for a
      // first-party ggui renderer iframe (see `McpAppIframeProps.
      // bootstrap` JSDoc), augment the result with
      // `toolOutput._meta.ggui.bootstrap = ctx.bootstrap`. The
      // renderer's `parseBootstrap` reads exactly that path. The
      // adapter-boundary rule still applies to every other key —
      // only `_meta.ggui.bootstrap` is forwarded, scoped by the
      // ggui namespace.
      const result: Record<string, unknown> = {
        theme: ctx.theme,
        containerDimensions: ctx.containerDimensions,
        locale: ctx.locale,
      };
      if (ctx.bootstrap !== undefined) {
        result['toolOutput'] = {
          _meta: mountViewToMcpAppMeta(ctx.bootstrap),
        };
      }
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
