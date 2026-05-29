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
// `synthesizeUserActionPrompt` moved to `@ggui-ai/agent-server` —
// directive synthesis happens server-side now so every per-SDK
// backend formats the same imperative prose. Clients just forward
// the spec-canonical `_meta["ai.ggui/userAction"]` slice in the POST
// body's `data.meta`.
export type {
  ChatEntry,
  HostDisplayMode,
  RenderRef,
  ToolCallEntry,
} from './mcp-apps-chat-types';
