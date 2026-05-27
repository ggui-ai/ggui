// Client-side types for the chat shell.

import type { McpAppAiGguiMeta } from '@ggui-ai/protocol/integrations/mcp-apps';

export type LayoutMode = 'inline' | 'panel';

/**
 * One conversational turn in the chat log. A turn is either:
 *   - user prompt
 *   - assistant text segment
 *   - tool-call (the agent invoked a tool; the result lands on the
 *     same entry asynchronously when the SDK forwards the tool_result)
 *   - rendered stack item (the actual MCP App iframe in INLINE mode —
 *     these are the "live" surfaces, kept across turns regardless of
 *     layout mode)
 *   - rendered session canvas (the session-scoped iframe in FULLSCREEN
 *     mode — mounted ONCE on `ggui_new_session` per the
 *     resourceUri-by-tool axiom, receives all subsequent stack items
 *     via the live channel)
 *   - error
 *   - end marker
 */
export type ChatEntry =
  | { readonly id: string; readonly kind: 'user'; readonly text: string }
  | { readonly id: string; readonly kind: 'assistant'; readonly text: string }
  | ToolCallEntry
  | { readonly id: string; readonly kind: 'stack-item'; readonly stackItem: StackItemRef }
  | { readonly id: string; readonly kind: 'canvas'; readonly canvas: CanvasRef }
  | { readonly id: string; readonly kind: 'push-marker'; readonly sessionId: string; readonly stackItemId: string; readonly action: string }
  | { readonly id: string; readonly kind: 'error'; readonly text: string }
  | { readonly id: string; readonly kind: 'end'; readonly subtype: string };

/**
 * Tool-call entry. The agent emitted a `tool_use` block on one SSE
 * frame; the matching `tool_result` block lands on a later frame
 * (same SDK message stream). We use Anthropic's `tool_use_id` as the
 * entry id so the result patcher can find the call by id without
 * threading a separate map. `result` / `isError` populate when the
 * matching tool_result arrives.
 */
export interface ToolCallEntry {
  readonly id: string;
  readonly kind: 'tool-call';
  readonly toolUseId: string;
  readonly name: string;
  readonly input: unknown;
  readonly result?: unknown;
  readonly isError?: boolean;
}

/**
 * A reference to a ggui-rendered stack item.
 *
 * **R5 shape change.** The old `url` field pointed at the public
 * `/r/<shortCode>` HTTP shell (bearer-by-obscurity). R5 retired that
 * surface; the host now reconstructs the iframe HTML CLIENT-SIDE from
 * the slice envelope (see `StackItem.tsx` + `html.ts`).
 *
 * `meta` is the parsed `McpAppAiGguiMeta` pair (session + stackItem
 * slices). When non-undefined, `StackItem.tsx` builds the inline
 * `__GGUI_META__` HTML and forwards a tool_result carrying the
 * envelope to AppRenderer so the inner iframe receives
 * `ui/notifications/tool-result` on every update.
 *
 * `meta` is initially undefined for SDKs that strip `_meta` from
 * tool_results (Anthropic). `useChat` re-fetches via the wsToken-gated
 * `/api/sessions/:sessionId/state` endpoint to populate / refresh it.
 */
export interface StackItemRef {
  readonly stackItemId: string;
  readonly sessionId: string;
  readonly action: string;
  readonly contractHash?: string;
  /** Last-known meta slice pair. Updated on push + every update. */
  readonly meta?: McpAppAiGguiMeta;
}

/**
 * A session-scoped canvas mount in FULLSCREEN mode.
 *
 * Per `docs/principles/resource-uri-by-tool.md`, when `ggui_new_session`
 * stamps `_meta.ui.resourceUri = ui://ggui/session/<id>` (no shortcode
 * suffix) the host is in fullscreen mode: ONE iframe is mounted for the
 * whole session, and subsequent `ggui_push` results carry NO resourceUri
 * — the server fans the new stack item out via the live channel (WS) to
 * the existing canvas, which renders it inline.
 *
 * The host fetches the canvas HTML via spec-canonical MCP
 * `resources/read` (proxied through `/relay/resources-read` on the
 * sample-agent backend). The response carries:
 *   - `text`     — the full iframe HTML with `__GGUI_META__` inlined
 *   - `_meta.ui.csp` — connect+resource domains the AppRenderer's
 *                     sandbox-proxy CSP needs (runtime + WS origins)
 *
 * The canvas iframe boots from `__GGUI_META__`, opens a WebSocket
 * subscription, and renders stack items as they arrive. The host does
 * NOT post `ui/notifications/tool-result` on subsequent pushes — that
 * is the inline-mode update path.
 */
export interface CanvasRef {
  readonly sessionId: string;
  readonly resourceUri: string;
  readonly html: string;
  readonly csp?: {
    readonly resourceDomains?: readonly string[];
    readonly connectDomains?: readonly string[];
  };
}
