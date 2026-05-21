// Client-side types for the chat shell.

export type LayoutMode = 'inline' | 'panel';

/**
 * One conversational turn in the chat log. A turn is either:
 *   - user prompt
 *   - assistant text segment
 *   - tool-call (the agent invoked a tool; the result lands on the
 *     same entry asynchronously when the SDK forwards the tool_result)
 *   - rendered stack item (the actual MCP App iframe — these are the
 *     "live" surfaces, kept across turns regardless of layout mode)
 *   - error
 *   - end marker
 */
export type ChatEntry =
  | { readonly id: string; readonly kind: 'user'; readonly text: string }
  | { readonly id: string; readonly kind: 'assistant'; readonly text: string }
  | ToolCallEntry
  | { readonly id: string; readonly kind: 'stack-item'; readonly stackItem: StackItemRef }
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
 * A reference to a ggui-rendered stack item. The host iframe loads
 * `url`, which carries the bootstrap meta inline so the iframe self-
 * subscribes to the live channel.
 *
 * `bootstrap` is the spec-compliant `_meta.ggui.bootstrap` envelope
 * the host forwards to the iframe via postMessage. The Anthropic SDK
 * strips `_meta` from tool_result blocks (the API spec only carries
 * text content), so we recover it via the `/api/bootstrap/<shortCode>`
 * JSON endpoint (fetched asynchronously after the stack item lands or
 * gets updated). When non-undefined, `<McpAppIframe>` posts it to the
 * iframe so iframe-runtime re-applies state without re-subscribing.
 */
export interface StackItemRef {
  readonly stackItemId: string;
  readonly sessionId: string;
  readonly url: string;
  readonly action: string;
  readonly contractHash?: string;
  /** Last-known bootstrap envelope. Updated on push + every update. */
  readonly bootstrap?: Record<string, unknown>;
}
