/**
 * UI-moment extraction from invoke-SSE `tool_result` content blocks.
 *
 * A "UI moment" is a point in the assistant turn where the shell should
 * mount an `<McpAppIframe>` to render a generated UI. This helper reads a
 * `ConversationMessage[]` (as produced by {@link useInvoke}) and returns
 * the set of moments the shell should render, each with enough material
 * to construct the iframe's `resource` prop.
 *
 * Two recognition paths:
 *
 *   - **Session-resource URL** (the default). The tool_result content
 *     carries `{sessionId, stackItemId, ...}` (the
 *     {@link import('@ggui-ai/protocol').GguiPushOutput} shape —
 *     streamable agents call `stream.toolResult(id, pushOutput)` from
 *     their handler). The host endpoint —
 *     `/ggui/session-resource/item/<sid>/<stackItemId>` — mints a
 *     stackItemId-stamped bootstrap on fetch and returns thin-shell
 *     HTML. Requires a `sessionResourceOrigin` option; without one no
 *     URL can be built and the moment is skipped.
 *
 *   - **Inline meta pair.** Agents that call
 *     `stream.toolResultPush(id, meta)` carry the
 *     `_meta["ai.ggui/session"]` + `_meta["ai.ggui/stack-item"]`
 *     slices on the tool_result itself; {@link extractMcpAppAiGguiMeta}
 *     pulls them out as a typed {@link McpAppAiGguiMeta} pair, and the
 *     shell can build a srcdoc thin shell client-side, skipping the
 *     server round-trip. Forward-looking — kept so future agents that
 *     own full connection material can emit directly without a
 *     session-resource hop.
 *
 * Precedence: the inline meta pair wins when both signals are present
 * (it is the richer payload). A tool_result with neither signal is not
 * a ggui
 * UI moment — it drops silently (agents legitimately emit other
 * tool_results: `ggui_update`, `ggui_pop`, raw text, etc.).
 *
 * The helper is pure — no React, no hooks. Shells call it inside a
 * `useMemo(() => extractUiMoments(messages, opts), [messages, opts])`
 * and render the result.
 */
import type { ConversationMessage } from './useInvoke';
import { extractMcpAppAiGguiMeta } from './mcp-apps-result';
import type { McpAppAiGguiMeta } from '@ggui-ai/protocol/integrations/mcp-apps';

/**
 * A single UI-moment the shell should render. Exactly one
 * `<AppRenderer>` per moment, keyed by {@link UiMoment.key}.
 */
export interface UiMoment {
  /**
   * Stable React key — the `tool_use_id` from the paired tool_use block.
   * Unique per-assistant-turn by construction (MCP pairs tool_use with
   * its tool_result by this id).
   */
  readonly key: string;

  /**
   * Stack item id. For session-resource moments this is `stackItemId`
   * from {@link import('@ggui-ai/protocol').GguiPushOutput}. For
   * inline-meta moments this is `stackItemId` from the stack-item slice
   * when present, falling back to `key` (targeting the whole session
   * when no item is pinned).
   */
  readonly itemId: string;

  readonly source:
    | {
        readonly kind: 'session-resource';
        /**
         * Fully-qualified URL the shell passes to the MCP-Apps
         * renderer's `resource.uri`. Shape:
         * `<origin>/ggui/session-resource/item/<sid>/<stackItemId>`.
         */
        readonly url: string;
      }
    | {
        readonly kind: 'bootstrap-inline';
        /**
         * Parsed {@link McpAppAiGguiMeta} pair extracted from the
         * tool-result's `_meta` slices. The shell can render the
         * session + stack-item directly (no second server round-trip).
         */
        readonly meta: McpAppAiGguiMeta;
      };
}

export interface ExtractUiMomentsOptions {
  /**
   * Origin for session-resource URL construction. Trailing slashes are
   * trimmed. Path shape appended:
   * `/ggui/session-resource/item/<sessionId>/<stackItemId>`.
   *
   * When absent, session-resource tool_results are skipped — a UI
   * moment requires either a valid URL or an inline meta pair.
   * Typical value: the agent's own origin (hosted MCP / `ggui serve`
   * endpoint), NOT a third-party. The mount target (the shell /
   * platform iframe) MUST have network access to this origin.
   */
  readonly sessionResourceOrigin?: string;
}

/**
 * Scan `messages` for tool_result blocks that carry a ggui UI moment
 * and return the render list. Order preserved (message order → content
 * block order). Runs in O(N) over total content blocks.
 */
export function extractUiMoments(
  messages: readonly ConversationMessage[],
  options: ExtractUiMomentsOptions = {},
): readonly UiMoment[] {
  const origin = trimTrailingSlashes(options.sessionResourceOrigin);
  const out: UiMoment[] = [];

  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type !== 'tool_result') continue;

      // Inline meta first — it is the richer signal. An agent
      // that emitted `toolResultPush` carries everything needed, so
      // the server round-trip can be skipped.
      const meta = extractMcpAppAiGguiMeta(block.content);
      if (meta !== null) {
        out.push({
          key: block.tool_use_id,
          itemId: meta.stackItem?.stackItemId ?? block.tool_use_id,
          source: { kind: 'bootstrap-inline', meta },
        });
        continue;
      }

      // Session-resource moment — GguiPushOutput shape. Requires an
      // origin; skip silently when there is no URL to build.
      if (origin === undefined) continue;
      const push = extractPushCoordinates(block.content);
      if (push === null) continue;
      out.push({
        key: block.tool_use_id,
        itemId: push.stackItemId,
        source: {
          kind: 'session-resource',
          url: `${origin}/ggui/session-resource/item/${encodeURIComponent(push.sessionId)}/${encodeURIComponent(push.stackItemId)}`,
        },
      });
    }
  }

  return out;
}

/**
 * Pull `{sessionId, stackItemId}` from a tool_result content payload shaped
 * like {@link import('@ggui-ai/protocol').GguiPushOutput}. Tolerant of
 * one level of wrapping (e.g. `{result: pushOutput}`) — same tolerance
 * as `useInvoke`'s internal `extractSessionIdFromContent`. Returns
 * `null` when the shape doesn't match.
 */
function extractPushCoordinates(
  content: unknown,
): { readonly sessionId: string; readonly stackItemId: string } | null {
  if (content === null || typeof content !== 'object') return null;
  const top = content as Record<string, unknown>;
  if (typeof top['sessionId'] === 'string' && typeof top['stackItemId'] === 'string') {
    return { sessionId: top['sessionId'], stackItemId: top['stackItemId'] };
  }
  for (const value of Object.values(top)) {
    if (value === null || typeof value !== 'object') continue;
    const inner = value as Record<string, unknown>;
    if (typeof inner['sessionId'] === 'string' && typeof inner['stackItemId'] === 'string') {
      return { sessionId: inner['sessionId'], stackItemId: inner['stackItemId'] };
    }
  }
  return null;
}

function trimTrailingSlashes(origin: string | undefined): string | undefined {
  if (origin === undefined) return undefined;
  return origin.replace(/\/+$/, '');
}
