'use client';
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
import type { RenderRef } from '@ggui-ai/react/chat-helpers';
import { buildSelfContainedHtml } from './html';

interface RenderProps {
  readonly item: RenderRef;
  /**
   * Sandbox-proxy URL — second-origin host of `sandbox.html` served by
   * the agent backend's bundled `startSandboxProxyServer`. Required:
   * `<AppRenderer>` mandates a separate-origin sandbox per MCP Apps
   * spec. Fetched once from the backend's `GET /sandbox-proxy-url` on
   * page mount and threaded down.
   */
  readonly sandboxUrl: string;
  /** Agent backend origin — used to build the relay URL for tool calls. */
  readonly agentEndpoint: string;
  /**
   * When set, the card stretches to fill its container (panel mode).
   * Otherwise the card uses a comfortable default height suitable for
   * inline-in-chat rendering.
   */
  readonly fillContainer?: boolean;
  /**
   * Handler for `ui/message` notifications from the iframe per MCP Apps
   * spec (SEP-1865). Fired when the guest UI calls `App.sendMessage`.
   */
  readonly onUiMessage?: (text: string) => void;
}

/**
 * Renders one ggui render via the spec-canonical {@link AppRenderer}
 * host. Ported verbatim from the sample-agent's `src-ui/Render.tsx`;
 * the only Next.js-specific change is the explicit `'use client'`
 * directive and the routing of relay calls to the configured agent
 * endpoint (rather than same-origin `/relay/tools-call`).
 *
 * See the original sample-agent Render docstring for the full rationale
 * on AppRenderer's two-iframe sandbox, CSP wiring, `_meta` parsing, and
 * the htmlRef pin that keeps `ggui_update` props patches from
 * navigating the inner sandbox iframe.
 */
export function Render({
  item,
  sandboxUrl,
  agentEndpoint,
  fillContainer = false,
  onUiMessage,
}: RenderProps) {
  const runtimeOrigin = safeUrlOrigin(item.meta?.runtimeUrl);
  const wsOrigin = safeUrlOrigin(item.meta?.wsUrl);
  const sandbox = useMemo(() => {
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
  }, [sandboxUrl, runtimeOrigin, wsOrigin]);

  // See sample-agent Render.tsx docstring — html is pinned per-render so
  // ggui_update props-patches don't re-navigate the inner iframe and wipe
  // the running React tree.
  const htmlRef = useRef<{ renderId: string; html: string } | null>(null);
  if (htmlRef.current !== null && htmlRef.current.renderId !== item.renderId) {
    htmlRef.current = null;
  }
  let html: string | undefined;
  if (!item.meta) {
    html = undefined;
  } else {
    if (htmlRef.current === null) {
      htmlRef.current = {
        renderId: item.renderId,
        html: buildSelfContainedHtml(toMcpAppEnvelope(item.meta)),
      };
    }
    html = htmlRef.current.html;
  }

  const toolResult = useMemo<CallToolResult | undefined>(
    () => (item.meta ? buildAppRendererToolResult(item.meta) : undefined),
    [item.meta],
  );

  const onCallTool = useCallback(
    async (
      params: CallToolRequest['params'],
      _extra: RequestHandlerExtra,
    ): Promise<CallToolResult> => {
      console.log('[Render] renderer tool_call', params);
      try {
        const resp = await fetch(`${agentEndpoint}/relay/tools-call`, {
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
    [agentEndpoint],
  );

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
        {html !== undefined && toolResult !== undefined ? (
          <AppRenderer
            key={item.renderId}
            toolName="ggui_render"
            sandbox={sandbox}
            html={html}
            toolResult={toolResult}
            onCallTool={onCallTool}
            onMessage={onMessage}
            onError={(err) =>
              console.warn('[Render] AppRenderer error', err)
            }
          />
        ) : (
          <div className="render-loading" aria-hidden="true" />
        )}
      </div>
    </div>
  );
}

function safeUrlOrigin(url: string | undefined): string {
  if (typeof url !== 'string' || url.length === 0) return '';
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}
