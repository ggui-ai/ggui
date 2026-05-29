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
 *
 * Ownership: every chat row carries an `ownerId` stamped at
 * create-time (the principal id resolved by the configured
 * {@link AuthAdapter}). Read paths check ownership before returning
 * the snapshot.
 */
import { randomBytes } from 'node:crypto';
import type { ChatRow } from './auth.js';
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
 * Snapshot + ownership metadata returned together. The chat handler
 * reads both: snapshot for rehydration, row for authorization.
 */
export interface ChatRecord {
  readonly row: ChatRow;
  readonly snapshot: ChatStateSnapshot;
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
  /** Return the record for `chatId`, or `undefined` if unknown. */
  get(chatId: string): ChatRecord | undefined;
  /**
   * Create the row on first write with the given `ownerId`; append
   * the message to the snapshot. Implementations MUST be safe across
   * concurrent writers for the same chatId. The first append wins
   * the `ownerId` write — subsequent appends for the same chatId
   * leave ownership untouched (a malicious second principal can't
   * hijack ownership by racing in).
   */
  append(args: {
    readonly chatId: string;
    readonly ownerId: string;
    readonly message: NormalizedMessage;
    readonly now?: number;
  }): void;
}

export function createInMemoryChatStore(): ChatStore {
  const map = new Map<string, ChatRecord>();
  return {
    get(chatId) {
      return map.get(chatId);
    },
    append({ chatId, ownerId, message, now }) {
      const ts = now ?? Date.now();
      const existing = map.get(chatId);
      if (existing) {
        existing.snapshot.messages.push(message);
        // Replace the row to bump updatedAt; ownerId is preserved
        // from the FIRST write (writing principal owns the chat).
        map.set(chatId, {
          row: {
            chatId: existing.row.chatId,
            ownerId: existing.row.ownerId,
            createdAt: existing.row.createdAt,
            updatedAt: ts,
          },
          snapshot: existing.snapshot,
        });
        return;
      }
      const snapshot: ChatStateSnapshot = { chatId, messages: [message] };
      map.set(chatId, {
        row: { chatId, ownerId, createdAt: ts, updatedAt: ts },
        snapshot,
      });
    },
  };
}
