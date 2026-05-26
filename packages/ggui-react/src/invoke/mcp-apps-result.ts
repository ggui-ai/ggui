/**
 * Extractors for MCP-Apps-shaped `ggui_push` tool_result content on the
 * invoke SSE wire — the consumer side of the `@ggui-ai/server`
 * ({@link import('@ggui-ai/server').InvokeStream.toolResultPush}) ↔
 * `@ggui-ai/react` package-API contract.
 *
 * **This is not protocol.** The shape itself (`_meta.ggui.bootstrap` with
 * `wsUrl` / `token` / `expiresAt` / `sessionId` / `appId` / `runtimeUrl`
 * / optional `adapters`) lives in
 * `@ggui-ai/protocol/integrations/mcp-apps` (`PushResultMeta` +
 * `McpAppAiGguiMountView`). These helpers are the ergonomic seam the
 * `@ggui-ai/react` consumer uses to pull the bootstrap out of a
 * `tool_result` content payload without duplicating the type-narrowing
 * logic in every shell. `<McpAppIframe>` mounts from the extracted
 * bootstrap.
 *
 * Round-trip invariant (see `__tests__/mcp-apps-result.roundtrip.test.ts`):
 * an emission via `stream.toolResultPush(id, bootstrap)` on the server
 * MUST parse back cleanly through `parseSseStream` + {@link
 * extractBootstrapMeta} on the client with the original bootstrap
 * recovered bit-for-bit.
 */
import {
  combineMcpAppAiGguiMeta,
  mergeSlicesIntoMountView,
  type McpAppAiGguiMountView,
} from '@ggui-ai/protocol/integrations/mcp-apps';

/**
 * Extract the {@link McpAppAiGguiMountView} from a `tool_result.content`
 * payload emitted by a server that called
 * {@link import('@ggui-ai/server').InvokeStream.toolResultPush}.
 *
 * Returns `null` when the content is missing / malformed / does not
 * carry `_meta.ggui.bootstrap`. Consumers MUST handle the `null` path
 * — a tool_result of the non-bootstrap class (`ggui_update`,
 * `ggui_pop`, `ggui_request_credential`, raw text, etc.) legitimately
 * has no bootstrap, and the shell should ignore it without throwing.
 *
 * @example
 * ```tsx
 * const bootstrap = extractBootstrapMeta(toolResultBlock.content);
 * if (bootstrap) {
 *   return <McpAppIframe
 *     wsUrl={bootstrap.wsUrl}
 *     sessionToken={bootstrap.token}
 *     runtimeUrl={bootstrap.runtimeUrl}
 *   />;
 * }
 * ```
 */
export function extractBootstrapMeta(content: unknown): McpAppAiGguiMountView | null {
  if (content === null || typeof content !== 'object') return null;
  const meta = (content as { _meta?: unknown })._meta;
  const combined = combineMcpAppAiGguiMeta(meta);
  if (!combined.ok) return null;
  const merged = mergeSlicesIntoMountView(combined.slices);
  return merged.ok ? merged.view : null;
}
