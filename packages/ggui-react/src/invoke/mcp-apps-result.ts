/**
 * Extractors for MCP-Apps-shaped `ggui_render` tool_result content on
 * the invoke SSE wire — the consumer side of the `@ggui-ai/server`
 * ({@link import('@ggui-ai/server').InvokeStream.toolResultPush}) ↔
 * `@ggui-ai/react` package-API contract.
 *
 * **This is not protocol.** The wire shape (the `ai.ggui/render` key on
 * `_meta`) lives in `@ggui-ai/protocol/integrations/mcp-apps`
 * ({@link McpAppAiGguiRenderMeta}). These helpers are the ergonomic
 * seam the `@ggui-ai/react` consumer uses to pull the slice out of a
 * `tool_result` content payload without duplicating the type-narrowing
 * logic in every shell.
 *
 * Round-trip invariant (see `__tests__/mcp-apps-result.roundtrip.test.ts`):
 * an emission via `stream.toolResultPush(id, meta)` on the server
 * MUST parse back cleanly through `parseSseStream` + {@link
 * extractMcpAppAiGguiMeta} on the client with the original meta
 * recovered bit-for-bit.
 *
 * Post-Phase-B: the two-slice `{session, stackItem}` shape collapses
 * into a single flat `McpAppAiGguiRenderMeta` slice keyed by
 * `renderId`.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  parseMcpAppAiGguiRenderMeta,
  toMcpAppEnvelope,
  type McpAppAiGguiRenderMeta,
} from '@ggui-ai/protocol/integrations/mcp-apps';

/**
 * Extract the {@link McpAppAiGguiRenderMeta} slice from a
 * `tool_result.content` payload emitted by a server that called
 * {@link import('@ggui-ai/server').InvokeStream.toolResultPush}.
 *
 * Returns `null` when the content is missing / malformed / carries no
 * `ai.ggui/render` key. Consumers MUST handle the `null` path — a
 * tool_result of the non-bootstrap class (`ggui_update`,
 * `ggui_request_credential`, raw text, etc.) legitimately carries no
 * `ai.ggui/render` slice, and the shell should ignore it without
 * throwing.
 *
 * @example
 * ```tsx
 * const meta = extractMcpAppAiGguiMeta(toolResultBlock.content);
 * if (meta) {
 *   return <AppRenderer toolResult={buildAppRendererToolResult(meta)} />;
 * }
 * ```
 */
export function extractMcpAppAiGguiMeta(
  content: unknown,
): McpAppAiGguiRenderMeta | null {
  if (content === null || typeof content !== 'object') return null;
  const meta = (content as { _meta?: unknown })._meta;
  const parsed = parseMcpAppAiGguiRenderMeta(meta);
  if (!parsed.ok) return null;
  // Key absent ⇒ no `ai.ggui/render` slice on this tool_result.
  if (parsed.meta === undefined) {
    return null;
  }
  return parsed.meta;
}

/**
 * Back-compat alias for {@link extractMcpAppAiGguiMeta}. Name retained
 * pre-R4; downstream consumers (samples, app shells) keep working.
 */
export const extractBootstrapMeta = extractMcpAppAiGguiMeta;

/**
 * Build a {@link CallToolResult} carrying the `ai.ggui/render` slice
 * envelope on `_meta`, ready to hand to
 * `<AppRenderer toolResult={...}>` so it forwards the envelope to the
 * inner iframe via the spec-canonical `ui/notifications/tool-result`
 * postMessage. iframe-runtime re-applies state from this envelope on
 * every `ggui_update` after first mount.
 *
 * The lone `as CallToolResult` cast in this helper bridges Zod's
 * `$loose` mode on the MCP SDK's `CallToolResultSchema._meta`: the
 * runtime schema accepts our `ai.ggui/*` extension keys, but the TS-
 * inferred type only enumerates the schema-declared keys
 * (`progressToken`, `io.modelcontextprotocol/related-task`). One
 * centrally-documented cast here is the minimum-cast pattern; call
 * sites get a typed API.
 *
 * @example
 * ```tsx
 * const toolResult = useMemo(() =>
 *   render.meta ? buildAppRendererToolResult(render.meta) : undefined,
 *   [render.meta],
 * );
 * return <AppRenderer toolResult={toolResult} ... />;
 * ```
 */
export function buildAppRendererToolResult(
  meta: McpAppAiGguiRenderMeta,
): CallToolResult {
  return {
    content: [],
    structuredContent: {},
    _meta: toMcpAppEnvelope(meta),
  } as CallToolResult;
}
