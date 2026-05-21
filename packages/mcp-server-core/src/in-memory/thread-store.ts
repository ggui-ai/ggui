/**
 * InMemoryThreadStore — reference implementation of {@link ThreadStore}.
 *
 * Intended for tests, dev, and the OSS `@ggui-ai/mcp-server` in its
 * zero-config / ephemeral mode. No persistence across process restarts,
 * no cross-process fanout. `seq` allocation is single-threaded within
 * the JS turn, so monotonic + gap-free per thread is free.
 *
 * Production bindings (SQLite reference impl, DDB SaaS binding) MUST
 * pass {@link threadStoreContract}. Their behavior is specified there,
 * not here.
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
import { isThreadStateAction } from '@ggui-ai/protocol';
import {
  InvalidThreadActionError,
  ObserveMessagesOptions,
  ThreadActionInvalidStateError,
  ThreadNotFoundError,
  ThreadStore,
} from '../thread-store.js';

interface ThreadBucket {
  thread: Thread;
  /** Messages in append order; seq is (index + 1). */
  messages: ThreadMessage[];
  /** (threadId, key) → message, for O(1) idempotency dedupe. */
  byKey: Map<string, ThreadMessage>;
  /** Tail subscribers waiting for the next append or store-level removal. */
  waiters: Array<(m: ThreadMessage | null) => void>;
}

export interface InMemoryThreadStoreOptions {
  /** Injected clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Injected id generator. Defaults to a counter-based `thr_N` id. */
  idGenerator?: () => string;
}

const MAX_TITLE_LENGTH = 120;
const DEFAULT_MESSAGES_LIMIT = 100;
const DEFAULT_THREADS_LIMIT = 50;

export class InMemoryThreadStore implements ThreadStore {
  private readonly buckets = new Map<string, ThreadBucket>();
  private readonly now: () => number;
  private readonly idGenerator: () => string;
  private idCounter = 0;

  constructor(opts: InMemoryThreadStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.idGenerator = opts.idGenerator ?? (() => `thr_${++this.idCounter}`);
  }

  async createThread(
    ownerId: ThreadOwnerId,
    input: CreateThreadInput,
  ): Promise<Thread> {
    const id = this.idGenerator();
    if (this.buckets.has(id)) {
      throw new Error(
        `InMemoryThreadStore.createThread: id collision: ${id}`,
      );
    }
    const iso = new Date(this.now()).toISOString();
    const title = deriveTitle(input.firstMessageHint);
    const thread: Thread = {
      id,
      appId: input.appId,
      ownerId,
      lastSeq: 0,
      unreadCount: 0,
      pinned: false,
      muted: false,
      status: 'active',
      createdAt: iso,
      updatedAt: iso,
      ...(title !== undefined ? { title } : {}),
      ...(input.metadata !== undefined ? { metadata: { ...input.metadata } } : {}),
    };
    this.buckets.set(id, {
      thread,
      messages: [],
      byKey: new Map(),
      waiters: [],
    });
    return cloneThread(thread);
  }

  async getThread(
    ownerId: ThreadOwnerId,
    threadId: string,
  ): Promise<Thread | null> {
    const bucket = this.buckets.get(threadId);
    if (!bucket || bucket.thread.ownerId !== ownerId) return null;
    return cloneThread(bucket.thread);
  }

  async listThreads(
    ownerId: ThreadOwnerId,
    filter: ListThreadsFilter,
  ): Promise<ListThreadsResult> {
    const threads: Thread[] = [];
    for (const bucket of this.buckets.values()) {
      const t = bucket.thread;
      if (t.ownerId !== ownerId) continue;
      if (filter.appId !== undefined && t.appId !== filter.appId) continue;
      if (filter.status !== undefined && t.status !== filter.status) continue;
      threads.push(cloneThread(t));
    }
    threads.sort(compareThreadsMostRecentFirst);
    const offset = parseCursor(filter.cursor);
    const limit = filter.limit ?? DEFAULT_THREADS_LIMIT;
    const page = threads.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    const out: ListThreadsResult = { threads: page };
    if (nextOffset < threads.length) {
      out.nextCursor = `offset:${nextOffset}`;
    }
    return out;
  }

