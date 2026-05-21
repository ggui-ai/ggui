/**
 * Persistent-chat wire types for OSS `@ggui-ai/mcp-server` and its
 * adapters.
 *
 * Paired with the Portal-side `FullChatStorageAdapter` contract in
 * `packages/chat-managed-amplify/src/createAdapter.ts` — this file's
 * vocabulary (action names, author roles, message kinds, idempotency
 * semantics) matches that adapter verbatim so both cloud and self-
 * hosted implementations speak the same shape.
 *
 * These types are protocol-level because they cross the wire between
 * self-hosted clients (Portal) and self-hosted servers (`ggui serve`)
 * + between SDK adapter packages and server handler implementations.
 * Internal server state (e.g., per-thread sequencer counters) stays
 * in `@ggui-ai/mcp-server-core` and is NOT exposed here.
 *
 * Out of scope for v1:
 *   - cross-origin thread federation
 *   - multi-user / shared threads
 *   - server-driven push-notification delivery (channel is here, pipe
 *     isn't)
 *   - search within threads
 *
 * Rule of thumb: these shapes are the public wire contract.
 * **Additions are additive forever** (consumer adapters dedupe on
 * fields they know). Breaking changes require a protocol version bump.
 */

/**
 * Opaque identity owning a thread.
 *
 * - Hosted-cloud origins → Cognito sub (`cognito_<sub>`) or guest
 *   install id (`guest_<uuidv4>`). Wire shape identical; ownership is
 *   derived per-auth-mode on the server.
 * - Self-hosted origins → the subject the `AuthAdapter` resolves a
 *   pairing bearer token to (implementation-defined, typically
 *   `paired_<pairingId>`).
 *
 * The server never needs to parse this; it's an opaque string that
 * partitions thread rows. The SDK adapter likewise treats it as
 * opaque.
 */
export type ThreadOwnerId = string;

/** Message author roles. Matches the cloud adapter verbatim. */
export type ThreadMessageAuthor = 'user' | 'agent' | 'system';

/** Message content kinds. Matches the cloud adapter verbatim. */
export type ThreadMessageKind = 'text' | 'card' | 'event';

/** Thread lifecycle states. */
export type ThreadStatus = 'active' | 'archived' | 'pending_delete';

/**
 * The 9-action state machine that mutates per-thread UI state. Identical
 * vocabulary to `packages/chat-managed-amplify/src/createAdapter.ts#
 * ThreadStateAction` so both cloud and self-hosted adapters dispatch
 * through the same call. Every action is idempotent with respect to
 * its target state — `pin` twice leaves the thread pinned; `unpin` on
 * an unpinned thread is a no-op; `restore` requires
 * `status === 'pending_delete'` or is rejected.
 */
export const THREAD_STATE_ACTIONS = [
  'pin',
  'unpin',
  'mute',
  'unmute',
  'archive',
  'unarchive',
  'mark_read',
  'request_delete',
  'restore',
] as const;
export type ThreadStateAction = (typeof THREAD_STATE_ACTIONS)[number];

export function isThreadStateAction(value: unknown): value is ThreadStateAction {
  return (
    typeof value === 'string' &&
    (THREAD_STATE_ACTIONS as readonly string[]).includes(value)
  );
}

/**
 * A persistent conversation.
 *
 * Pinned to its origin at creation; origin-awareness lives on the
 * client. A thread exists on exactly one origin for its entire
 * lifetime — there is no migration path.
 */
export interface Thread {
  id: string;
  /** App this thread belongs to. */
  appId: string;
  /** Opaque owner identity — see {@link ThreadOwnerId}. */
  ownerId: ThreadOwnerId;
  /** Optional human-readable title. Initially derived from the
   *  `firstMessageHint` supplied at creation, or the app name if
   *  absent. Editable later (not part of v1 transport, but the field
   *  is here so the shape is forward-compatible). */
  title?: string;
  /** Monotonic sequence of the latest message. Starts at 0 on create;
   *  bumps on every `appendMessage`. */
  lastSeq: number;
  /** ISO timestamp of the last message append. Absent until the
   *  first message exists. */
  lastMessageAt?: string;
  /** Unread count from the owner's perspective. Incremented by
   *  `appendMessage`, zeroed by `mark_read`. */
  unreadCount: number;
  pinned: boolean;
  muted: boolean;
  status: ThreadStatus;
  createdAt: string;
  updatedAt: string;
  /** Opaque per-thread metadata — integrators may attach
   *  servingRegion, shellType hints, etc. Not interpreted by the
   *  server; forwarded verbatim on reads. */
  metadata?: Record<string, unknown>;
}

