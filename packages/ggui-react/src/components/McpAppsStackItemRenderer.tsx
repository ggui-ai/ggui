/**
 * Renderer for `McpAppsStackItem` — the embedded third-party MCP Apps
 * iframe variant of a session stack entry.
 *
 * Responsibilities:
 *   1. Mount a sandboxed iframe whose `src` points at the ggui server's
 *      MCP Apps resource proxy route (the browser CANNOT resolve
 *      `ui://` URIs directly — the server fetches via `resources/read`
 *      and serves HTML over HTTPS).
 *   2. Play the MCP Apps HOST role for the embedded iframe via
 *      `postMessage` JSON-RPC:
 *        - `ui/initialize` → respond with minimal context (theme +
 *          containerDimensions + locale).
 *        - `tools/call` → forward to the ggui server's
 *          `/mcp-apps/tools-call` endpoint. The server enforces source
 *          connector scoping + `_meta.ui.visibility: ['app']`.
 *        - `resources/read` → not yet supported; respond with
 *          `method_not_supported` so iframes aren't confused.
 *   3. On unmount (the ggui session retiring the stack item, or the
 *      whole session closing), send a host-initiated JSON-RPC
 *      notification `ui/resource-teardown` to the iframe BEFORE it is
 *      removed from the DOM. Gives the embedded app a chance to
 *      persist state / release resources cleanly. Notification (no
 *      `id`) — the iframe is about to vanish so no response is
 *      expected.
 *
 * Adapter boundary rule — ENFORCED:
 *   - MCP Apps lifecycle messages from the iframe do NOT mutate ggui
 *     session state, actionSpec, streamSpec, or any core ggui contract.
 *   - Everything the iframe can do reduces to: (a) self-render, and
 *     (b) call source-server tools through the server-side visibility
 *     gate. No side channels into the outer ggui session.
 *
 * Not yet supported:
 *   - `ui/request-display-mode` (fullscreen / pip) — V1 is inline-only.
 *   - `ui/update-model-context` — defers to a later channel-bridging
 *     doctrine decision.
 *   - `ui/notifications/message` fan-out to other UI surfaces.
 *   - Resource-hash verification on the client side (server does it).
 */

import { useEffect, useMemo, useRef } from 'react';
import type { McpAppsStackItem } from '@ggui-ai/protocol/integrations/mcp-apps';

/**
 * @deprecated Session-bound legacy host — consumes a `McpAppsStackItem`
 * and routes every `tools/call` through the ggui server's
 * `/mcp-apps/tools-call` proxy. Superseded by `<McpAppIframe>`
 * (exported from the root `@ggui-ai/react` barrel), which is a
 * GENERIC MCP Apps host: any host app can render ANY MCP Apps-
 * conformant resource through a caller-provided `onToolCall`
 * callback, with zero ggui-specific coupling.
 *
 * This component is retired once every consumer has migrated. Do NOT
 * add new callers — reach for `<McpAppIframe>` instead.
 */
