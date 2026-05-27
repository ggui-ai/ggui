import type { ContentBlock, InvokeTurn } from '@ggui-ai/protocol';
import type { ConversationMessage } from '../invoke/useInvoke';
import { extractRenderFromToolResult } from './render';

/**
 * A "content group" is one durable-renderable unit from an invoke message:
 *   - a contiguous run of text blocks (one text bubble)
 *   - one tool_use + its paired tool_result (one card bubble)
 *
 * Integrators persist content groups to their storage and reconstruct
 * ConversationMessages from them on thread reopen.
 */
export interface ContentGroup {
  /** Deterministic from `${invokeMessageId}-${startBlockIdx}`. Key for idempotency. */
  key: string;
  kind: 'text' | 'card' | 'other';
  authorRole: 'user' | 'agent';
  blocks: ContentBlock[];
  /** For kind='card' only — a frozen Render extracted from the tool_result. */
  cardSnapshot: unknown | null;
  /** Human-readable ~160-char preview (for chat-list lastMessagePreview). */
  textPreview: string;
}

/**
 * Split a finalized invoke ConversationMessage into ContentGroups.
 * Returns [] when the message is still streaming (nothing durable yet).
 */
export function invokeMessageToContentGroups(message: ConversationMessage): ContentGroup[] {
  if (message.isStreaming) return [];
  const authorRole: 'user' | 'agent' = message.role === 'user' ? 'user' : 'agent';
  const groups: ContentGroup[] = [];
  let i = 0;
  while (i < message.content.length) {
    const b = message.content[i]!;
    if (b.type === 'text') {
      const startIdx = i;
      const textBlocks: ContentBlock[] = [b];
      let j = i + 1;
      while (j < message.content.length && message.content[j]!.type === 'text') {
        textBlocks.push(message.content[j]!);
        j++;
      }
      const preview = textBlocks
        .map((t) => (t.type === 'text' ? t.text : ''))
        .join(' ')
        .slice(0, 160);
      groups.push({
        key: `${message.id}-${startIdx}`,
        kind: 'text',
        authorRole,
        blocks: textBlocks,
        cardSnapshot: null,
        textPreview: preview,
      });
      i = j;
    } else if (b.type === 'tool_use') {
      const paired = message.content.find(
        (x) => x.type === 'tool_result' && x.tool_use_id === b.id,
      );
      const resultBlock = paired ?? null;
      const cardSnapshot = resultBlock ? extractRenderFromToolResult(resultBlock) : null;
      const blocks: ContentBlock[] = resultBlock ? [b, resultBlock] : [b];
      groups.push({
        key: `${message.id}-${i}`,
        kind: b.name === 'ggui_render' || b.name === 'ggui_update' ? 'card' : 'other',
        authorRole,
        blocks,
        cardSnapshot,
        textPreview: '[UI card]',
      });
      i++;
    } else {
      // Standalone tool_result (already absorbed) + other kinds — skip.
      i++;
    }
  }
  return groups;
}

/**
 * Inverse: reassemble ConversationMessages from persisted content groups.
 * Groups sharing the same `${invokeMessageId}` prefix collapse back into
 * a single message — used on thread reopen to seed useInvoke.
 */
export function contentGroupsToConversationMessages(
  groups: ContentGroup[],
): ConversationMessage[] {
  const byInvokeMessageId = new Map<string, ConversationMessage>();
  for (const g of groups) {
    const invokeMessageId = g.key.split('-').slice(0, -1).join('-') || g.key;
    const role: 'user' | 'assistant' = g.authorRole === 'user' ? 'user' : 'assistant';
    const existing = byInvokeMessageId.get(invokeMessageId);
    if (existing) {
      existing.content.push(...g.blocks);
    } else {
      byInvokeMessageId.set(invokeMessageId, {
        id: invokeMessageId,
        role,
        content: [...g.blocks],
        isStreaming: false,
      });
    }
  }
  return Array.from(byInvokeMessageId.values());
}

/** Build wire history from in-memory messages, stripping streaming turns. */
export function conversationMessagesToInvokeHistory(
  messages: ConversationMessage[],
): InvokeTurn[] {
  return messages
    .filter((m) => !(m.role === 'assistant' && m.isStreaming))
    .map((m) => ({ role: m.role, content: m.content }));
}
