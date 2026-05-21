/**
 * FullChatStorageAdapter surface — replicated (not imported) so this
 * package stays React-free and can be consumed from both web-view
 * clients and non-React clients. TypeScript structural typing means
 * the returned adapter is assignable to the SDK's
 * `FullChatStorageAdapter` (exported from `@ggui-ai/react-native/
 * chat-thread`) without explicit casts.
 */
import type { ContentBlock } from '@ggui-ai/protocol';

export interface StoredMessage {
  /** Idempotency key — unique per `(threadId, key)`. */
  key: string;
  threadId: string;
  authorRole: 'user' | 'agent' | 'system';
  kind: 'text' | 'card' | 'event';
  blocks: ContentBlock[];
  cardSnapshot: unknown | null;
  textPreview: string;
  /** Server-assigned ordering. ASC chronological. */
  seq: number;
  /** ISO timestamp. */
  at: string;
  /** Opaque integrator metadata (appId, model, shellType, …). */
  aiContext?: unknown;
}

export interface MessageStorageAdapter {
  loadMessages(threadId: string): Promise<StoredMessage[]>;
  observeMessages(
    threadId: string,
    onNext: (messages: StoredMessage[]) => void,
    onError?: (err: Error) => void,
  ): () => void;
  appendMessage(input: {
    threadId: string;
    key: string;
    authorRole: StoredMessage['authorRole'];
    kind: StoredMessage['kind'];
    blocks: StoredMessage['blocks'];
    cardSnapshot?: unknown;
    textPreview: string;
    aiContext?: unknown;
  }): Promise<StoredMessage>;
}

export type ThreadStateAction =
  | 'pin'
  | 'unpin'
  | 'mute'
  | 'unmute'
  | 'archive'
  | 'unarchive'
  | 'mark_read'
  | 'request_delete'
  | 'restore';

export interface ThreadActionsAdapter {
  updateThreadState(threadId: string, action: ThreadStateAction): Promise<void>;
}

export interface FullChatStorageAdapter
  extends MessageStorageAdapter,
    ThreadActionsAdapter {}
