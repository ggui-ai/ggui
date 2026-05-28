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
import type { RenderRef } from './types';
import { buildSelfContainedHtml } from './html';

interface RenderProps {
  readonly item: RenderRef;
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
}

/**
 * Renders one ggui render via the spec-canonical {@link AppRenderer}
 * host (re-exported from `@mcp-ui/client` per spec-migration P2).
 *
 * **How rendering bootstraps without an HTTP shortCode fetch (R5).**
 * Earlier samples mounted `<McpAppIframe resource={{uri: '/r/<code>'}}>`,
 * which fetched the HTML over HTTP via the bearer-by-obscurity
 * shortCode URL. R5 removed that path. Now the host builds the iframe
 * HTML CLIENT-SIDE from the {@link McpAppAiGguiRenderMeta} slice we
 * already have in hand (parsed off `_meta` on the tool_result, or
 * recovered via the wsToken-gated `/api/renders/:id/state` polling
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
export function Render({
  item,
  sandboxUrl,
  fillContainer = false,
}: RenderProps) {
  // Reconstruct the iframe HTML from the render meta. The meta carries
  // `runtimeUrl`, `wsUrl + wsToken`, `codeUrl + propsJson`, etc. — the
  // iframe-runtime reads everything off `window.__GGUI_META__` at
  // boot. When meta hasn't landed yet, fall back to a "loading"
  // placeholder that the next prop transition replaces.
  //
  // The shell builds ONCE per render lifetime — pinned in a ref because
  // subsequent `ggui_update` calls mutate `item.meta` (the props patch),
  // and AppRenderer re-navigates the inner sandbox iframe whenever its
  // `html` prop string changes — that wipes the running React tree.
  // Live props updates MUST flow through `toolResult` (forwarded as
  // `ui/notifications/tool-result` postMessage) or the WS `props_update`
  // frame instead. We reset the ref when the renderId changes
  // (genuinely new mount target).
  const htmlRef = useRef<{ renderId: string; html: string } | null>(null);
  if (htmlRef.current !== null && htmlRef.current.renderId !== item.renderId) {
    htmlRef.current = null;
  }
  let html: string;
  if (!item.meta) {
    html = LOADING_HTML;
  } else {
    if (htmlRef.current === null) {
      htmlRef.current = {
        renderId: item.renderId,
        html: buildSelfContainedHtml(toMcpAppEnvelope(item.meta)),
      };
    }
    html = htmlRef.current.html;
  }

  // Build a CallToolResult from the render meta so AppRenderer forwards
  // it to the inner iframe via `ui/notifications/tool-result` — the
  // post-mount path through which iframe-runtime re-applies state on
  // every `ggui_update`. Without this, prop changes after the first
  // mount never reach the iframe-runtime (it would only see the initial
  // `__GGUI_META__` global, then nothing).
  const toolResult = useMemo<CallToolResult | undefined>(
    () => (item.meta ? buildAppRendererToolResult(item.meta) : undefined),
    [item.meta],
  );

  const sandbox = useMemo(() => ({ url: new URL(sandboxUrl) }), [sandboxUrl]);

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
      console.log('[Render] renderer tool_call', params);
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
          console.warn('[Render] relay non-2xx', resp.status);
          return { isError: true, content: [] };
        }
        const jsonRpc = (await resp.json()) as {
          readonly result?: CallToolResult;
          readonly error?: { readonly message?: string };
        };
        if (jsonRpc.error !== undefined) {
          console.warn('[Render] relay error envelope', jsonRpc.error);
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
        console.warn('[Render] relay transport error', err);
        return { isError: true, content: [] };
      }
    },
    [],
  );

  return (
    <div className="render">
      <div className="render-chrome">
        <span className="render-id">#{item.renderId.slice(0, 12)}</span>
        <span className="render-action">{item.action}</span>
        {item.contractHash ? (
          <span className="render-hash" title={item.contractHash}>
            {item.contractHash.slice(0, 10)}
          </span>
        ) : null}
      </div>
      <div
        className="render-frame"
        style={fillContainer ? { flex: 1, minHeight: 0 } : undefined}
      >
        <AppRenderer
          toolName="ggui_render"
          sandbox={sandbox}
          html={html}
          {...(toolResult !== undefined ? { toolResult } : {})}
          onCallTool={onCallTool}
          onError={(err) =>
            console.warn('[Render] AppRenderer error', err)
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
 * transition swaps in the real shell HTML built from the slice.
 */
const LOADING_HTML = `<!doctype html>
<html><body>
<div style="font:14px system-ui,sans-serif;color:#666;padding:24px">Loading UI…</div>
</body></html>`;