export interface McpAppsStackItemRendererProps {
  /** The stack item to render. Discriminator already narrowed to mcpApps. */
  readonly stackItem: McpAppsStackItem;
  /** Session id the stack item belongs to — threaded into the proxy URL. */
  readonly sessionId: string;
  /**
   * Base URL of the ggui server (origin). The component appends
   * `/mcp-apps/resource` + `/mcp-apps/tools-call` to this. Should
   * NOT have a trailing slash. Defaults to same-origin (empty).
   */
  readonly serverBaseUrl?: string;
  /**
   * Optional theme override for the `ui/initialize` context. Defaults
   * to a minimal neutral theme when absent.
   */
  readonly theme?: Record<string, string>;
  /**
   * Optional locale string passed in the `ui/initialize` context.
   * Defaults to `navigator.language` when available.
   */
  readonly locale?: string;
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

/** Default permissive-but-safe theme for iframes that don't override. */
const DEFAULT_THEME: Record<string, string> = {
  '--color-primary': '#0284c7',
  '--color-surface': '#ffffff',
  '--color-text': '#111111',
  '--font-family': 'system-ui, -apple-system, sans-serif',
  '--border-radius-md': '8px',
};

/**
 * @deprecated Prefer `<McpAppIframe>` from `@ggui-ai/react` for any new
 * code — a generic MCP Apps iframe host with no ggui-server coupling.
 * See {@link McpAppsStackItemRendererProps} for the retirement
 * context.
 */
export function McpAppsStackItemRenderer({
  stackItem,
  sessionId,
  serverBaseUrl = '',
  theme,
  locale,
}: McpAppsStackItemRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  /**
   * Separate cached reference to the iframe's contentWindow. We capture
   * it via the ref callback the moment React attaches the iframe, and
   * keep the reference across the component's lifetime. Some
   * environments (jsdom; detached iframes in browsers) null the
   * `iframe.contentWindow` property as soon as the element leaves the
   * DOM — capturing the Window early lets the effect cleanup still
   * post the `ui/resource-teardown` notification.
   */
  const iframeWindowRef = useRef<Window | null>(null);

  const resourceUrl = useMemo(() => {
    const base = serverBaseUrl.replace(/\/$/, '');
    const qs = new URLSearchParams({
      session: sessionId,
      item: stackItem.id,
    });
    return `${base}/mcp-apps/resource?${qs.toString()}`;
  }, [serverBaseUrl, sessionId, stackItem.id]);

  const toolsCallUrl = useMemo(
    () => `${serverBaseUrl.replace(/\/$/, '')}/mcp-apps/tools-call`,
    [serverBaseUrl],
  );

  // Compose dimensions hint from the stack item + reasonable defaults.
  const dims = useMemo(() => {
    return {
      width: stackItem.containerDimensions?.width,
      height: stackItem.containerDimensions?.height,
      maxWidth: stackItem.containerDimensions?.maxWidth,
      maxHeight: stackItem.containerDimensions?.maxHeight,
    };
  }, [stackItem.containerDimensions]);

  useEffect(() => {
    async function handleMessage(ev: MessageEvent) {
      // Only accept messages from the iframe we mounted. `source` is
      // the iframe's `contentWindow`. When `source` doesn't match the
      // iframe's contentWindow, it's either from a different frame
      // (ignore) or a host-to-host message (not our concern).
      const iframe = iframeRef.current;
      if (!iframe || ev.source !== iframe.contentWindow) return;

      const req = ev.data as JsonRpcRequest;
      if (!req || typeof req !== 'object') return;
      if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') return;

      // ADAPTER BOUNDARY: only these methods are honored. All other
      // lifecycle methods are answered with `method_not_supported` —
      // they MUST NOT mutate any ggui session state through this path.
      let response: JsonRpcResponse;
      switch (req.method) {
        case 'ui/initialize': {
          response = {
            jsonrpc: '2.0',
            id: req.id ?? 0,
            result: {
              theme: theme ?? DEFAULT_THEME,
              containerDimensions: dims,
              locale:
                locale ??
                (typeof navigator !== 'undefined' ? navigator.language : 'en-US'),
              // Intentionally DO NOT forward outer ggui session state
              // (stack, actionSpec, streamSpec, etc.) to the embedded
              // iframe — adapter boundary rule.
            },
          };
          break;
        }
        case 'tools/call': {
          const tool =
            typeof req.params?.name === 'string' ? req.params.name : '';
          const args =
            req.params?.arguments && typeof req.params.arguments === 'object'
              ? (req.params.arguments as Record<string, unknown>)
              : {};
          if (!tool) {
            response = {
              jsonrpc: '2.0',
              id: req.id ?? 0,
              error: { code: -32602, message: 'tools/call requires params.name' },
            };
            break;
          }
          try {
            const resp = await fetch(toolsCallUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                session: sessionId,
                item: stackItem.id,
                tool,
                arguments: args,
              }),
            });
            if (!resp.ok) {
              const body = (await resp.json().catch(() => ({}))) as {
                error?: string;
              };
              response = {
                jsonrpc: '2.0',
                id: req.id ?? 0,
                error: {
                  code: resp.status === 403 ? -32003 : -32000,
                  message: body.error ?? `proxy_error_${resp.status}`,
                },
              };
            } else {
              const result = (await resp.json()) as Record<string, unknown>;
              response = { jsonrpc: '2.0', id: req.id ?? 0, result };
            }
          } catch (err) {
            response = {
              jsonrpc: '2.0',
              id: req.id ?? 0,
              error: {
                code: -32000,
                message: `proxy_fetch_failed: ${String(err)}`,
              },
            };
          }
          break;
        }
        default: {
          response = {
            jsonrpc: '2.0',
            id: req.id ?? 0,
            error: { code: -32601, message: 'method_not_supported' },
          };
        }
      }

      iframe.contentWindow?.postMessage(response, '*');
    }

    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
      // The host-initiated `ui/resource-teardown` notification is
      // posted from the iframe ref-callback's DETACH phase (see
      // `<iframe ref=…>` below), NOT from this effect cleanup. React 19
      // passive-effect cleanups for unmount run AFTER the DOM is
      // committed for removal — by that point jsdom + real browsers
      // have torn down the iframe's contentWindow, so messages posted
      // here never reach the view. Ref callbacks fire during commit,
      // while the element is still attached, so that's the correct
      // teardown hook.
    };
  }, [dims, locale, sessionId, stackItem.id, theme, toolsCallUrl]);

  // Build the sandbox attribute from the item's declared permissions.
  // MCP Apps hosts grant the minimum necessary sandbox tokens; we add
  // allow-scripts unconditionally (the iframe needs JS to run) and
  // allow-same-origin ONLY when the item's CSP explicitly connect/
  // resource-domains imply it's safe (for V1 we keep sandboxed).
  const sandbox = useMemo(() => {
    const tokens = ['allow-scripts'];
    // `allow-forms` is safe for most MCP Apps workflows; enable by default.
    tokens.push('allow-forms');
    return tokens.join(' ');
  }, []);

  // Build the `allow` attribute (Permissions Policy) from declared perms.
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
          // Mount: cache iframe + its live contentWindow. Later detach
          // reads the cached Window because `contentWindow` is null on
          // detached iframes.
          iframeRef.current = el;
          iframeWindowRef.current = el.contentWindow;
        } else {
          // Detach: ref callback fires with `null` during commit, while
          // the iframe is still live in the DOM. Post the
          // `ui/resource-teardown` notification NOW — passive-effect
          // cleanup would run too late (after DOM removal).
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