  async appendMessage(
    ownerId: ThreadOwnerId,
    input: AppendThreadMessageInput,
  ): Promise<ThreadMessage> {
    const bucket = this.requireOwnedBucket(ownerId, input.threadId);

    // Idempotency: first-write-wins on (threadId, key). Return the
    // originally stored row, NOT the caller's new payload.
    const existing = bucket.byKey.get(input.key);
    if (existing) return cloneMessage(existing);

    const seq = bucket.thread.lastSeq + 1;
    const iso = new Date(this.now()).toISOString();
    const message: ThreadMessage = {
      threadId: input.threadId,
      key: input.key,
      seq,
      at: iso,
      authorRole: input.authorRole,
      kind: input.kind,
      blocks: cloneJson(input.blocks) as unknown[],
      textPreview: input.textPreview,
      ...(input.cardSnapshot !== undefined
        ? { cardSnapshot: cloneJson(input.cardSnapshot) }
        : {}),
      ...(input.aiContext !== undefined
        ? { aiContext: cloneJson(input.aiContext) }
        : {}),
    };
    bucket.messages.push(message);
    bucket.byKey.set(input.key, message);

    bucket.thread.lastSeq = seq;
    bucket.thread.lastMessageAt = iso;
    bucket.thread.updatedAt = iso;
    if (input.authorRole !== 'user') {
      bucket.thread.unreadCount += 1;
    }

    // Fan out to tail subscribers in FIFO order. The waiter list is
    // cleared on every emit because each waiter only pulls one event;
    // they re-queue via the iterator's next `await` if they want more.
    for (const waiter of bucket.waiters.splice(0)) waiter(message);

    return cloneMessage(message);
  }

  async listMessages(
    ownerId: ThreadOwnerId,
    threadId: string,
    options: ListMessagesOptions,
  ): Promise<ListMessagesResult> {
    const bucket = this.requireOwnedBucket(ownerId, threadId);
    const fromSeq = options.fromSeq ?? 1;
    const limit = options.limit ?? DEFAULT_MESSAGES_LIMIT;
    const offset = parseCursor(options.cursor);

    const startIndex = findStartIndex(bucket.messages, fromSeq) + offset;
    const page = bucket.messages
      .slice(startIndex, startIndex + limit)
      .map(cloneMessage);

    const out: ListMessagesResult = { messages: page };
    const consumedIndex = startIndex + page.length;
    if (consumedIndex < bucket.messages.length) {
      // Cursor encodes offset RELATIVE to the fromSeq starting point
      // so callers can page forward by reusing fromSeq + new cursor.
      out.nextCursor = `offset:${offset + page.length}`;
    }
    return out;
  }

  async applyAction(
    ownerId: ThreadOwnerId,
    threadId: string,
    action: ThreadStateAction,
  ): Promise<Thread> {
    // Shape error: reject unknown strings before any ownership check.
    // This is NOT an ownership leak — the caller already knew they
    // supplied an invalid string. (In TS the parameter is typed, but
    // handlers may pass user-controlled values through; checking keeps
    // the store honest under dynamic call sites too.)
    if (!isThreadStateAction(action)) {
      throw new InvalidThreadActionError(String(action));
    }
    const bucket = this.requireOwnedBucket(ownerId, threadId);
    const t = bucket.thread;
    const prev: Thread = cloneThread(t);

    switch (action) {
      case 'pin':
        t.pinned = true;
        break;
      case 'unpin':
        t.pinned = false;
        break;
      case 'mute':
        t.muted = true;
        break;
      case 'unmute':
        t.muted = false;
        break;
      case 'archive':
        if (t.status === 'pending_delete') {
          throw new ThreadActionInvalidStateError(action, t.status);
        }
        t.status = 'archived';
        break;
      case 'unarchive':
        if (t.status === 'pending_delete') {
          throw new ThreadActionInvalidStateError(action, t.status);
        }
        t.status = 'active';
        break;
      case 'mark_read':
        t.unreadCount = 0;
        break;
      case 'request_delete':
        t.status = 'pending_delete';
        break;
      case 'restore':
        if (t.status !== 'pending_delete') {
          throw new ThreadActionInvalidStateError(action, t.status);
        }
        t.status = 'active';
        break;
    }

    // Only bump updatedAt when state actually changed. Idempotent
    // no-ops (pin on pinned, etc.) leave ordering stable.
    if (!threadsEquivalent(prev, t)) {
      t.updatedAt = new Date(this.now()).toISOString();
    }
    return cloneThread(t);
  }

