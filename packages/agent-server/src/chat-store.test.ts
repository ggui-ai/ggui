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

  it('creates a row with the appending principal as owner', () => {
    const store = createInMemoryChatStore();
    store.append({
      chatId: 'chat_a',
      ownerId: 'guest_x',
      message: ASSISTANT_MSG,
      now: 1000,
    });
    const rec = store.get('chat_a');
    expect(rec?.row.ownerId).toBe('guest_x');
    expect(rec?.row.createdAt).toBe(1000);
    expect(rec?.row.updatedAt).toBe(1000);
    expect(rec?.snapshot.messages).toEqual([ASSISTANT_MSG]);
  });

  it('preserves ownerId on subsequent appends — second writer cant hijack', () => {
    const store = createInMemoryChatStore();
    store.append({
      chatId: 'chat_b',
      ownerId: 'guest_first',
      message: ASSISTANT_MSG,
      now: 1000,
    });
    store.append({
      chatId: 'chat_b',
      ownerId: 'guest_attacker',
      message: RESULT_MSG,
      now: 2000,
    });
    const rec = store.get('chat_b');
    expect(rec?.row.ownerId).toBe('guest_first');
    // updatedAt advanced to the second write's timestamp.
    expect(rec?.row.updatedAt).toBe(2000);
    expect(rec?.row.createdAt).toBe(1000);
    expect(rec?.snapshot.messages).toEqual([ASSISTANT_MSG, RESULT_MSG]);
  });

  it('keeps snapshots independent across chats', () => {
    const store = createInMemoryChatStore();
    store.append({
      chatId: 'chat_x',
      ownerId: 'guest_x',
      message: ASSISTANT_MSG,
    });
    store.append({
      chatId: 'chat_y',
      ownerId: 'guest_y',
      message: RESULT_MSG,
    });
    expect(store.get('chat_x')?.snapshot.messages).toEqual([ASSISTANT_MSG]);
    expect(store.get('chat_y')?.snapshot.messages).toEqual([RESULT_MSG]);
    expect(store.get('chat_x')?.row.ownerId).toBe('guest_x');
    expect(store.get('chat_y')?.row.ownerId).toBe('guest_y');
  });
});
