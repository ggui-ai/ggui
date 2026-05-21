/* eslint-disable no-console */
import { useCallback, useMemo } from 'react';
import { McpAppIframe, type UiMessageEvent } from '@ggui-ai/react';
import type { StackItemRef } from './types';

interface StackItemProps {
  readonly item: StackItemRef;
  /**
   * When set, the card stretches to fill its container (panel mode).
   * Otherwise the card uses a comfortable default height suitable for
   * inline-in-chat rendering.
   */
  readonly fillContainer?: boolean;
  /**
   * Forwarded from iframe-runtime's `ui/message` envelope (agent-routed-
   * dispatch fallback). The sample agent runs one-shot `query()` per
   * chat turn — no resume, no inter-turn long-poll — so the consume
   * pipe is closed by the time the user clicks. This callback feeds
   * the user's gesture back into the next chat turn as fresh user
   * input.
   */
  readonly onUiMessage?: (event: UiMessageEvent) => void;
}

/**
 * Renders one ggui-pushed UI via the canonical {@link McpAppIframe}
 * host.
 *
 * Key host-side concerns:
 *
 *   - `allowSameOrigin` is set because we're a first-party host: the
 *     iframe loads our OWN ggui server at `http://localhost:6781/r/...`.
 *     Without same-origin, the iframe's bundle fetches and WebSocket
 *     handshakes fail with opaque-origin errors that surface to users
 *     as ERR_CONNECTION_REFUSED. Default-deny is correct for any
 *     third-party content — this opt-in is exactly the trust boundary
 *     described in `@ggui-ai/react`'s `McpAppIframeProps.allowSameOrigin`
 *     prop doc.
 *
 *   - We DO NOT pass `containerDimensions` as a pixel-sized hint —
 *     when present, that becomes an inline `width` on the iframe
 *     element and locks it. The iframe always fills its parent via
 *     CSS width/height 100%; the renderer learns its actual size from
 *     `window.innerWidth/innerHeight` inside the iframe.
 *
 *   - `onToolCall` forwards renderer-side `tools/call` postMessages
 *     to the sample agent server's `/relay/tools-call`, which proxies
 *     them to the ggui MCP server over HTTP. The iframe holds no auth
 *     credential of its own; this host is the protocol-defined relay
 *     party per MCP Apps spec §401 (tools with
 *     `_meta.ui.visibility: ['app']`). The relay's response is
 *     surfaced back to the iframe via postMessage so the iframe-
 *     runtime can decide whether to fall through to `ui/message`
 *     (e.g. on `PIPE_NOT_FOUND`).
 */
export function StackItem({
  item,
  fillContainer = false,
  onUiMessage,
}: StackItemProps) {
  // ResourceContents shape — no `text` / `blob` → host mounts via
  // `src=uri`. The iframe's HTML at `/r/<shortCode>` embeds the
  // bootstrap meta inline server-side, so the renderer self-
  // subscribes to the live channel from there.
  const resource = useMemo(() => ({ uri: item.url }), [item.url]);

  // Late-arrival bootstrap forwarding. The Anthropic SDK strips
  // `_meta` from tool_result blocks (the API spec only carries text
  // content); we recover the envelope via `/api/bootstrap/<shortCode>`
  // in useChat.ts and pass it here. On the FIRST mount the iframe
  // boots from the inline `__GGUI_BOOTSTRAP__` global. On every
  // subsequent transition (typically a `ggui_update` refetch),
  // McpAppIframe posts `_meta.ggui.bootstrap = <bootstrap>` over
  // postMessage so iframe-runtime re-applies the new propsJson
  // without a WS round-trip — the spec-compliant live-update path.
  const bootstrap = item.bootstrap as
    | import('@ggui-ai/protocol/integrations/mcp-apps').GguiBootstrapMeta
    | undefined;

  const onToolCall = useCallback(
    async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      console.log('[StackItem] renderer tool_call', { name, args });
      try {
        const resp = await fetch('/relay/tools-call', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, arguments: args }),
        });
        if (!resp.ok) {
          console.warn('[StackItem] relay non-2xx', resp.status);
          return { isError: true, content: [] };
        }
        const jsonRpc = (await resp.json()) as {
          readonly result?: unknown;
          readonly error?: unknown;
        };
        if (jsonRpc.error !== undefined) {
          console.warn('[StackItem] relay error envelope', jsonRpc.error);
          return jsonRpc.error;
        }
        // Return the JSON-RPC result. McpAppIframe wraps and posts
        // it back to the iframe so iframe-runtime's postRpcToParent
        // resolver can read it.
        return jsonRpc.result;
      } catch (err) {
        console.warn('[StackItem] relay transport error', err);
        return { isError: true, content: [] };
      }
    },
    [],
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
        <a
          className="stack-item-link"
          href={item.url}
          target="_blank"
          rel="noreferrer noopener"
          title="Open in new tab"
          aria-label="Open in new tab"
        >
          ↗
        </a>
      </div>
      <div
        className="stack-item-frame"
        style={fillContainer ? { flex: 1, minHeight: 0 } : undefined}
      >
        <McpAppIframe
          resource={resource}
          onToolCall={onToolCall}
          allowSameOrigin
          onUiMessage={onUiMessage}
          {...(bootstrap !== undefined ? { bootstrap } : {})}
        />
      </div>
    </div>
  );
}
