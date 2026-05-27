/**
 * ThreadStore — persistent + observable persistent-chat state.
 *
 * Companion to {@link RenderStore}. Render state is ephemeral;
 * thread state is durable. A self-hosted `@ggui-ai/mcp-server` binds
 * this against SQLite (the OSS reference impl); the hosted runtime
 * binds this against DDB via an AppSync-fronted adapter in `cloud/`.
 * Both bindings MUST pass the {@link threadStoreContract} suite
 * exported from `@ggui-ai/mcp-server-core/contract-tests`.
 *
 * The interface is the single place ownership, idempotency, ordering,
 * and action semantics are enforced. Handlers and transports are thin
 * over this boundary — they MUST NOT re-assert invariants that the
 * store already guarantees, and they MUST NOT skip the invariants the
 * store expects of its caller.
 */
import type {
  AppendThreadMessageInput,
  CreateThreadInput,
  ListMessagesOptions,
  ListMessagesResult,
  ListThreadsFilter,
  ListThreadsResult,
  Thread,
  ThreadMessage,
  ThreadOwnerId,
  ThreadStateAction,
} from '@ggui-ai/protocol';

/**
 * Thrown by mutation + read-by-id calls when the thread does not exist
 * OR belongs to a different owner. The two cases return the same error
 * **intentionally** — leaking the existence of another owner's thread
 * via a different error code would undo the ownership partition.
 */
export class ThreadNotFoundError extends Error {
  readonly code = 'THREAD_NOT_FOUND';
  constructor(threadId: string) {
    super(`thread not found: ${threadId}`);
    this.name = 'ThreadNotFoundError';
  }
}

/**
 * Thrown by {@link ThreadStore.applyAction} when the action value is
 * not one of the 9 canonical {@link ThreadStateAction} strings. This is
 * a shape error, not a state-machine error.
 */
export class InvalidThreadActionError extends Error {
  readonly code = 'INVALID_THREAD_ACTION';
  constructor(action: string) {
    super(`invalid thread action: ${action}`);
    this.name = 'InvalidThreadActionError';
  }
}

/**
 * Thrown by {@link ThreadStore.applyAction} when the action itself is a
 * valid {@link ThreadStateAction} but the thread's current state does
 * not permit it. Currently raised in two cases:
 *
 *   - `restore` on a thread whose `status !== 'pending_delete'`
 *     (the thread is not recoverable because it isn't in the
 *     "awaiting cascade delete" state).
 *   - `archive` / `unarchive` on a thread whose `status === 'pending_delete'`
 *     (the pending-delete lifecycle is a one-way exit — only `restore`
 *     leaves it).
 *
 * `pin` / `unpin` / `mute` / `unmute` / `mark_read` / `request_delete`
 * do NOT raise this — they are valid in every lifecycle state.
 */
export class ThreadActionInvalidStateError extends Error {
  readonly code = 'THREAD_ACTION_INVALID_STATE';
  constructor(action: ThreadStateAction, currentStatus: string) {
    super(
      `thread action ${action} is not valid in status ${currentStatus}`,
    );
    this.name = 'ThreadActionInvalidStateError';
  }
}

/**
 * Options for {@link ThreadStore.observeMessages}.
 *
 * Ordering, snapshot+tail, and reconnect semantics mirror
 * {@link RenderStore.observe} so callers that already speak the
 * renders pattern can reuse the same mental model.
 */
export interface ObserveMessagesOptions {
  /**
   * First `seq` to deliver. Default: `1` (replay from beginning).
   * On reconnect, pass `lastSeenSeq + 1`.
   */
  fromSeq?: number;
  /**
   * Whether to keep the stream open after historical replay. Default:
   * `true`. Set `false` for a one-shot snapshot fetch (tests, backup
   * tooling).
   */
  tail?: boolean;
}

