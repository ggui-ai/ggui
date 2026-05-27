// Client-side types for the chat shell.

import type { McpAppAiGguiRenderMeta } from '@ggui-ai/protocol/integrations/mcp-apps';

export type LayoutMode = 'inline' | 'panel';

/**
 * One conversational turn in the chat log. A turn is either:
 *   - user prompt
 *   - assistant text segment
 *   - tool-call (the agent invoked a tool; the result lands on the
 *     same entry asynchronously when the SDK forwards the tool_result)
 *   - rendered render (the actual MCP App iframe — one per ggui_render)
 *   - error
 *   - end marker
 */
export type ChatEntry =
  | { readonly id: string; readonly kind: 'user'; readonly text: string }
  | { readonly id: string; readonly kind: 'assistant'; readonly text: string }
  | ToolCallEntry
  | { readonly id: string; readonly kind: 'render'; readonly render: RenderRef }
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
 * A reference to a ggui render.
 *
 * **R5 shape change.** The old `url` field pointed at the public
 * `/r/<shortCode>` HTTP shell (bearer-by-obscurity). R5 retired that
 * surface; the host now reconstructs the iframe HTML CLIENT-SIDE from
 * the render meta envelope (see `Render.tsx` + `html.ts`).
 *
 * `meta` is the parsed `McpAppAiGguiRenderMeta` (single render slice
 * post-Phase-B). When non-undefined, `Render.tsx` builds the inline
 * `__GGUI_META__` HTML and forwards a tool_result carrying the
 * envelope to AppRenderer so the inner iframe receives
 * `ui/notifications/tool-result` on every update.
 *
 * `meta` is initially undefined for SDKs that strip `_meta` from
 * tool_results (Anthropic). `useChat` re-fetches via the wsToken-gated
 * `/api/renders/:renderId/state` endpoint to populate / refresh it.
 */
export interface RenderRef {
  readonly renderId: string;
  readonly action: string;
  readonly contractHash?: string;
  /** Last-known render meta. Updated on render + every update. */
  readonly meta?: McpAppAiGguiRenderMeta;
}
