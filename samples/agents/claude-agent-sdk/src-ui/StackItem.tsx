/* eslint-disable no-console */
import { useCallback, useMemo, useRef } from 'react';
import {
  AppRenderer,
  buildAppRendererToolResult,
  type RequestHandlerExtra,
} from '@ggui-ai/react';
import type {
  CallToolRequest,
  CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { toMcpAppEnvelope } from '@ggui-ai/protocol/integrations/mcp-apps';
import type { StackItemRef } from './types';
import { buildSelfContainedHtml } from './html';

interface StackItemProps {
  readonly item: StackItemRef;
  /**
   * Sandbox-proxy URL — second-origin host of `sandbox.html` served by
   * `startSandboxProxyServer` (from `@ggui-ai/dev-stack`). Required:
   * `<AppRenderer>` mandates a separate-origin sandbox per MCP Apps
   * spec.
   */
  readonly sandboxUrl: string;
  /**
   * When set, the card stretches to fill its container (panel mode).
   * Otherwise the card uses a comfortable default height suitable for
   * inline-in-chat rendering.
   */
  readonly fillContainer?: boolean;
  /**
   * Handler for `ui/message` notifications from the iframe per MCP Apps
   * spec (SEP-1865). Fired when the guest UI calls `App.sendMessage({
   * role:'user', content:[{type:'text', text:'...'}] })`. The host
   * extracts the text and feeds it back into the chat as a fresh user
   * turn (re-invokes the `/chat` SSE round-trip). Absent ⇒ no-op;
   * messages from the iframe are silently dropped.
   */
  readonly onUiMessage?: (text: string) => void;
}

/**
 * Renders one ggui-pushed UI via the spec-canonical {@link AppRenderer}
 * host (re-exported from `@mcp-ui/client` per spec-migration P2).
 *
 * **How rendering bootstraps without an HTTP shortCode fetch (R5).**
 * Earlier samples mounted `<McpAppIframe resource={{uri: '/r/<code>'}}>`,
 * which fetched the HTML over HTTP via the bearer-by-obscurity
 * shortCode URL. R5 removed that path. Now the host builds the iframe
 * HTML CLIENT-SIDE from the {@link McpAppAiGguiMeta} slice pair we
 * already have in hand (parsed off `_meta` on the tool_result, or
 * recovered via the wsToken-gated `/api/sessions/:id/state` polling
 * fallback when an MCP SDK stripped `_meta`). The HTML inlines
 * `window.__GGUI_META__` and a `<script type="module" src=runtimeUrl>`
 * — the iframe-runtime reads the global at boot and self-mounts.
 *
 * **AppRenderer's two-iframe sandbox.** `sandboxUrl` MUST point at a
 * different-origin host serving `sandbox.html`. `<AppRenderer>`
 * navigates an outer iframe to that URL; the outer frame writes the
 * `html` we pass into an inner iframe (origin-isolated). Spec-canonical
 * postMessage carries `_meta` slices and tool calls bidirectionally.
 *
 * **`onCallTool` and the relay.** AppRenderer forwards any inner-iframe
 * `tools/call` to our handler. We POST to `/relay/tools-call` on the
 * sample agent server, which proxies to the ggui MCP server over HTTP
 * (the spec-defined relay role for `_meta.ui.visibility: ['app']`
 * tools). Iframe holds no auth credential; the host owns auth.
 */
export function StackItem({
  item,
  sandboxUrl,
  fillContainer = false,
  onUiMessage,
}: StackItemProps) {
  // Reconstruct the iframe HTML from the slice pair. The slice carries
  // `runtimeUrl`, `wsUrl + wsToken`, `codeUrl + propsJson`, etc. — the
  // iframe-runtime reads everything off `window.__GGUI_META__` at
  // boot. When meta hasn't landed yet, fall back to a "loading"
  // placeholder that the next prop transition replaces.
  //
  // The shell builds ONCE per stack-item lifetime — pinned in a ref
  // because subsequent `ggui_update` calls mutate `item.meta` (the
  // props patch), and AppRenderer re-navigates the inner sandbox
  // iframe whenever its `html` prop string changes — that wipes the
  // running React tree. Live props updates MUST flow through
  // `toolResult` (forwarded as `ui/notifications/tool-result`
  // postMessage) or the WS `props_update` frame instead. We reset the
  // ref when the stack-item id changes (genuinely new mount target).
  const htmlRef = useRef<{ stackItemId: string; html: string } | null>(null);
  if (htmlRef.current !== null && htmlRef.current.stackItemId !== item.stackItemId) {
    htmlRef.current = null;
  }
  let html: string;
  if (!item.meta) {
    html = LOADING_HTML;
  } else {
    if (htmlRef.current === null) {
      htmlRef.current = {
        stackItemId: item.stackItemId,
        html: buildSelfContainedHtml(toMcpAppEnvelope(item.meta)),
      };
    }
    html = htmlRef.current.html;
  }

  // Build a CallToolResult from the slice pair so AppRenderer forwards
  // it to the inner iframe via `ui/notifications/tool-result` — the
  // post-mount path through which iframe-runtime re-applies state on
  // every `ggui_update`. Without this, prop changes after the first
  // mount never reach the iframe-runtime (it would only see the initial
  // `__GGUI_META__` global, then nothing).
  const toolResult = useMemo<CallToolResult | undefined>(
    () => (item.meta ? buildAppRendererToolResult(item.meta) : undefined),
    [item.meta],
  );

  // CSP wiring — startSandboxProxyServer defaults to
  // `script-src 'self' ...` where 'self' is the sandbox proxy's origin
  // (port 7790). The runtime bundle + WS + /api fetches all live on
  // the ggui server's origin (port 6781), which the default CSP blocks.
  // AppRenderer forwards this to the proxy as a `?csp=…` query, which
  // the proxy expands into `script-src 'self' … <runtimeOrigin>` and
  // `connect-src 'self' <runtimeOrigin> <wsOrigin>`. Without these,
  // the runtime bundle silently fails to load and the iframe stays
  // blank.
  const sandbox = useMemo(() => {
    const session = item.meta?.session;
    const runtimeOrigin = safeUrlOrigin(session?.runtimeUrl);
    const wsOrigin = safeUrlOrigin(session?.wsUrl);
    const resourceDomains = runtimeOrigin ? [runtimeOrigin] : [];
    const connectDomains = [runtimeOrigin, wsOrigin].filter(
      (s): s is string => s.length > 0,
    );
    const csp =
      resourceDomains.length > 0 || connectDomains.length > 0
        ? { resourceDomains, connectDomains }
        : undefined;
    return {
      url: new URL(sandboxUrl),
      ...(csp ? { csp } : {}),
    };
  }, [sandboxUrl, item.meta]);

  // Tool relay — AppRenderer hands us inner-iframe `tools/call` invocations
  // (`onCallTool`). We proxy through `/relay/tools-call` on the sample
  // agent server. Same wire as the prior McpAppIframe `onToolCall`
  // callback; only the contract shape changed (CallToolRequest.params
  // vs. raw `(name, args)`).
  const onCallTool = useCallback(
    async (
      params: CallToolRequest['params'],
      _extra: RequestHandlerExtra,
    ): Promise<CallToolResult> => {
      console.log('[StackItem] renderer tool_call', params);
      try {
        const resp = await fetch('/relay/tools-call', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: params.name,
            arguments: params.arguments ?? {},
          }),
        });
        if (!resp.ok) {
          console.warn('[StackItem] relay non-2xx', resp.status);
          return { isError: true, content: [] };
        }
        const jsonRpc = (await resp.json()) as {
          readonly result?: CallToolResult;
          readonly error?: { readonly message?: string };
        };
        if (jsonRpc.error !== undefined) {
          console.warn('[StackItem] relay error envelope', jsonRpc.error);
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: jsonRpc.error.message ?? 'relay error',
              },
            ],
          };
        }
        return jsonRpc.result ?? { content: [] };
      } catch (err) {
        console.warn('[StackItem] relay transport error', err);
        return { isError: true, content: [] };
      }
    },
    [],
  );

  // MCP-Apps `ui/message` (SEP-1865) — the iframe component dispatches
  // `App.sendMessage({role:'user', content:[{type:'text', text:'...'}]})`
  // when its user wants to send something into the host chat. We extract
  // text content blocks (the spec allows images too, but the sample
  // ignores them for v1) and re-invoke the chat via the supplied
  // callback. Returning `{}` signals success per the spec; throwing or
  // returning `{isError:true}` would tell the iframe its message was
  // rejected.
  const onMessage = useCallback(
    async (
      params: { role: 'user'; content: ReadonlyArray<{ type: string; text?: string }> },
    ): Promise<Record<string, unknown>> => {
      const text = params.content
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text ?? '')
        .join('\n')
        .trim();
      if (text.length === 0 || onUiMessage === undefined) {
        return { isError: true };
      }
      onUiMessage(text);
      return {};
    },
    [onUiMessage],
  );

  return (
    <div className="stack-item">
      <div className="stack-item-chrome">
        <span className="stack-item-id">#{item.stackItemId.slice(0, 12)}</span>
        <span className="stack-item-action">{item.action}</span>
        {item.contractHash ? (
          <span className="stack-item-hash" title={item.contractHash}>
            {item.contractHash.slice(0, 10)}
          </span>
        ) : null}
      </div>
      <div
        className="stack-item-frame"
        style={fillContainer ? { flex: 1, minHeight: 0 } : undefined}
      >
        <AppRenderer
          toolName="ggui_push"
          sandbox={sandbox}
          html={html}
          {...(toolResult !== undefined ? { toolResult } : {})}
          onCallTool={onCallTool}
          onMessage={onMessage}
          onError={(err) =>
            console.warn('[StackItem] AppRenderer error', err)
          }
        />
      </div>
    </div>
  );
}

/**
 * Placeholder HTML rendered while the slice envelope is being
 * recovered (the meta refetch is async post-tool_result). Shows a tiny
 * loading marker so the iframe isn't fully blank; the next prop
 * transition swaps in the real shell HTML built from the slice pair.
 */
/**
 * Extract an origin from a URL string, or return '' if invalid/missing.
 * Used to thread runtime + WS origins into the sandbox proxy's CSP so
 * the iframe-runtime bundle + live-channel WS aren't CSP-blocked.
 */
function safeUrlOrigin(url: string | undefined): string {
  if (typeof url !== 'string' || url.length === 0) return '';
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/**
 * Quiet placeholder shown for the ~tens of ms between mount and the
 * first slice envelope landing on `item.meta`. Renders no visible text
 * (no "Loading UI…" jank, no stray flash of `_meta`-absent fallback
 * shell text) — the surrounding `.stack-item` card chrome already
 * conveys "something is here". Background matches `--bg-2` from the
 * chat shell so the iframe blends seamlessly until real content lands.
 */
const LOADING_HTML = `<!doctype html>
<html><head><meta name="color-scheme" content="dark"></head>
<body style="margin:0;background:#1a1a22"></body></html>`;
