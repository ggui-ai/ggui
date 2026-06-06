/**
 * Vanilla-TS port of `@ggui-ai/react::components/GguiRender.tsx`'s
 * MCP-Apps branch. Used when a ggui render's `type === 'mcpApps'`
 * — the renderer mounts a nested iframe that embeds a foreign
 * MCP App.
 *
 * The iframe plays the MCP Apps HOST role for the embedded content:
 *
 *   - `ui/initialize` → respond with minimal context (theme +
 *     containerDimensions + locale).
 *   - `tools/call` → forward to the ggui server's
 *     `/mcp-apps/tools-call` endpoint. The server enforces source
 *     connector scoping + `_meta.ui.visibility: ['app']`.
 *   - any other method → respond with `method_not_supported`.
 *
 * Adapter-boundary rule (ENFORCED):
 *   - MCP Apps lifecycle messages from the embedded iframe do NOT
 *     mutate the outer ggui render state / contracts — the host
 *     never forwards them to ggui-server as render-level events.
 *   - `ui/initialize` intentionally DOES NOT forward outer ggui
 *     render state (actionSpec, streamSpec) to the iframe.
 *
 * On detach, a host-initiated `ui/resource-teardown` notification
 * is posted to the iframe BEFORE the element leaves the DOM so the
 * embedded app can persist state / release resources cleanly. Post-
 * detach the contentWindow is null in browsers + jsdom; we cache it
 * at mount so the teardown message can still reach the view.
 *
 * Recursive mount safety: a foreign MCP App loaded inside this
 * iframe can in turn render a `ui://ggui/render` resource via its
 * own host implementation. That recursion stays bounded because
 * each nested iframe runs the same adapter-boundary rule — outer
 * ggui state never leaks into the inner renderer's render through
 * this host path. Host-to-host sandboxing is browser-enforced by
 * the iframe's `sandbox="allow-scripts"` attribute.
 */
import type { McpAppsGguiSession } from '@ggui-ai/protocol/integrations/mcp-apps';

// =============================================================================
// JSON-RPC wire types (iframe postMessage bridge)
// =============================================================================

interface JsonRpcRequest {
  readonly jsonrpc?: '2.0';
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: number | string;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code: number; readonly message: string };
}

/** Default permissive-but-safe theme for iframes that don't override. */
const DEFAULT_THEME: Readonly<Record<string, string>> = {
  '--color-primary': '#0284c7',
  '--color-surface': '#ffffff',
  '--color-text': '#111111',
  '--font-family': 'system-ui, -apple-system, sans-serif',
  '--border-radius-md': '8px',
};

// =============================================================================
// Mount options + handle
// =============================================================================

export interface McpAppIframeMountOptions {
  readonly render: McpAppsGguiSession;
  /** GguiSession id — threaded into the proxy URL so server-side
   *  connector scoping works. */
  readonly sessionId: string;
  /**
   * Base URL of the ggui server (origin). The host appends
   *  `/mcp-apps/resource` + `/mcp-apps/tools-call` to this. Should
   *  NOT have a trailing slash. Empty string = same-origin.
   */
  readonly serverBaseUrl?: string;
  /** Optional theme override for the `ui/initialize` context. */
  readonly theme?: Readonly<Record<string, string>>;
  /** Optional locale; defaults to `navigator.language` when
   *  available. */
  readonly locale?: string;
}

export interface McpAppIframeMount {
  /** Tear down — posts `ui/resource-teardown` then removes the iframe. */
  unmount(): void;
  /** The mounted iframe element — exposed for test assertions. */
  readonly element: HTMLIFrameElement;
}

// =============================================================================
// Helpers
// =============================================================================

function composeResourceUrl(opts: {
  serverBaseUrl: string;
  sessionId: string;
  itemId: string;
}): string {
  const base = opts.serverBaseUrl.replace(/\/$/, '');
  const qs = new URLSearchParams({
    session: opts.sessionId,
    item: opts.itemId,
  });
  return `${base}/mcp-apps/resource?${qs.toString()}`;
}

function composeToolsCallUrl(serverBaseUrl: string): string {
  return `${serverBaseUrl.replace(/\/$/, '')}/mcp-apps/tools-call`;
}

function buildSandboxAttr(): string {
  // MCP Apps hosts grant the minimum sandbox tokens needed. V1 keeps
  // us permissive-enough for scripted + form-submitting content but
  // does NOT grant same-origin (that would let the iframe read the
  // host document). Ports the host-SDK version verbatim.
  return 'allow-scripts allow-forms';
}

function buildAllowAttr(render: McpAppsGguiSession): string | undefined {
  const perms = render.permissions;
  if (!perms) return undefined;
  const parts: string[] = [];
  if (perms.camera) parts.push("camera 'self'");
  if (perms.microphone) parts.push("microphone 'self'");
  if (perms.geolocation) parts.push("geolocation 'self'");
  if (perms.clipboardWrite) parts.push("clipboard-write 'self'");
  return parts.length > 0 ? parts.join('; ') : undefined;
}

// =============================================================================
// Mount
// =============================================================================

