/**
 * Agent history — derives a flat HistoryEntry[] from the invoke-SSE
 * conversation for AgentShell's history panel.
 *
 * This hook derives history entries purely from the `messages` array,
 * replacing an earlier WebSocket-event-listener approach that appended
 * entries as `window` bridge events arrived. Per-message timestamps
 * are cached in a ref so React re-renders don't rewrite history clocks.
 */
import { useMemo, useRef } from 'react';
import type { ConversationMessage } from '../../invoke/useInvoke';

export interface HistoryEntry {
  readonly id: string;
  readonly timestamp: number;
  readonly sender: 'user' | 'agent';
  readonly type: 'message' | 'thinking' | 'data' | 'component';
  readonly text: string;
}

export interface UseAgentHistoryOptions {
  readonly messages: readonly ConversationMessage[];
}

export interface UseAgentHistoryReturn {
  readonly entries: readonly HistoryEntry[];
}

export function useAgentHistory({ messages }: UseAgentHistoryOptions): UseAgentHistoryReturn {
  // Stable per-message timestamps. Messages are identified by their id;
  // once we've seen a message we freeze its history timestamp so later
  // renders don't rewrite the clock (would feel jittery in the panel).
  const timestampsRef = useRef<Map<string, number>>(new Map());

  const entries = useMemo(() => buildEntries(messages, timestampsRef.current), [messages]);

  return { entries };
}

function buildEntries(
  messages: readonly ConversationMessage[],
  timestamps: Map<string, number>,
): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  const now = Date.now();
  for (const msg of messages) {
    let ts = timestamps.get(msg.id);
    if (ts === undefined) {
      ts = now;
      timestamps.set(msg.id, ts);
    }
    if (msg.role === 'user') {
      const text = msg.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (text.length > 0) {
        out.push({
          id: `h-${msg.id}-user`,
          timestamp: ts,
          sender: 'user',
          type: 'message',
          text,
        });
      }
      continue;
    }
    // Assistant — one entry per text block so multi-part turns preserve
    // the natural break (pre-text, post-text around a tool_use pair).
    let blockIndex = 0;
    for (const block of msg.content) {
      if (block.type === 'text' && block.text.length > 0) {
        out.push({
          id: `h-${msg.id}-${blockIndex}`,
          timestamp: ts,
          sender: 'agent',
          type: 'message',
          text: block.text,
        });
      }
      blockIndex += 1;
    }
  }
  return out;
}
