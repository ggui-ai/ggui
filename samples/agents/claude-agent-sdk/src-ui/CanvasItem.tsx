/* eslint-disable no-console */
import { useCallback, useMemo } from 'react';
import {
  AppRenderer,
  type RequestHandlerExtra,
} from '@ggui-ai/react';
import type {
  CallToolRequest,
  CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { CanvasRef } from './types';

interface CanvasItemProps {
  readonly canvas: CanvasRef;
  /**
   * Sandbox-proxy URL — second-origin host of `sandbox.html` served by
   * `startSandboxProxyServer` (from `@ggui-ai/dev-stack`). Required:
   * `<AppRenderer>` mandates a separate-origin sandbox per MCP Apps
   * spec.
   */
  readonly sandboxUrl: string;
  /**
   * When set, the canvas stretches to fill its container (panel mode
   * default for fullscreen). Otherwise uses a comfortable default
   * height for chat-log inline display.
   */
  readonly fillContainer?: boolean;
}

/**
 * Renders the session-scoped canvas iframe for FULLSCREEN-mode sessions.
 *
 * **What this is.** Per the resourceUri-by-tool axiom (see
 * `docs/principles/resource-uri-by-tool.md`), a `ggui_new_session` whose
 * result carries `_meta.ui.resourceUri = ui://ggui/session/<id>` puts
 * the host in fullscreen mode. The host mounts ONE session-scoped
 * iframe and subsequent `ggui_push` results carry NO resourceUri — the
 * server fans the stack item out via the live channel to the existing
 * canvas. The iframe-runtime inside renders the latest stack item.
 *
 * **How it differs from {@link StackItem}.**
 *   - StackItem mounts per-push (one iframe per `ggui_push`).
 *   - CanvasItem mounts per-session (one iframe for the lifetime of the
 *     session).
 *   - StackItem forwards a `toolResult` to AppRenderer so the inner
 *     iframe receives `ui/notifications/tool-result` on every prop
 *     change; CanvasItem omits `toolResult` — the canvas iframe gets
 *     updates via the live channel (WS), not postMessage.
 *
 * **HTML source.** Pre-built by the MCP server's `resources/read`
 * handler (`registerGguiSessionResourceTemplate`); proxied through
 * `/relay/resources-read` on the sample-agent backend. The HTML inlines
 * `__GGUI_META__` (session slice with `displayMode: 'fullscreen'` + the
 * live-mode trio + pollingUrl) so the iframe-runtime mounts CanvasShell
 * and subscribes without any postMessage round-trip.
 *
 * **CSP.** Comes from the `resources/read` response's `_meta.ui.csp`
 * block. The MCP server builds it from `publicBaseUrl` + per-stack-item
 * gadget origins. We pass it straight through to the sandbox-proxy via
 * AppRenderer's `sandbox.csp` prop — same wiring StackItem uses,
 * different source (server-projected vs derived from slice fields).
 */
export function CanvasItem({
  canvas,
  sandboxUrl,
  fillContainer = false,
}: CanvasItemProps) {
  // CSP — server already built the right shape on
  // `_meta.ui.csp.{connectDomains, resourceDomains}` (see
  // `buildCspMeta` in `mcp-apps-outbound.ts`). Forward verbatim into
  // the AppRenderer sandbox prop. Drop the wrapper entirely when the
  // server emitted no CSP block (same-origin host — restrictive default
  // is already permissive enough).
  const sandbox = useMemo(() => {
    const resourceDomains = canvas.csp?.resourceDomains ?? [];
    const connectDomains = canvas.csp?.connectDomains ?? [];
    const csp =
      resourceDomains.length > 0 || connectDomains.length > 0
        ? { resourceDomains: [...resourceDomains], connectDomains: [...connectDomains] }
        : undefined;
    return {
      url: new URL(sandboxUrl),
      ...(csp ? { csp } : {}),
    };
  }, [sandboxUrl, canvas.csp]);

  // Tool relay — symmetric with StackItem. Inner-iframe `tools/call`
  // invocations (clicks, form submits via `ggui_runtime_submit_action`)
  // proxy through `/relay/tools-call` on the sample-agent backend.
  // Canvas + per-push iframes share the same relay endpoint.
  const onCallTool = useCallback(
    async (
      params: CallToolRequest['params'],
      _extra: RequestHandlerExtra,
    ): Promise<CallToolResult> => {
      console.log('[CanvasItem] renderer tool_call', params);
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
          console.warn('[CanvasItem] relay non-2xx', resp.status);
          return { isError: true, content: [] };
        }
        const jsonRpc = (await resp.json()) as {
          readonly result?: CallToolResult;
          readonly error?: { readonly message?: string };
        };
        if (jsonRpc.error !== undefined) {
          console.warn('[CanvasItem] relay error envelope', jsonRpc.error);
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
        console.warn('[CanvasItem] relay transport error', err);
        return { isError: true, content: [] };
      }
    },
    [],
  );

  return (
    <div className="stack-item canvas-item">
      <div className="stack-item-chrome">
        <span className="stack-item-id">canvas · {canvas.sessionId.slice(0, 12)}</span>
        <span className="stack-item-action">fullscreen</span>
      </div>
      <div
        className="stack-item-frame"
        style={fillContainer ? { flex: 1, minHeight: 0 } : undefined}
      >
        <AppRenderer
          toolName="ggui_new_session"
          sandbox={sandbox}
          html={canvas.html}
          onCallTool={onCallTool}
          onError={(err) =>
            console.warn('[CanvasItem] AppRenderer error', err)
          }
        />
      </div>
    </div>
  );
}
