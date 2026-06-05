/**
 * Pure helpers for chat-shaped integrations. Populated in Chunk 1.2.
 * Do NOT use `export *` here — named re-exports only (parity-test policy).
 */
export { useRafThrottled } from './useRafThrottled';
export { extractRenderFromToolResult, extractRenderIdFromToolResult } from './render';
export {
  invokeMessageToContentGroups,
  contentGroupsToConversationMessages,
  conversationMessagesToInvokeHistory,
  type ContentGroup,
} from './message-groups';
export { useMcpAppsChat } from './useMcpAppsChat';
export type {
  UseMcpAppsChatOptions,
  UseMcpAppsChatResult,
} from './useMcpAppsChat';
// No userAction directive synthesis lives here (or anywhere server-
// side): the iframe-runtime authors the full "call ggui_consume…"
// directive in the `ui/message` text. The hook's `handleAppMessage`
// forwards that text as the prompt + the content block's `_meta`
// opaquely — this package stays ggui-protocol-agnostic.
export type {
  ChatEntry,
  HostDisplayMode,
  GguiSessionRef,
  ToolCallEntry,
} from './mcp-apps-chat-types';
