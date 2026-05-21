/**
 * Storage-adapter interfaces for chat-thread.
 *
 * Two separate concerns behind two separate interfaces:
 *   - `MessageStorageAdapter` — the only surface `useChatThread` requires.
 *     An integrator with their own backend can implement this alone —
 *     no thread-list, pin/mute, or archive semantics required.
 *   - `ThreadActionsAdapter` — optional. Consumed by thread-list UIs
 *     (integrators building a multi-thread chat experience).
 *
 * No AppSync / DDB types leak in: the interfaces speak only in terms
 * of ContentBlock (from @ggui-ai/protocol) and string identifiers.
 */
import type { ContentBlock } from '@ggui-ai/protocol';

export interface StoredMessage {
  /** Idempotency key — matches `ContentGroup.key`. Unique per (threadId, key). */
  key: string;
  threadId: string;
  authorRole: 'user' | 'agent' | 'system';
  kind: 'text' | 'card' | 'event';
  blocks: ContentBlock[];
  cardSnapshot: unknown | null;
  textPreview: string;
  /** Adapter-assigned ordering. ASC chronological. */
  seq: number;
  /** ISO timestamp. */
  at: string;
  /** Opaque metadata the integrator may attach (appId, model, shellType, …). */
  aiContext?: unknown;
}

/**
 * Minimum surface `useChatThread` requires. Self-hosters with their own
 * backend can implement this alone.
 */
export interface MessageStorageAdapter {
  /** Chronological initial load. */
  loadMessages(threadId: string): Promise<StoredMessage[]>;

  /**
   * Live subscription. Implementations may poll, WebSocket, or AppSync
   * observeQuery — the SDK is agnostic. Returns an unsubscribe fn.
   */
  observeMessages(
    threadId: string,
    onNext: (messages: StoredMessage[]) => void,
    onError?: (err: Error) => void,
  ): () => void;

  /** Append one message. MUST be idempotent on (threadId, key). */
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

/**
 * Optional — thread-list UIs only. Kept separate so tier-3 adopters
 * without a thread list never see it in their IDE autocomplete.
 */
export interface ThreadActionsAdapter {
  /**
   * Apply a state transition. Changes propagate via the integrator's
   * thread-list subscription (not `observeMessages`).
   */
  updateThreadState(threadId: string, action: ThreadStateAction): Promise<void>;
}

/**
 * Convenience type for adapters that implement both concerns (e.g. the
 * managed-tier AmplifyGguiAdapter). NOT required by `useChatThread`.
 */
export interface FullChatStorageAdapter
  extends MessageStorageAdapter,
    ThreadActionsAdapter {}
