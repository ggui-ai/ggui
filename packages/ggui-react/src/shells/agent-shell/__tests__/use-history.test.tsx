/**
 * Tests for `useAgentHistory` — pure derivation of HistoryEntry[] from
 * invoke-SSE messages. Uses React Testing Library's renderHook to
 * exercise the timestamp-caching useRef behaviour on re-renders.
 */
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ConversationMessage } from '../../../invoke/useInvoke';
import { useAgentHistory } from '../use-history';

function userMsg(id: string, text: string): ConversationMessage {
  return { id, role: 'user', content: [{ type: 'text', text }], isStreaming: false };
}

function assistantMsg(
  id: string,
  content: ConversationMessage['content'],
): ConversationMessage {
  return { id, role: 'assistant', content, isStreaming: false };
}

describe('useAgentHistory', () => {
  it('returns empty entries for empty messages', () => {
    const { result } = renderHook(() => useAgentHistory({ messages: [] }));
    expect(result.current.entries).toEqual([]);
  });

  it('maps user message to a single history entry', () => {
    const { result } = renderHook(() =>
      useAgentHistory({ messages: [userMsg('u1', 'hello')] }),
    );
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0]).toMatchObject({
      sender: 'user',
      type: 'message',
      text: 'hello',
    });
    expect(typeof result.current.entries[0]?.timestamp).toBe('number');
  });

  it('maps each assistant text block to its own history entry', () => {
    const { result } = renderHook(() =>
      useAgentHistory({
        messages: [
          assistantMsg('a1', [
            { type: 'text', text: 'first' },
            { type: 'tool_use', id: 'toolu', name: 'ggui_render', input: {} },
            { type: 'tool_result', tool_use_id: 'toolu', content: { renderId: 'p' } },
            { type: 'text', text: 'second' },
          ]),
        ],
      }),
    );
    expect(result.current.entries).toHaveLength(2);
    expect(result.current.entries.map((e) => e.text)).toEqual(['first', 'second']);
    expect(result.current.entries.every((e) => e.sender === 'agent')).toBe(true);
  });

  it('skips empty-text blocks and tool_use / tool_result content', () => {
    const { result } = renderHook(() =>
      useAgentHistory({
        messages: [
          assistantMsg('a1', [
            { type: 'text', text: '' },
            { type: 'tool_use', id: 't', name: 'x', input: {} },
            { type: 'tool_result', tool_use_id: 't', content: {} },
          ]),
        ],
      }),
    );
    expect(result.current.entries).toEqual([]);
  });

  it('preserves message order across user/assistant turns', () => {
    const { result } = renderHook(() =>
      useAgentHistory({
        messages: [
          userMsg('u1', 'Q1'),
          assistantMsg('a1', [{ type: 'text', text: 'A1' }]),
          userMsg('u2', 'Q2'),
          assistantMsg('a2', [{ type: 'text', text: 'A2' }]),
        ],
      }),
    );
    expect(result.current.entries.map((e) => `${e.sender}:${e.text}`)).toEqual([
      'user:Q1',
      'agent:A1',
      'user:Q2',
      'agent:A2',
    ]);
  });

  it('reuses timestamps for messages seen in prior renders', () => {
    const messages: ConversationMessage[] = [userMsg('u1', 'hi')];
    const { result, rerender } = renderHook(
      ({ m }: { m: ConversationMessage[] }) => useAgentHistory({ messages: m }),
      { initialProps: { m: messages } },
    );
    const tsBefore = result.current.entries[0]?.timestamp;
    expect(typeof tsBefore).toBe('number');

    // Advance time so Date.now() changes between renders.
    const realNow = Date.now;
    let mockNow = tsBefore!;
    Date.now = () => {
      mockNow += 5000;
      return mockNow;
    };
    try {
      // Re-render with same message id → timestamp should be cached.
      rerender({ m: [...messages] });
      expect(result.current.entries[0]?.timestamp).toBe(tsBefore);

      // Append a new message → gets a fresh timestamp, prior one unchanged.
      rerender({ m: [...messages, userMsg('u2', 'follow')] });
      expect(result.current.entries).toHaveLength(2);
      expect(result.current.entries[0]?.timestamp).toBe(tsBefore);
      expect(result.current.entries[1]?.timestamp).toBeGreaterThan(tsBefore!);
    } finally {
      Date.now = realNow;
    }
  });
});