/**
 * Mount the MCP Apps iframe into `container`. The container is
 * cleared; the iframe becomes its sole child.
 *
 * The host-bridge listener attaches to `window.message` globally;
 * `source !== iframe.contentWindow` guard ensures we only respond
 * to our own iframe's messages.
 */
export function mountMcpAppIframe(
  container: HTMLElement,
  opts: McpAppIframeMountOptions,
): McpAppIframeMount {
  container.replaceChildren();

  const serverBaseUrl = opts.serverBaseUrl ?? '';
  const resourceUrl = composeResourceUrl({
    serverBaseUrl,
    sessionId: opts.sessionId,
    itemId: opts.render.id,
  });
  const toolsCallUrl = composeToolsCallUrl(serverBaseUrl);
  const dims = {
    width: opts.render.containerDimensions?.width,
    height: opts.render.containerDimensions?.height,
    maxWidth: opts.render.containerDimensions?.maxWidth,
    maxHeight: opts.render.containerDimensions?.maxHeight,
  };

  const iframe = container.ownerDocument.createElement('iframe');
  iframe.setAttribute('data-ggui-mcp-apps', 'iframe');
  iframe.setAttribute('data-ggui-session-id', opts.render.id);
  iframe.setAttribute('data-ggui-connector-id', opts.render.source.connectorId);
  iframe.src = resourceUrl;
  iframe.title = opts.render.description ?? 'MCP App';
  iframe.setAttribute('sandbox', buildSandboxAttr());
  const allowAttr = buildAllowAttr(opts.render);
  if (allowAttr !== undefined) iframe.setAttribute('allow', allowAttr);
  iframe.style.width = dims.width !== undefined ? `${dims.width}px` : '100%';
  iframe.style.height = dims.height !== undefined ? `${dims.height}px` : '480px';
  iframe.style.maxWidth = dims.maxWidth !== undefined ? `${dims.maxWidth}px` : '100%';
  if (dims.maxHeight !== undefined) iframe.style.maxHeight = `${dims.maxHeight}px`;
  iframe.style.border = '1px solid #e5e5e5';
  iframe.style.borderRadius = '8px';
  iframe.style.display = 'block';

  container.appendChild(iframe);

  // Cache contentWindow — on detach, `iframe.contentWindow` is null
  // so the cached handle is the only way `ui/resource-teardown` can
  // still reach the view.
  let cachedIframeWindow: Window | null = iframe.contentWindow;

  const listener = (ev: MessageEvent): void => {
    void handleHostBridgeRequest(ev);
  };

  async function handleHostBridgeRequest(ev: MessageEvent): Promise<void> {
    // Adapter-boundary guard: only our own iframe's contentWindow is
    // allowed. This matches the ref-guard in `GguiRender.tsx`.
    if (iframe.contentWindow === null || ev.source !== iframe.contentWindow) return;
    const req = ev.data as JsonRpcRequest;
    if (req === null || typeof req !== 'object') return;
    if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') return;

    const id = req.id ?? 0;
    let response: JsonRpcResponse;

    switch (req.method) {
      case 'ui/initialize': {
        response = {
          jsonrpc: '2.0',
          id,
          result: {
            theme: opts.theme ?? DEFAULT_THEME,
            containerDimensions: dims,
            locale:
              opts.locale ??
              (typeof navigator !== 'undefined' ? navigator.language : 'en-US'),
          },
        };
        break;
      }
      case 'tools/call': {
        const tool =
          typeof req.params?.['name'] === 'string' ? (req.params['name'] as string) : '';
        const rawArgs = req.params?.['arguments'];
        const args =
          rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
            ? (rawArgs as Record<string, unknown>)
            : {};
        if (tool.length === 0) {
          response = {
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: 'tools/call requires params.name' },
          };
          break;
        }
        try {
          const resp = await fetch(toolsCallUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              session: opts.sessionId,
              item: opts.render.id,
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
              id,
              error: {
                code: resp.status === 403 ? -32003 : -32000,
                message: body.error ?? `proxy_error_${resp.status}`,
              },
            };
          } else {
            const result = (await resp.json()) as Record<string, unknown>;
            response = { jsonrpc: '2.0', id, result };
          }
        } catch (err) {
          response = {
            jsonrpc: '2.0',
            id,
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
          id,
          error: { code: -32601, message: 'method_not_supported' },
        };
      }
    }

    iframe.contentWindow?.postMessage(response, '*');
  }

  window.addEventListener('message', listener);

  return {
    element: iframe,
    unmount() {
      window.removeEventListener('message', listener);
      // Host-initiated `ui/resource-teardown` — posted BEFORE the
      // iframe leaves the DOM so its contentWindow is still live.
      // Post-detach the contentWindow is null; the cached handle is
      // a belt-and-suspenders fallback.
      const win = iframe.contentWindow ?? cachedIframeWindow;
      try {
        win?.postMessage(
          {
            jsonrpc: '2.0',
            method: 'ui/resource-teardown',
            params: { reason: 'host_unmount' },
          },
          '*',
        );
      } catch {
        // Best-effort — teardown notification is a courtesy, not a
        // correctness contract. A thrown postMessage (detached win)
        // silently falls through to element removal.
      }
      cachedIframeWindow = null;
      if (iframe.parentNode !== null) iframe.parentNode.removeChild(iframe);
    },
  };
}
