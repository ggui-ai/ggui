/**
 * Per-process in-memory chat snapshot store.
 *
 * Each chat (server-allocated id) accumulates its normalized SDK
 * message stream so the GET `/agent?chatId=X` rehydration endpoint
 * can replay it on a fresh browser tab. Snapshots are non-durable on
 * purpose — the slice mirrors how a chat shell stores its current
 * session's artifacts; cross-restart persistence is a separate
 * concern handled (when needed) by a custom `ChatStore`
 * implementation injected at server boot.
 */
import { randomBytes } from 'node:crypto';
import type { ChatStateSnapshot, NormalizedMessage } from './types.js';

const BASE62 =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * Mint a fresh `chat_<22-char base62>` id from 16 random bytes.
 * 22 chars × 6 bits/char = 132 bits of entropy — overshoots 128 by
 * one char, keeping the alphabet URL-safe (no padding).
 */
export function mintChatId(): string {
  const bytes = randomBytes(16);
  let n = 0n;
  for (let i = 0; i < bytes.length; i++) {
    n = (n << 8n) | BigInt(bytes[i] as number);
  }
  let out = '';
  for (let i = 0; i < 22; i++) {
    out = BASE62[Number(n % 62n)] + out;
    n /= 62n;
  }
  return `chat_${out}`;
}

/**
 * Minimal in-memory snapshot store. Constructed once per
 * `startAgentServer` call and held by the request handlers.
 *
 * Operator override: pass a custom `ChatStore` to the server options
 * to swap in a durable backend (Redis, DynamoDB, …). The interface
 * stays narrow — three operations — so swap is cheap.
 */
export interface ChatStore {
  /** Return the snapshot for `chatId`, or `undefined` if unknown. */
  get(chatId: string): ChatStateSnapshot | undefined;
  /**
   * Append a message to the snapshot, creating the row on first
   * write. Implementations MUST be safe across concurrent writers
   * for the same chatId (the SSE write loop is single-writer per
   * chat, but a future implementation might multiplex).
   */
  append(chatId: string, message: NormalizedMessage): void;
}

export function createInMemoryChatStore(): ChatStore {
  const map = new Map<string, ChatStateSnapshot>();
  return {
    get(chatId) {
      return map.get(chatId);
    },
    append(chatId, message) {
      let snap = map.get(chatId);
      if (!snap) {
        snap = { chatId, messages: [] };
        map.set(chatId, snap);
      }
      snap.messages.push(message);
    },
  };
}
