import { describe, it, expect } from 'vitest';
import type { ContentBlock } from '@ggui-ai/protocol';
import type { ConversationMessage } from '../../invoke/useInvoke';
import {
  invokeMessageToContentGroups,
  contentGroupsToConversationMessages,
  conversationMessagesToInvokeHistory,
} from '../message-groups';

function msg(
  id: string,
  role: ConversationMessage['role'],
  content: ContentBlock[],
  isStreaming = false,
): ConversationMessage {
  return { id, role, content, isStreaming };
}

describe('invokeMessageToContentGroups', () => {
  it('returns [] for streaming messages', () => {
    const m = msg('msg_1', 'assistant', [{ type: 'text', text: 'partial' }], true);
    expect(invokeMessageToContentGroups(m)).toEqual([]);
  });

  it('collapses contiguous text blocks into a single text group', () => {
    const m = msg('msg_2', 'assistant', [
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'world' },
    ]);
    const groups = invokeMessageToContentGroups(m);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe('text');
    expect(groups[0]!.key).toBe('msg_2-0');
    expect(groups[0]!.textPreview).toBe('Hello  world');
    expect(groups[0]!.blocks).toHaveLength(2);
  });

  it('pairs tool_use with its tool_result as a card group', () => {
    const tu: ContentBlock = {
      type: 'tool_use',
      id: 'tu_1',
      name: 'ggui_render',
      input: {},
    } as ContentBlock;
    const tr: ContentBlock = {
      type: 'tool_result',
      tool_use_id: 'tu_1',
      content: { id: 'cmp_1', componentCode: 'x' },
    } as ContentBlock;
    const m = msg('msg_3', 'assistant', [tu, tr]);
    const groups = invokeMessageToContentGroups(m);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe('card');
    expect(groups[0]!.blocks).toHaveLength(2);
    expect(groups[0]!.cardSnapshot).toEqual({ id: 'cmp_1', componentCode: 'x' });
  });

  it('tags non-ggui tool_use as "other", not "card"', () => {
    const tu: ContentBlock = {
      type: 'tool_use',
      id: 'tu_2',
      name: 'fetch_weather',
      input: {},
    } as ContentBlock;
    const m = msg('msg_4', 'assistant', [tu]);
    const groups = invokeMessageToContentGroups(m);
    expect(groups[0]!.kind).toBe('other');
    expect(groups[0]!.cardSnapshot).toBeNull();
  });

  it('interleaves text and card groups preserving order and keys', () => {
    const tu: ContentBlock = {
      type: 'tool_use',
      id: 'tu_3',
      name: 'ggui_render',
      input: {},
    } as ContentBlock;
    const tr: ContentBlock = {
      type: 'tool_result',
      tool_use_id: 'tu_3',
      content: { id: 'cmp_2', componentCode: 'y' },
    } as ContentBlock;
    const m = msg('msg_5', 'assistant', [
      { type: 'text', text: 'Pulling that up…' },
      tu,
      tr,
      { type: 'text', text: ' done.' },
    ]);
    const groups = invokeMessageToContentGroups(m);
    expect(groups.map((g) => g.kind)).toEqual(['text', 'card', 'text']);
    expect(groups.map((g) => g.key)).toEqual(['msg_5-0', 'msg_5-1', 'msg_5-3']);
  });

  it('carries authorRole=user for user messages', () => {
    const m = msg('u1', 'user', [{ type: 'text', text: 'hi' }]);
    const groups = invokeMessageToContentGroups(m);
    expect(groups[0]!.authorRole).toBe('user');
  });
});

describe('contentGroupsToConversationMessages', () => {
  it('reassembles groups from the same invokeMessageId into one message', () => {
    const tu: ContentBlock = {
      type: 'tool_use',
      id: 'tu_1',
      name: 'ggui_render',
      input: {},
    } as ContentBlock;
    const tr: ContentBlock = {
      type: 'tool_result',
      tool_use_id: 'tu_1',
      content: { id: 'cmp_1', componentCode: 'x' },
    } as ContentBlock;
    const original = msg('msg_6', 'assistant', [
      { type: 'text', text: 'Pulling that up…' },
      tu,
      tr,
      { type: 'text', text: ' done.' },
    ]);
    const groups = invokeMessageToContentGroups(original);
    const rebuilt = contentGroupsToConversationMessages(groups);

    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0]!.id).toBe('msg_6');
    expect(rebuilt[0]!.role).toBe('assistant');
    expect(rebuilt[0]!.content).toHaveLength(4);
    expect(rebuilt[0]!.isStreaming).toBe(false);
  });

  it('preserves hyphenated ids (UUID-like clientMessageIds)', () => {
    const id = 'c1a2b3-4d5e-6f7a-8b9c-0d1e2f3a4b5c';
    const original = msg(id, 'user', [{ type: 'text', text: 'hi' }]);
    const groups = invokeMessageToContentGroups(original);
    const rebuilt = contentGroupsToConversationMessages(groups);
    expect(rebuilt[0]!.id).toBe(id);
  });

  it('separates groups with different invokeMessageIds into different messages', () => {
    const groupA = invokeMessageToContentGroups(
      msg('msg_a', 'user', [{ type: 'text', text: 'hi' }]),
    );
    const groupB = invokeMessageToContentGroups(
      msg('msg_b', 'assistant', [{ type: 'text', text: 'hi back' }]),
    );
    const rebuilt = contentGroupsToConversationMessages([...groupA, ...groupB]);
    expect(rebuilt).toHaveLength(2);
    expect(rebuilt[0]!.role).toBe('user');
    expect(rebuilt[1]!.role).toBe('assistant');
  });
});

describe('conversationMessagesToInvokeHistory', () => {
  it('strips only streaming assistant turns', () => {
    const streaming: ConversationMessage = {
      id: 'msg_x',
      role: 'assistant',
      content: [{ type: 'text', text: 'wip' }],
      isStreaming: true,
    };
    const finalized: ConversationMessage = {
      id: 'msg_y',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      isStreaming: false,
    };
    const user: ConversationMessage = {
      id: 'u1',
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
      isStreaming: false,
    };
    const history = conversationMessagesToInvokeHistory([user, finalized, streaming]);
    expect(history).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ]);
  });
});
