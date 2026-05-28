/**
 * Public types for {@link useMcpAppsChat}.
 *
 * The hook is the canonical place inside `@ggui-ai/react` where an
 * MCP-Apps-spec SDK message stream gets mapped onto:
 *
 *   - `entries[]`   — a flat, render-ready chat log (user prompts,
 *                     assistant text, tool calls, embedded renders,
 *                     errors, end markers).
 *   - `renders[]`   — every ggui render the agent has produced this
 *                     conversation, ready to mount via `<AppRenderer>`.
 *
 * Host apps build the React chat panel directly from these types; the
 * sample-agents (claude / openai / google) lean on this layer rather
 * than redoing the meta-extraction in each integration.
 */
import type { McpAppAiGguiRenderMeta } from '@ggui-ai/protocol/integrations/mcp-apps';

/**
 * Host-display-mode hint, parsed from the most-recent render's
 * `_meta.ui.displayMode` (spec-native MCP-Apps SEP-1865). Apps that
 * stamp `App.defaultDisplayMode` on their ggui server config will pass
 * this through unchanged; agents can override per-render via
 * `ggui_render.input.displayMode`.
 */
export type HostDisplayMode = 'inline' | 'fullscreen' | 'pip';

/**
 * A reference to a ggui render, ready to mount via `<AppRenderer>`.
 *
 * `meta` is the parsed slice envelope (`McpAppAiGguiRenderMeta`); when
 * defined the host can build the iframe HTML + a spec-canonical
 * `ui/notifications/tool-result` envelope from it. `meta` is initially
 * `undefined` for SDKs that strip `_meta` from `tool_result` blocks
 * (Anthropic's Messages API spec only permits text content); the hook
 * lazily recovers it via the wsToken-gated `/api/renders/:id/state`
 * endpoint (configurable via `useMcpAppsChat({ stateEndpoint })`).
 */
export interface RenderRef {
  readonly renderId: string;
  /**
   * The action the agent took (`'create'` for ggui_render, sometimes
   * `'restored'` for envelopes rehydrated from a chat snapshot, etc.).
   * Treat as opaque — the sample uses it as a chrome label.
   */
  readonly action: string;
  readonly contractHash?: string;
  /** Last-known render meta. Updated on render + every update. */
  readonly meta?: McpAppAiGguiRenderMeta;
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
 *   - `render`    — the actual MCP Apps iframe — one per ggui_render.
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
