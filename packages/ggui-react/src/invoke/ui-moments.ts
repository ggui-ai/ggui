/**
 * UI-moment extraction from invoke-SSE `tool_result` content blocks.
 *
 * A "UI moment" is a point in the assistant turn where the shell should
 * mount an `<AppRenderer>` to render a generated UI. This helper reads
 * a `ConversationMessage[]` (as produced by {@link useInvoke}) and
 * returns the set of moments the shell should render, each with enough
 * material to construct the iframe's `resource` prop.
 *
 * Two recognition paths:
 *
 *   - **GguiSession-resource URL** (the default). The tool_result content
 *     carries `{renderId, ...}` (the
 *     {@link import('@ggui-ai/protocol').GguiRenderOutput} shape —
 *     streamable agents call `stream.toolResult(id, renderOutput)`
 *     from their handler). The host endpoint —
 *     `/api/renders/<renderId>/resource` — mints a renderId-stamped
 *     bootstrap on fetch and returns thin-shell HTML. Requires a
 *     `renderResourceOrigin` option; without one no URL can be built
 *     and the moment is skipped.
 *
 *   - **Inline meta slice.** Agents that call
 *     `stream.toolResultPush(id, meta)` carry the
 *     `_meta["ai.ggui/render"]` slice on the tool_result itself;
 *     {@link extractMcpAppAiGguiMeta} pulls it out as a typed
 *     {@link McpAppAiGguiRenderMeta}, and the shell can build a srcdoc
 *     thin shell client-side, skipping the server round-trip.
 *     Forward-looking — kept so future agents that own full connection
 *     material can emit directly without a render-resource hop.
 *
 * Precedence: the inline meta slice wins when both signals are present
 * (it is the richer payload). A tool_result with neither signal is not
 * a ggui UI moment — it drops silently (agents legitimately emit other
 * tool_results: `ggui_update`, `ggui_request_credential`, raw text,
 * etc.).
 *
 * The helper is pure — no React, no hooks. Shells call it inside a
 * `useMemo(() => extractUiMoments(messages, opts), [messages, opts])`
 * and render the result.
 *
 * Post-Phase-B: the old two-slice `{session, stackItem}` extraction
 * collapses to a single flat `McpAppAiGguiRenderMeta` slice and the
 * `/ggui/session-resource/item/<sid>/<itemId>` URL collapses to
 * `/api/renders/<renderId>/resource`.
 */
import type { ConversationMessage } from './useInvoke';
import { extractMcpAppAiGguiMeta } from './mcp-apps-result';
import type { McpAppAiGguiRenderMeta } from '@ggui-ai/protocol/integrations/mcp-apps';

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
   * GguiSession identity. For render-resource moments this is `renderId`
   * from {@link import('@ggui-ai/protocol').GguiRenderOutput}. For
   * inline-meta moments this is `renderId` from the render slice.
   */
  readonly renderId: string;

  readonly source:
    | {
        readonly kind: 'render-resource';
        /**
         * Fully-qualified URL the shell passes to the MCP-Apps
         * renderer's `resource.uri`. Shape:
         * `<origin>/api/renders/<renderId>/resource`.
         */
        readonly url: string;
      }
    | {
        readonly kind: 'bootstrap-inline';
        /**
         * Parsed {@link McpAppAiGguiRenderMeta} slice extracted from
         * the tool-result's `_meta`. The shell can render the render
         * directly (no second server round-trip).
         */
        readonly meta: McpAppAiGguiRenderMeta;
      };
}

export interface ExtractUiMomentsOptions {
  /**
   * Origin for render-resource URL construction. Trailing slashes are
   * trimmed. Path shape appended: `/api/renders/<renderId>/resource`.
   *
   * When absent, render-resource tool_results are skipped — a UI
   * moment requires either a valid URL or an inline meta slice.
   * Typical value: the agent's own origin (hosted MCP / `ggui serve`
   * endpoint), NOT a third-party. The mount target (the shell /
   * platform iframe) MUST have network access to this origin.
   */
  readonly renderResourceOrigin?: string;
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
  const origin = trimTrailingSlashes(options.renderResourceOrigin);
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
          renderId: meta.renderId,
          source: { kind: 'bootstrap-inline', meta },
        });
        continue;
      }

      // GguiSession-resource moment — GguiRenderOutput shape. Requires an
      // origin; skip silently when there is no URL to build.
      if (origin === undefined) continue;
      const rendered = extractRenderCoordinates(block.content);
      if (rendered === null) continue;
      out.push({
        key: block.tool_use_id,
        renderId: rendered.renderId,
        source: {
          kind: 'render-resource',
          url: `${origin}/api/renders/${encodeURIComponent(rendered.renderId)}/resource`,
        },
      });
    }
  }

  return out;
}

/**
 * Pull `{renderId}` from a tool_result content payload shaped like
 * {@link import('@ggui-ai/protocol').GguiRenderOutput}. Tolerant of
 * one level of wrapping (e.g. `{result: renderOutput}`) — same
 * tolerance as `useInvoke`'s internal `extractRenderIdFromContent`.
 * Returns `null` when the shape doesn't match.
 */
function extractRenderCoordinates(
  content: unknown,
): { readonly renderId: string } | null {
  if (content === null || typeof content !== 'object') return null;
  const top = content as Record<string, unknown>;
  if (typeof top['renderId'] === 'string') {
    return { renderId: top['renderId'] };
  }
  for (const value of Object.values(top)) {
    if (value === null || typeof value !== 'object') continue;
    const inner = value as Record<string, unknown>;
    if (typeof inner['renderId'] === 'string') {
      return { renderId: inner['renderId'] };
    }
  }
  return null;
}

function trimTrailingSlashes(origin: string | undefined): string | undefined {
  if (origin === undefined) return undefined;
  return origin.replace(/\/+$/, '');
}
