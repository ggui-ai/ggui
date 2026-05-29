import { describe, expect, it } from 'vitest';
import {
  createInMemoryChatStore,
  mintChatId,
} from './chat-store.js';
import type { NormalizedMessage } from './types.js';

describe('mintChatId', () => {
  it('returns a `chat_` prefix + 22-char base62 suffix', () => {
    const id = mintChatId();
    expect(id.startsWith('chat_')).toBe(true);
    expect(id.length).toBe('chat_'.length + 22);
    expect(id.slice(5)).toMatch(/^[0-9A-Za-z]{22}$/);
  });

  it('is collision-resistant across many mints (no dupes in 10k)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const id = mintChatId();
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });
});

describe('createInMemoryChatStore', () => {
  const ASSISTANT_MSG: NormalizedMessage = {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'hi' }] },
  };
  const RESULT_MSG: NormalizedMessage = {
    type: 'result',
    subtype: 'ok',
  };

  it('returns undefined for an unknown chatId', () => {
    const store = createInMemoryChatStore();
    expect(store.get('chat_missing')).toBeUndefined();
  });

  it('creates a snapshot on first append and returns it', () => {
    const store = createInMemoryChatStore();
    store.append('chat_a', ASSISTANT_MSG);
    const snap = store.get('chat_a');
    expect(snap?.chatId).toBe('chat_a');
    expect(snap?.messages).toEqual([ASSISTANT_MSG]);
  });

  it('appends in insertion order across multiple writes', () => {
    const store = createInMemoryChatStore();
    store.append('chat_b', ASSISTANT_MSG);
    store.append('chat_b', RESULT_MSG);
    const snap = store.get('chat_b');
    expect(snap?.messages).toEqual([ASSISTANT_MSG, RESULT_MSG]);
  });

  it('keeps snapshots independent across chats', () => {
    const store = createInMemoryChatStore();
    store.append('chat_x', ASSISTANT_MSG);
    store.append('chat_y', RESULT_MSG);
    expect(store.get('chat_x')?.messages).toEqual([ASSISTANT_MSG]);
    expect(store.get('chat_y')?.messages).toEqual([RESULT_MSG]);
  });
});
