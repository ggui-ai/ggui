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
export { synthesizeUserActionPrompt } from './user-action-prompt';
export type {
  ChatEntry,
  HostDisplayMode,
  RenderRef,
  ToolCallEntry,
} from './mcp-apps-chat-types';
