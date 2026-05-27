/**
 * Tests for `deriveAgentState` — AgentShell's pure character-state
 * derivation from the invoke-SSE message stream. No React, no event
 * listeners, no mutable stack.
 */
import { describe, it, expect } from 'vitest';
import type { ConversationMessage } from '../../../invoke/useInvoke';
import type { UiMoment } from '../../../invoke/ui-moments';
import { deriveAgentState } from '../state-machine';

function userMsg(id: string, text: string): ConversationMessage {
  return { id, role: 'user', content: [{ type: 'text', text }], isStreaming: false };
}

function assistantMsg(
  id: string,
  content: ConversationMessage['content'],
  isStreaming = false,
): ConversationMessage {
  return { id, role: 'assistant', content, isStreaming };
}

function moment(key: string, url: string, renderId: string): UiMoment {
  return { key, renderId, source: { kind: 'render-resource', url } };
}

describe('deriveAgentState', () => {
  it('idle when no messages', () => {
    expect(deriveAgentState({ messages: [], isStreaming: false, uiMoments: [] })).toEqual({
      agentState: 'idle',
      currentMessage: null,
    });
  });

  it('idle when only user messages and not streaming', () => {
    // Edge case — shouldn't normally happen, but useInvoke state
    // momentarily has just the user turn between send() and the first
    // SSE byte.
    expect(
      deriveAgentState({
        messages: [userMsg('u1', 'hi')],
        isStreaming: false,
        uiMoments: [],
      }),
    ).toEqual({ agentState: 'idle', currentMessage: null });
  });

  it('thinking when streaming and latest message is user (pre-first-delta)', () => {
    const out = deriveAgentState({
      messages: [userMsg('u1', 'hi')],
      isStreaming: true,
      uiMoments: [],
    });
    expect(out.agentState).toBe('thinking');
    expect(out.currentMessage).toBeNull();
  });

  it('thinking when streaming and assistant turn has only tool_use so far', () => {
    const out = deriveAgentState({
      messages: [
        userMsg('u1', 'show me'),
        assistantMsg('a1', [{ type: 'tool_use', id: 'toolu', name: 'ggui_render', input: {} }], true),
      ],
      isStreaming: true,
      uiMoments: [],
    });
    expect(out.agentState).toBe('thinking');
  });

  it('presenting when assistant text has arrived, even while streaming', () => {
    const out = deriveAgentState({
      messages: [
        userMsg('u1', 'hi'),
        assistantMsg('a1', [{ type: 'text', text: 'hello there' }], true),
      ],
      isStreaming: true,
      uiMoments: [],
    });
    expect(out.agentState).toBe('presenting');
    expect(out.currentMessage).toBe('hello there');
  });

  it('presenting when at least one UiMoment exists (even with no assistant text)', () => {
    const m = moment('toolu_1', 'https://x.test/item/s/p', 'p');
    const out = deriveAgentState({
      messages: [
        userMsg('u1', 'show me'),
        assistantMsg('a1', [
          { type: 'tool_use', id: 'toolu_1', name: 'ggui_render', input: {} },
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: { renderId: 'p' },
          },
        ]),
      ],
      isStreaming: false,
      uiMoments: [m],
    });
    expect(out.agentState).toBe('presenting');
    expect(out.currentMessage).toBeNull();
  });

  it('currentMessage returns the latest (last) assistant text block, not the first', () => {
    const out = deriveAgentState({
      messages: [
        assistantMsg('a1', [
          { type: 'text', text: 'first' },
          { type: 'tool_use', id: 'toolu', name: 'ggui_render', input: {} },
          { type: 'tool_result', tool_use_id: 'toolu', content: { renderId: 'p' } },
          { type: 'text', text: 'second' },
        ]),
      ],
      isStreaming: false,
      uiMoments: [],
    });
    expect(out.currentMessage).toBe('second');
    expect(out.agentState).toBe('presenting');
  });

  it('skips empty-string text blocks when searching for currentMessage', () => {
    const out = deriveAgentState({
      messages: [
        assistantMsg('a1', [
          { type: 'text', text: 'real text' },
          { type: 'text', text: '' },
        ]),
      ],
      isStreaming: false,
      uiMoments: [],
    });
    expect(out.currentMessage).toBe('real text');
  });

  it('searches backward across messages for currentMessage', () => {
    const out = deriveAgentState({
      messages: [
        assistantMsg('a1', [{ type: 'text', text: 'older' }]),
        userMsg('u2', 'follow-up'),
        assistantMsg('a2', [{ type: 'tool_use', id: 't', name: 'ggui_render', input: {} }], true),
      ],
      isStreaming: true,
      uiMoments: [],
    });
    // Latest assistant's text is empty (only tool_use) → falls back to
    // earlier assistant's text. This is intentional: the bubble should
    // keep showing the most-recent concrete text, not flicker empty
    // while a tool_use is in-flight.
    expect(out.currentMessage).toBe('older');
    // Latest message is assistant BUT without text yet → thinking
    // (user-not-latest but latest-assistant-has-no-text).
    expect(out.agentState).toBe('thinking');
  });
});