  observeMessages(
    ownerId: ThreadOwnerId,
    threadId: string,
    options: ObserveMessagesOptions = {},
  ): AsyncIterable<ThreadMessage> {
    const fromSeq = options.fromSeq ?? 1;
    const tail = options.tail ?? true;
    const getBucket = (): ThreadBucket | undefined =>
      this.buckets.get(threadId);

    return {
      [Symbol.asyncIterator](): AsyncIterator<ThreadMessage> {
        let nextSeq = fromSeq;
        let done = false;
        let checkedOwnership = false;
        return {
          async next(): Promise<IteratorResult<ThreadMessage>> {
            if (done) return { value: undefined, done: true };
            const bucket = getBucket();
            if (!bucket) {
              done = true;
              // The thread never existed (or was hard-removed before
              // the first pull). Surface that as not-found on the
              // first pull only.
              if (!checkedOwnership) {
                checkedOwnership = true;
                throw new ThreadNotFoundError(threadId);
              }
              return { value: undefined, done: true };
            }
            if (!checkedOwnership) {
              checkedOwnership = true;
              if (bucket.thread.ownerId !== ownerId) {
                done = true;
                throw new ThreadNotFoundError(threadId);
              }
            }
            // Backlog: find the first queued message with seq >= nextSeq.
            const backlog = bucket.messages.find((m) => m.seq >= nextSeq);
            if (backlog) {
              nextSeq = backlog.seq + 1;
              return { value: cloneMessage(backlog), done: false };
            }
            if (!tail) {
              done = true;
              return { value: undefined, done: true };
            }
            const message = await new Promise<ThreadMessage | null>(
              (resolve) => {
                bucket.waiters.push(resolve);
              },
            );
            if (message === null) {
              done = true;
              return { value: undefined, done: true };
            }
            // A late-breaking append may have seq < nextSeq only if the
            // caller rewinds fromSeq below an already-delivered seq —
            // contract test forbids that case. In the forward-only path
            // we always advance.
            nextSeq = message.seq + 1;
            return { value: cloneMessage(message), done: false };
          },
          async return(): Promise<IteratorResult<ThreadMessage>> {
            done = true;
            // Release any waiter we might hold — best-effort, the
            // promise settles with null and the next() path closes.
            return { value: undefined, done: true };
          },
        };
      },
    };
  }

  private requireOwnedBucket(
    ownerId: ThreadOwnerId,
    threadId: string,
  ): ThreadBucket {
    const bucket = this.buckets.get(threadId);
    if (!bucket || bucket.thread.ownerId !== ownerId) {
      throw new ThreadNotFoundError(threadId);
    }
    return bucket;
  }
}

function deriveTitle(hint: string | undefined): string | undefined {
  if (hint === undefined) return undefined;
  const trimmed = hint.trim();
  if (trimmed === '') return undefined;
  return trimmed.length > MAX_TITLE_LENGTH
    ? trimmed.slice(0, MAX_TITLE_LENGTH)
    : trimmed;
}

function compareThreadsMostRecentFirst(a: Thread, b: Thread): number {
  const aKey = a.lastMessageAt ?? a.createdAt;
  const bKey = b.lastMessageAt ?? b.createdAt;
  if (aKey !== bKey) return aKey < bKey ? 1 : -1;
  return a.id.localeCompare(b.id);
}

function findStartIndex(messages: ThreadMessage[], fromSeq: number): number {
  if (fromSeq <= 1) return 0;
  // Linear scan — fine for reference impl; SQLite will index by seq.
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.seq >= fromSeq) return i;
  }
  return messages.length;
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const match = cursor.match(/^offset:(\d+)$/);
  if (!match) return 0;
  const n = Number(match[1]);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function cloneThread(t: Thread): Thread {
  return {
    ...t,
    ...(t.metadata !== undefined ? { metadata: { ...t.metadata } } : {}),
  };
}

function cloneMessage(m: ThreadMessage): ThreadMessage {
  return {
    ...m,
    blocks: cloneJson(m.blocks) as unknown[],
    ...(m.cardSnapshot !== undefined
      ? { cardSnapshot: cloneJson(m.cardSnapshot) }
      : {}),
    ...(m.aiContext !== undefined
      ? { aiContext: cloneJson(m.aiContext) }
      : {}),
  };
}

function cloneJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneJson);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = cloneJson(v);
  }
  return out;
}

function threadsEquivalent(a: Thread, b: Thread): boolean {
  return (
    a.pinned === b.pinned &&
    a.muted === b.muted &&
    a.status === b.status &&
    a.unreadCount === b.unreadCount
  );
}
