/**
 * Extractors for MCP-Apps-shaped `ggui_push` tool_result content on the
 * invoke SSE wire — the consumer side of the `@ggui-ai/server`
 * ({@link import('@ggui-ai/server').InvokeStream.toolResultPush}) ↔
 * `@ggui-ai/react` package-API contract.
 *
 * **This is not protocol.** The wire shape (the two `ai.ggui/*` keys on
 * `_meta`) lives in `@ggui-ai/protocol/integrations/mcp-apps`
 * (`McpAppAiGguiSessionMeta` + `McpAppAiGguiStackItemMeta`, grouped as
 * {@link McpAppAiGguiMeta}). These helpers are the ergonomic seam the
 * `@ggui-ai/react` consumer uses to pull the slice pair out of a
 * `tool_result` content payload without duplicating the type-narrowing
 * logic in every shell.
 *
 * Round-trip invariant (see `__tests__/mcp-apps-result.roundtrip.test.ts`):
 * an emission via `stream.toolResultPush(id, meta)` on the server
 * MUST parse back cleanly through `parseSseStream` + {@link
 * extractMcpAppAiGguiMeta} on the client with the original meta
 * recovered bit-for-bit.
 */
import {
  parseMcpAppAiGguiMeta,
  type McpAppAiGguiMeta,
} from '@ggui-ai/protocol/integrations/mcp-apps';

/**
 * Extract the {@link McpAppAiGguiMeta} pair from a `tool_result.content`
 * payload emitted by a server that called
 * {@link import('@ggui-ai/server').InvokeStream.toolResultPush}.
 *
 * Returns `null` when the content is missing / malformed / carries no
 * `ai.ggui/*` keys. Consumers MUST handle the `null` path — a
 * tool_result of the non-bootstrap class (`ggui_update`, `ggui_pop`,
 * `ggui_request_credential`, raw text, etc.) legitimately carries no
 * `ai.ggui/*` slices, and the shell should ignore it without throwing.
 *
 * @example
 * ```tsx
 * const meta = extractMcpAppAiGguiMeta(toolResultBlock.content);
 * if (meta?.session) {
 *   return <AppRenderer session={meta.session} stackItem={meta.stackItem} />;
 * }
 * ```
 */
export function extractMcpAppAiGguiMeta(
  content: unknown,
): McpAppAiGguiMeta | null {
  if (content === null || typeof content !== 'object') return null;
  const meta = (content as { _meta?: unknown })._meta;
  const parsed = parseMcpAppAiGguiMeta(meta);
  if (!parsed.ok) return null;
  // Both slices absent ⇒ no `ai.ggui/*` meta on this tool_result.
  if (parsed.meta.session === undefined && parsed.meta.stackItem === undefined) {
    return null;
  }
  return parsed.meta;
}

/**
 * Back-compat alias for {@link extractMcpAppAiGguiMeta}. Name retained
 * pre-R4; downstream consumers (samples, app shells) keep working.
 */
export const extractBootstrapMeta = extractMcpAppAiGguiMeta;