/**
 * One message within a thread. Append-only — messages are never
 * edited or deleted in place; thread state mutations use
 * {@link ThreadStateAction} instead.
 *
 * `seq` is server-assigned and monotonic per thread, starting at 1.
 * `key` is the caller-supplied idempotency key — a duplicate `key`
 * on append returns the existing row (the appended row's `seq` and
 * `at` stay stable across retries).
 */
export interface ThreadMessage {
  threadId: string;
  /** Idempotency key. Unique per `(threadId, key)`. */
  key: string;
  /** Monotonic within a thread; starts at 1. */
  seq: number;
  /** ISO timestamp of server receipt. */
  at: string;
  authorRole: ThreadMessageAuthor;
  kind: ThreadMessageKind;
  /** Content blocks. The OSS protocol does not constrain block shape
   *  beyond JSON-serializability; integrators typically put the same
   *  ContentBlock vocabulary `@ggui-ai/protocol/types/invoke.ts` uses
   *  (text + tool_use + tool_result + thinking). Kept `unknown[]` here
   *  so the wire stays forward-compatible when the block vocabulary
   *  widens. */
  blocks: unknown[];
  /** Card snapshot — populated when `kind === 'card'`. Opaque. */
  cardSnapshot?: unknown;
  /** Short text preview used in transcript lists + search indexing. */
  textPreview: string;
  /** Opaque integrator context (appId, model, shellType, etc.). */
  aiContext?: unknown;
}

// ─── Request / response shapes (transport-facing) ──────────────────────

/**
 * Input to `createThread` / `POST /threads`.
 */
export interface CreateThreadInput {
  appId: string;
  /** A hint the server may use to seed the thread title or be echoed
   *  to the agent as the conversation opener. Not stored as a message
   *  by default — a subsequent `appendMessage` with the user's real
   *  first message is the load-bearing write. */
  firstMessageHint?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Input to `appendMessage` / `POST /threads/{id}/messages`.
 */
export interface AppendThreadMessageInput {
  threadId: string;
  key: string;
  authorRole: ThreadMessageAuthor;
  kind: ThreadMessageKind;
  blocks: unknown[];
  cardSnapshot?: unknown;
  /** Required — keeps compact transcript views honest. Callers that
   *  have nothing visual to show should still pass an empty string
   *  explicitly to make that choice auditable. */
  textPreview: string;
  aiContext?: unknown;
}

/**
 * Input to `listMessages` / `GET /threads/{id}/messages`.
 */
export interface ListMessagesOptions {
  /** First `seq` to include. Default: 1. */
  fromSeq?: number;
  /** Max messages to return. Default: 100. Hard ceiling enforced
   *  server-side — implementations MAY cap below this. */
  limit?: number;
  /** Opaque cursor for pagination. Format is implementation-local;
   *  clients pass the previous response's cursor verbatim. */
  cursor?: string;
}

export interface ListMessagesResult {
  messages: ThreadMessage[];
  /** Cursor for the next page. Absent when no more pages. */
  nextCursor?: string;
}

/**
 * Filter shape for `listThreads` / `GET /threads`.
 */
export interface ListThreadsFilter {
  /** Restrict by status. Omit for all statuses. */
  status?: ThreadStatus;
  /** Restrict by app. Omit for all apps. */
  appId?: string;
  /** Max threads to return. Default: 50. */
  limit?: number;
  cursor?: string;
}

export interface ListThreadsResult {
  threads: Thread[];
  nextCursor?: string;
}

/**
 * SSE stream event emitted by `GET /threads/{id}/stream`.
 *
 * Every event carries the message's `seq` so reconnecting clients can
 * resume with `?fromSeq=<last-seen-seq + 1>`. Delivery is
 * at-least-once; consumers dedupe by `(threadId, seq)`.
 */
export interface ThreadStreamEvent {
  /** Discriminator — makes future event kinds additive-forward. */
  type: 'thread-message';
  message: ThreadMessage;
}

export function isThreadStreamEvent(value: unknown): value is ThreadStreamEvent {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v['type'] === 'thread-message' && typeof v['message'] === 'object';
}
