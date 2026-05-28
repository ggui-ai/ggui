/**
 * Public types for {@link useMcpAppsChat}.
 *
 * The hook is the canonical place inside `@ggui-ai/react` where an
 * MCP-Apps-spec SDK message stream gets mapped onto:
 *
 *   - `entries[]`   — a flat, render-ready chat log (user prompts,
 *                     assistant text, tool calls, embedded renders,
 *                     errors, end markers).
 *   - `renders[]`   — every MCP-Apps resource the agent has produced
 *                     this conversation, ready to mount via
 *                     `<AppRenderer toolResourceUri={...}>`.
 *
 * Host apps build the React chat panel directly from these types; the
 * sample apps lean on this layer rather than redoing the
 * `_meta.ui.resourceUri` extraction in each integration.
 */

/**
 * Host-display-mode hint, parsed from the most-recent render's
 * `_meta.ui.displayMode` (spec-native MCP-Apps SEP-1865).
 */
export type HostDisplayMode = 'inline' | 'fullscreen' | 'pip';

/**
 * A reference to one MCP-Apps resource the agent has surfaced, ready to
 * mount via `<AppRenderer toolResourceUri={...}>`. The host fetches the
 * iframe HTML by passing `resourceUri` to AppRenderer plus a matching
 * `onReadResource` callback (typically a relay endpoint on the agent
 * backend that proxies the MCP `resources/read` call). All live-update
 * mechanics (WebSocket, state polling, partial patches) are the server-
 * rendered HTML's concern — the host stays brand-neutral.
 */
export interface RenderRef {
  /**
   * MCP-Apps spec-canonical resource URI from `_meta.ui.resourceUri` on
   * the tool result. Stable per render: re-emits of the same URI (e.g.
   * an `*_update` tool returning the same URI) coalesce onto the same
   * iframe entry via {@link RenderRef} dedupe.
   */
  readonly resourceUri: string;
  /**
   * Free-form label describing how this render arrived (`'render'` for
   * live emissions, `'restored'` for snapshot rehydration). Treat as
   * opaque chrome metadata.
   */
  readonly action: string;
  /**
   * Optional tool-call id of the tool whose result carried this URI.
   * Useful for chat panels that want to cross-link renders to the
   * tool-call entry that produced them.
   */
  readonly toolUseId?: string;
}

/**
 * Tool-call entry. The agent emitted a `tool_use` block on one SSE
 * frame; the matching `tool_result` block lands on a later frame.
 * `result` / `isError` populate when the matching tool_result arrives.
 */
export interface ToolCallEntry {
  readonly id: string;
  readonly kind: 'tool-call';
  /** Anthropic's `tool_use_id` (or equivalent unique per-call id). */
  readonly toolUseId: string;
  readonly name: string;
  readonly input: unknown;
  readonly result?: unknown;
  readonly isError?: boolean;
}

/**
 * One conversational turn in the chat log.
 *
 *   - `user`      — prompt the user typed (or the iframe synthesized via
 *                   `ui/message` SEP-1865).
 *   - `assistant` — text segment from the agent.
 *   - `tool-call` — the agent invoked a tool; the result lands on the
 *                   same entry asynchronously when the SDK forwards the
 *                   matching `tool_result` block.
 *   - `render`    — an MCP-Apps resource iframe — one per unique
 *                   `_meta.ui.resourceUri`.
 *   - `error`     — terminal error from the agent or the transport.
 *   - `end`       — turn-completed marker (`subtype` is the SDK's
 *                   `result.subtype`, opaque to the chat panel).
 */
export type ChatEntry =
  | { readonly id: string; readonly kind: 'user'; readonly text: string }
  | { readonly id: string; readonly kind: 'assistant'; readonly text: string }
  | ToolCallEntry
  | { readonly id: string; readonly kind: 'render'; readonly render: RenderRef }
  | { readonly id: string; readonly kind: 'error'; readonly text: string }
  | { readonly id: string; readonly kind: 'end'; readonly subtype: string };
