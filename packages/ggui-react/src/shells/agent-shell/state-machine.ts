/**
 * Agent state machine — derives character presentation state from the
 * invoke-SSE stream.
 *
 * This machine is a pure derivation from
 * `{messages, isStreaming, uiMoments}`, replacing an earlier
 * WebSocket-event-listener approach that watched a mutable stack for
 * code arrival. The transitions are computed inside `useMemo` instead
 * of accumulated via event handlers.
 *
 * State rules:
 *   - `idle` — no messages yet, or not streaming and no agent content.
 *   - `thinking` — streaming AND no assistant text has arrived yet this
 *     turn (latest message is user OR latest assistant message has only
 *     tool_use blocks so far). Character animates; input shows the
 *     pending cursor.
 *   - `presenting` — an assistant text block has landed OR at least one
 *     UiMoment exists. Character shows the bubble; screen mounts the
 *     iframe.
 *
 * `currentMessage` is the most recent assistant text-block content
 * (what the bubble displays above the character). Null when no
 * assistant text has arrived yet.
 */
import { useMemo } from 'react';
import type { ConversationMessage } from '../../invoke/useInvoke';
import type { UiMoment } from '../../invoke/ui-moments';
import type { AgentState } from './types';

export interface UseAgentStateOptions {
  readonly messages: readonly ConversationMessage[];
  readonly isStreaming: boolean;
  readonly uiMoments: readonly UiMoment[];
}

export interface UseAgentStateReturn {
  readonly agentState: AgentState;
  readonly currentMessage: string | null;
}

export function useAgentState(options: UseAgentStateOptions): UseAgentStateReturn {
  return useMemo(() => deriveAgentState(options), [options.messages, options.isStreaming, options.uiMoments]);
}

/**
 * Pure derivation — exported for unit tests + any caller that wants to
 * compute the state without a React hook.
 */
export function deriveAgentState({
  messages,
  isStreaming,
  uiMoments,
}: UseAgentStateOptions): UseAgentStateReturn {
  const latestAssistantText = findLatestAssistantText(messages);
  const hasUiMoment = uiMoments.length > 0;
  const latestMessage = messages[messages.length - 1];
  const latestIsUser = latestMessage?.role === 'user';
  // Specifically whether the CURRENT (latest) assistant message has
  // landed text yet — not whether any prior one did. Fallback to the
  // older text for the bubble (see `currentMessage`) is independent:
  // the bubble can keep last-text stale while the character ticks to
  // 'thinking' for the new turn.
  const latestAssistantHasOwnText =
    latestMessage?.role === 'assistant' &&
    latestMessage.content.some((b) => b.type === 'text' && b.text.length > 0);

  let agentState: AgentState;
  if (isStreaming && (latestIsUser || !latestAssistantHasOwnText)) {
    agentState = 'thinking';
  } else if (latestAssistantText !== null || hasUiMoment) {
    agentState = 'presenting';
  } else {
    agentState = 'idle';
  }

  return { agentState, currentMessage: latestAssistantText };
}

/**
 * Walk `messages` backward and return the most-recent non-empty
 * assistant text block. Exported for reuse by other shells (e.g.
 * FullscreenShell's skeleton + WelcomePage thinking line).
 *
 * @internal — not part of the public `@ggui-ai/react` surface.
 */
export function findLatestAssistantText(messages: readonly ConversationMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || msg.role !== 'assistant') continue;
    for (let j = msg.content.length - 1; j >= 0; j -= 1) {
      const block = msg.content[j];
      if (block && block.type === 'text' && block.text.length > 0) {
        return block.text;
      }
    }
  }
  return null;
}
