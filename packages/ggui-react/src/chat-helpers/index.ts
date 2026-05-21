/**
 * Pure helpers for chat-shaped integrations. Populated in Chunk 1.2.
 * Do NOT use `export *` here — named re-exports only (parity-test policy).
 */
export { useRafThrottled } from './useRafThrottled';
export { extractStackItemFromToolResult, extractSessionIdFromToolResult } from './stack-item';
export {
  invokeMessageToContentGroups,
  contentGroupsToConversationMessages,
  conversationMessagesToInvokeHistory,
  type ContentGroup,
} from './message-groups';