/**
 * Persistent-chat store. All methods are ownership-scoped — the
 * `ownerId` parameter is load-bearing, not optional. A caller that
 * presents one owner's id can never observe, mutate, or enumerate
 * another owner's thread. Partition is enforced here, not in handlers,
 * so future transports (HTTP, SSE, future MCP resources) cannot
 * accidentally widen the scope.
 *
 * **Normative semantics** (every implementation MUST satisfy these —
 * the contract-test suite {@link threadStoreContract} locks them):
 *
 * - **Ownership.** Every read/write referencing an existing thread
 *   enforces `thread.ownerId === ownerId`. A mismatch is reported as
 *   not-found (see {@link ThreadNotFoundError}).
 *
 * - **Idempotency.** `appendMessage` dedupes on `(threadId, key)`.
 *   A repeat key returns the originally stored message with its
 *   original `seq` and `at` — the new payload is **discarded**.
 *   First-write-wins; consumers rely on this for safe retries.
 *
 * - **Sequencing.** `seq` is server-assigned, monotonic, gap-free,
 *   starts at 1 per thread. `thread.lastSeq` equals the highest seq
 *   appended so far (or 0 before the first append).
 *
 * - **Unread count.** Incremented on every non-user message append
 *   (`authorRole !== 'user'`). A user authoring a message into their
 *   own thread does NOT mark that thread unread for the same owner.
 *   Zeroed by the `mark_read` action.
 *
 * - **Action semantics.** Every {@link ThreadStateAction} is
 *   idempotent with respect to its target state. See the error classes
 *   above for the state-machine rejections. Actions that change state
 *   bump `updatedAt`; no-op actions leave `updatedAt` alone so
 *   ordering by `updatedAt` stays stable.
 *
 * - **Ordering.** `listThreads` returns the owner's threads ordered
 *   most-recently-active first — `lastMessageAt` if present,
 *   otherwise `createdAt`, with `id` as the stable tiebreaker.
 *   `listMessages` returns ASC by `seq`.
 *
 * - **observeMessages.** Snapshot + tail (see
 *   {@link ObserveMessagesOptions}). FIFO within a thread. Delivery is
 *   at-least-once; consumers dedupe on `seq`. The iterable ends
 *   cleanly when the consumer disposes (via `return()`) or the thread
 *   is removed from the store.
 */
export interface ThreadStore {
  /**
   * Create a new thread owned by `ownerId`.
   *
   * - Assigns a fresh id (implementations choose the shape — uuid,
   *   ulid, counter; callers treat it as opaque).
   * - Seeds `title` from `input.firstMessageHint` if provided,
   *   otherwise leaves `title` undefined. The hint is NOT persisted
   *   as a message — the caller is expected to append the user's real
   *   first message separately.
   * - `lastSeq = 0`, `unreadCount = 0`, `pinned = false`,
   *   `muted = false`, `status = 'active'`.
   */
  createThread(
    ownerId: ThreadOwnerId,
    input: CreateThreadInput,
  ): Promise<Thread>;

  /**
   * Fetch a thread by id, scoped to the calling owner. Returns `null`
   * when the thread doesn't exist OR belongs to another owner.
   */
  getThread(
    ownerId: ThreadOwnerId,
    threadId: string,
  ): Promise<Thread | null>;

  /**
   * Enumerate the owner's threads. Only threads where `ownerId`
   * matches are considered. Filtering is AND across all provided
   * fields. Ordering is most-recently-active first (see normative
   * semantics).
   */
  listThreads(
    ownerId: ThreadOwnerId,
    filter: ListThreadsFilter,
  ): Promise<ListThreadsResult>;

  /**
   * Append a message to a thread the caller owns.
   *
   * Idempotent on `(threadId, key)` — see normative semantics. Rejects
   * with {@link ThreadNotFoundError} if the thread does not exist or
   * does not belong to `ownerId`.
   */
  appendMessage(
    ownerId: ThreadOwnerId,
    input: AppendThreadMessageInput,
  ): Promise<ThreadMessage>;

  /**
   * Read a thread's messages in seq-ASC order, owner-scoped. Rejects
   * with {@link ThreadNotFoundError} if the thread does not exist or
   * does not belong to `ownerId`.
   */
  listMessages(
    ownerId: ThreadOwnerId,
    threadId: string,
    options: ListMessagesOptions,
  ): Promise<ListMessagesResult>;

  /**
   * Apply a state-machine action to a thread the caller owns. Returns
   * the updated thread. See error classes above for rejection cases.
   *
   * Unknown action strings raise {@link InvalidThreadActionError}
   * before any ownership check — shape errors are not ownership
   * leaks.
   */
  applyAction(
    ownerId: ThreadOwnerId,
    threadId: string,
    action: ThreadStateAction,
  ): Promise<Thread>;

  /**
   * Subscribe to appended messages on a thread the caller owns.
   * Throws {@link ThreadNotFoundError} synchronously (from the
   * iterator's first `next()`) when the thread does not exist or is
   * not owned by `ownerId`.
   *
   * See {@link ObserveMessagesOptions} + normative semantics.
   */
  observeMessages(
    ownerId: ThreadOwnerId,
    threadId: string,
    options?: ObserveMessagesOptions,
  ): AsyncIterable<ThreadMessage>;
}
