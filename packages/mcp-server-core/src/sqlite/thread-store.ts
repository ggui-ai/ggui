/**
 * SqliteThreadStore — file-backed reference implementation of
 * {@link ThreadStore}.
 *
 * Ships as the OSS default for `@ggui-ai/mcp-server` when the operator
 * points `ggui serve` at a durable thread file instead of running on
 * the in-memory store. Thread state + message history survive process
 * restart, which is the promise Portal's self-hosted chat relies on.
 *
 * ## Storage layout
 *
 * Two tables, no JSON blobs on the hot path except the blocks/metadata
 * bags that were `unknown[]` / `unknown` at the protocol type level
 * anyway:
 *
 *   - `threads(id PK, app_id, owner_id, title?, last_seq,
 *     last_message_at?, unread_count, pinned, muted, status,
 *     created_at, updated_at, metadata?)`
 *   - `thread_messages(thread_id, seq, key, at, author_role, kind,
 *     blocks JSON, card_snapshot JSON?, text_preview, ai_context JSON?,
 *     PRIMARY KEY (thread_id, seq), UNIQUE (thread_id, key))`
 *
 * Indexes:
 *
 *   - `idx_threads_owner_lastmsg` on `(owner_id, last_message_at)` —
 *     supports list ordering by most-recent-active first.
 *   - `idx_threads_owner_status` on `(owner_id, status)` — supports
 *     `listThreads({status})` filters.
 *
 * The `UNIQUE (thread_id, key)` constraint is load-bearing for
 * idempotency: the write path does SELECT-by-key first and returns the
 * existing row on retry, but the constraint is defense-in-depth against
 * accidental double-inserts under the (currently-impossible) case of
 * two concurrent appends slipping past the transaction's IMMEDIATE
 * lock.
 *
 * ## Concurrency + sequencing
 *
 * `appendMessage` wraps the (read-existing, compute-seq, insert,
 * bump-counters) sequence in a single `BEGIN IMMEDIATE` transaction so
 * `thread_messages.seq` stays gap-free even when two callers race on
 * the same thread. better-sqlite3 runs this synchronously on the
 * single JS thread; the transaction is short.
 *
 * ## Observe semantics — honest subset
 *
 * Historical replay reads directly from `thread_messages` by
 * `(thread_id, seq >= fromSeq)`. Fully persistent; survives restart.
 *
 * Live tailing is served by an in-process waiter map. That's
 * **intentionally narrower** than the interface allows:
 *
 *   - Within one OSS server process, tail works identically to the
 *     in-memory impl.
 *   - Across processes (multi-`ggui serve`, external writer, sidecar),
 *     writers on process B do NOT fan out to observers on process A.
 *     Those observers only see the new messages on their next call
 *     after catching up — effectively poll-on-reconnect.
 *
 * Matches the already-shipped `SqliteGguiSessionStore` story. Cross-process
 * fanout needs an external broker (Postgres LISTEN/NOTIFY, etc.) and
 * belongs to the corresponding adapter package, not here.
 */
import Database, {
  type Database as SqliteDatabase,
  type Statement as SqliteStatement,
} from 'better-sqlite3';
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

export interface SqliteThreadStoreOptions {
  /**
   * SQLite database file path. Pass `:memory:` for ephemeral tests —
   * shares the code path but resets per instance. Default:
   * `./ggui-threads.sqlite` (relative to the process CWD).
   */
  filename?: string;
  /**
   * Existing `better-sqlite3` instance. Useful when the host already
   * manages a shared file for multiple stores (e.g. colocating
   * renders + threads). Mutually exclusive with `filename`; if both
   * are passed, `database` wins.
   */
  database?: SqliteDatabase;
  /** Injected clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Injected id generator. Defaults to counter-based `thr_N`. */
  idGenerator?: () => string;
}

const MAX_TITLE_LENGTH = 120;
const DEFAULT_MESSAGES_LIMIT = 100;
const DEFAULT_THREADS_LIMIT = 50;

/** Shape of a `threads` row. */
interface ThreadRow {
  id: string;
  app_id: string;
  owner_id: string;
  title: string | null;
  last_seq: number;
  last_message_at: string | null;
  unread_count: number;
  pinned: number;
  muted: number;
  status: 'active' | 'archived' | 'pending_delete';
  created_at: string;
  updated_at: string;
  metadata: string | null;
}

/** Shape of a `thread_messages` row. */
interface MessageRow {
  thread_id: string;
  seq: number;
  key: string;
  at: string;
  author_role: 'user' | 'agent' | 'system';
  kind: 'text' | 'card' | 'event';
  blocks: string;
  card_snapshot: string | null;
  text_preview: string;
  ai_context: string | null;
}

type Waiter = (m: ThreadMessage | null) => void;

export class SqliteThreadStore implements ThreadStore {
  private readonly db: SqliteDatabase;
  private readonly ownsDatabase: boolean;
  private readonly now: () => number;
  private readonly idGenerator: () => string;

  /** Fanout: threadId → listeners waiting for the next append/remove. */
  private readonly waiters = new Map<string, Set<Waiter>>();

  private readonly stmts: {
    insertThread: SqliteStatement<unknown[]>;
    getThread: SqliteStatement<unknown[], ThreadRow>;
    listThreads: SqliteStatement<unknown[], ThreadRow>;
    updateThreadState: SqliteStatement<unknown[]>;
    deleteThread: SqliteStatement<unknown[]>;
    deleteMessages: SqliteStatement<unknown[]>;
    insertMessage: SqliteStatement<unknown[]>;
    getMessageByKey: SqliteStatement<unknown[], MessageRow>;
    bumpThreadOnAppend: SqliteStatement<unknown[]>;
    selectMessagesFromSeq: SqliteStatement<unknown[], MessageRow>;
    selectOneFromSeq: SqliteStatement<unknown[], MessageRow>;
  };

  private idCounter = 0;

  constructor(opts: SqliteThreadStoreOptions = {}) {
    if (opts.database) {
      this.db = opts.database;
      this.ownsDatabase = false;
    } else {
      this.db = new Database(opts.filename ?? './ggui-threads.sqlite');
      this.ownsDatabase = true;
    }
    this.now = opts.now ?? Date.now;
    this.idGenerator = opts.idGenerator ?? (() => `thr_${++this.idCounter}`);

    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA_SQL);

    this.stmts = {
      insertThread: this.db.prepare<unknown[]>(INSERT_THREAD_SQL),
      getThread: this.db.prepare<unknown[], ThreadRow>(
        `SELECT * FROM threads WHERE id = ?`,
      ),
      // SQLite stable sort: most-recent-first by (COALESCE(last_message_at,
      // created_at), id). Identical to the in-memory comparator.
      listThreads: this.db.prepare<unknown[], ThreadRow>(
        `SELECT * FROM threads WHERE owner_id = ? ORDER BY COALESCE(last_message_at, created_at) DESC, id ASC`,
      ),
      updateThreadState: this.db.prepare<unknown[]>(
        `UPDATE threads SET pinned = ?, muted = ?, status = ?, unread_count = ?, updated_at = ? WHERE id = ?`,
      ),
      deleteThread: this.db.prepare<unknown[]>(`DELETE FROM threads WHERE id = ?`),
      deleteMessages: this.db.prepare<unknown[]>(
        `DELETE FROM thread_messages WHERE thread_id = ?`,
      ),
      insertMessage: this.db.prepare<unknown[]>(INSERT_MESSAGE_SQL),
      getMessageByKey: this.db.prepare<unknown[], MessageRow>(
        `SELECT * FROM thread_messages WHERE thread_id = ? AND key = ?`,
      ),
      bumpThreadOnAppend: this.db.prepare<unknown[]>(
        `UPDATE threads SET last_seq = ?, last_message_at = ?, updated_at = ?, unread_count = unread_count + ? WHERE id = ?`,
      ),
      selectMessagesFromSeq: this.db.prepare<unknown[], MessageRow>(
        `SELECT * FROM thread_messages WHERE thread_id = ? AND seq >= ? ORDER BY seq ASC`,
      ),
      selectOneFromSeq: this.db.prepare<unknown[], MessageRow>(
        `SELECT * FROM thread_messages WHERE thread_id = ? AND seq >= ? ORDER BY seq ASC LIMIT 1`,
      ),
    };
  }

  /** Release the database handle, if this instance owns it. Idempotent. */
  close(): void {
    this.wakeAllWaiters(null);
    if (this.ownsDatabase) {
      try {
        this.db.close();
      } catch {
        // Already closed / double-close — fine.
      }
    }
  }

  async createThread(
    ownerId: ThreadOwnerId,
    input: CreateThreadInput,
  ): Promise<Thread> {
    const id = this.idGenerator();
    const existing = this.stmts.getThread.get(id) as ThreadRow | undefined;
    if (existing) {
      throw new Error(`SqliteThreadStore.createThread: id collision: ${id}`);
    }
    const iso = new Date(this.now()).toISOString();
    const title = deriveTitle(input.firstMessageHint);
    const metadata =
      input.metadata !== undefined ? JSON.stringify(input.metadata) : null;
    this.stmts.insertThread.run(
      id,
      input.appId,
      ownerId,
      title ?? null,
      0, // last_seq
      null, // last_message_at
      0, // unread_count
      0, // pinned
      0, // muted
      'active',
      iso,
      iso,
      metadata,
    );
    const row = this.stmts.getThread.get(id) as ThreadRow;
    return rowToThread(row);
  }

  async getThread(
    ownerId: ThreadOwnerId,
    threadId: string,
  ): Promise<Thread | null> {
    const row = this.stmts.getThread.get(threadId) as ThreadRow | undefined;
    if (!row || row.owner_id !== ownerId) return null;
    return rowToThread(row);
  }

  async listThreads(
    ownerId: ThreadOwnerId,
    filter: ListThreadsFilter,
  ): Promise<ListThreadsResult> {
    const rows = this.stmts.listThreads.all(ownerId) as ThreadRow[];
    const filtered: Thread[] = [];
    for (const row of rows) {
      if (filter.appId !== undefined && row.app_id !== filter.appId) continue;
      if (filter.status !== undefined && row.status !== filter.status) continue;
      filtered.push(rowToThread(row));
    }
    const offset = parseCursor(filter.cursor);
    const limit = filter.limit ?? DEFAULT_THREADS_LIMIT;
    const page = filtered.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    const out: ListThreadsResult = { threads: page };
    if (nextOffset < filtered.length) {
      out.nextCursor = `offset:${nextOffset}`;
    }
    return out;
  }

  async appendMessage(
    ownerId: ThreadOwnerId,
    input: AppendThreadMessageInput,
  ): Promise<ThreadMessage> {
    // Single `BEGIN IMMEDIATE` so the (read-existing → assign-seq →
    // insert → bump-counters) sequence is atomic. better-sqlite3 runs
    // synchronously on the JS thread, so the transaction is short.
    // unreadCount increments only when author !== 'user', matching
    // the in-memory reference locked by `threadStoreContract`.
    const txn = this.db.transaction(
      (args: {
        ownerId: ThreadOwnerId;
        input: AppendThreadMessageInput;
      }): ThreadMessage => {
        const row = this.stmts.getThread.get(args.input.threadId) as
          | ThreadRow
          | undefined;
        if (!row || row.owner_id !== args.ownerId) {
          throw new ThreadNotFoundError(args.input.threadId);
        }
        // First-write-wins idempotency on (threadId, key).
        const existing = this.stmts.getMessageByKey.get(
          args.input.threadId,
          args.input.key,
        ) as MessageRow | undefined;
        if (existing) return rowToMessage(existing);

        const seq = row.last_seq + 1;
        const iso = new Date(this.now()).toISOString();
        const cardSnapshot =
          args.input.cardSnapshot !== undefined
            ? JSON.stringify(args.input.cardSnapshot)
            : null;
        const aiContext =
          args.input.aiContext !== undefined
            ? JSON.stringify(args.input.aiContext)
            : null;

        this.stmts.insertMessage.run(
          args.input.threadId,
          seq,
          args.input.key,
          iso,
          args.input.authorRole,
          args.input.kind,
          JSON.stringify(args.input.blocks ?? []),
          cardSnapshot,
          args.input.textPreview,
          aiContext,
        );

        const unreadDelta = args.input.authorRole === 'user' ? 0 : 1;
        this.stmts.bumpThreadOnAppend.run(
          seq,
          iso,
          iso,
          unreadDelta,
          args.input.threadId,
        );

        const message: ThreadMessage = {
          threadId: args.input.threadId,
          key: args.input.key,
          seq,
          at: iso,
          authorRole: args.input.authorRole,
          kind: args.input.kind,
          blocks: structuredClone(args.input.blocks ?? []),
          textPreview: args.input.textPreview,
          ...(args.input.cardSnapshot !== undefined
            ? { cardSnapshot: structuredClone(args.input.cardSnapshot) }
            : {}),
          ...(args.input.aiContext !== undefined
            ? { aiContext: structuredClone(args.input.aiContext) }
            : {}),
        };
        return message;
      },
    );

    const message = txn.immediate({ ownerId, input });

    // Fanout AFTER commit — observers must never see a rolled-back row.
    this.wakeWaiters(input.threadId, message);
    return message;
  }

  async listMessages(
    ownerId: ThreadOwnerId,
    threadId: string,
    options: ListMessagesOptions,
  ): Promise<ListMessagesResult> {
    const row = this.stmts.getThread.get(threadId) as ThreadRow | undefined;
    if (!row || row.owner_id !== ownerId) {
      throw new ThreadNotFoundError(threadId);
    }
    const fromSeq = options.fromSeq ?? 1;
    const limit = options.limit ?? DEFAULT_MESSAGES_LIMIT;
    const offset = parseCursor(options.cursor);

    // SQLite handles the ORDER BY + index efficiently; we pull all
    // rows >= fromSeq, then slice in-memory for offset/limit. Matches
    // the in-memory reference's cursor = `offset:N` relative to
    // fromSeq.
    const rows = this.stmts.selectMessagesFromSeq.all(
      threadId,
      fromSeq,
    ) as MessageRow[];
    const page = rows.slice(offset, offset + limit).map(rowToMessage);
    const out: ListMessagesResult = { messages: page };
    if (offset + page.length < rows.length) {
      out.nextCursor = `offset:${offset + page.length}`;
    }
    return out;
  }

  async applyAction(
    ownerId: ThreadOwnerId,
    threadId: string,
    action: ThreadStateAction,
  ): Promise<Thread> {
    if (!isThreadStateAction(action)) {
      throw new InvalidThreadActionError(String(action));
    }
    const row = this.stmts.getThread.get(threadId) as ThreadRow | undefined;
    if (!row || row.owner_id !== ownerId) {
      throw new ThreadNotFoundError(threadId);
    }

    let pinned = row.pinned;
    let muted = row.muted;
    let status = row.status;
    let unreadCount = row.unread_count;

    switch (action) {
      case 'pin':
        pinned = 1;
        break;
      case 'unpin':
        pinned = 0;
        break;
      case 'mute':
        muted = 1;
        break;
      case 'unmute':
        muted = 0;
        break;
      case 'archive':
        if (status === 'pending_delete') {
          throw new ThreadActionInvalidStateError(action, status);
        }
        status = 'archived';
        break;
      case 'unarchive':
        if (status === 'pending_delete') {
          throw new ThreadActionInvalidStateError(action, status);
        }
        status = 'active';
        break;
      case 'mark_read':
        unreadCount = 0;
        break;
      case 'request_delete':
        status = 'pending_delete';
        break;
      case 'restore':
        if (status !== 'pending_delete') {
          throw new ThreadActionInvalidStateError(action, status);
        }
        status = 'active';
        break;
    }

    const changed =
      pinned !== row.pinned ||
      muted !== row.muted ||
      status !== row.status ||
      unreadCount !== row.unread_count;
    const updatedAt = changed
      ? new Date(this.now()).toISOString()
      : row.updated_at;

    if (changed) {
      this.stmts.updateThreadState.run(
        pinned,
        muted,
        status,
        unreadCount,
        updatedAt,
        threadId,
      );
    }
    const refreshed = this.stmts.getThread.get(threadId) as ThreadRow;
    return rowToThread(refreshed);
  }

  observeMessages(
    ownerId: ThreadOwnerId,
    threadId: string,
    options: ObserveMessagesOptions = {},
  ): AsyncIterable<ThreadMessage> {
    const fromSeq = options.fromSeq ?? 1;
    const tail = options.tail ?? true;
    const getThread = (): ThreadRow | undefined =>
      this.stmts.getThread.get(threadId) as ThreadRow | undefined;
    const selectOne = (nextSeq: number): MessageRow | undefined =>
      this.stmts.selectOneFromSeq.get(threadId, nextSeq) as
        | MessageRow
        | undefined;
    const waitForNext = (): Promise<ThreadMessage | null> =>
      this.waitForNext(threadId);

    return {
      [Symbol.asyncIterator](): AsyncIterator<ThreadMessage> {
        let nextSeq = fromSeq;
        let done = false;
        let checkedOwnership = false;
        return {
          async next(): Promise<IteratorResult<ThreadMessage>> {
            if (done) return { value: undefined, done: true };
            const row = getThread();
            if (!row) {
              done = true;
              if (!checkedOwnership) {
                checkedOwnership = true;
                throw new ThreadNotFoundError(threadId);
              }
              return { value: undefined, done: true };
            }
            if (!checkedOwnership) {
              checkedOwnership = true;
              if (row.owner_id !== ownerId) {
                done = true;
                throw new ThreadNotFoundError(threadId);
              }
            }
            // Pull next persisted message with seq >= nextSeq. O(log n)
            // via the (thread_id, seq) primary-key index.
            const backlog = selectOne(nextSeq);
            if (backlog) {
              const message = rowToMessage(backlog);
              nextSeq = message.seq + 1;
              return { value: message, done: false };
            }
            if (!tail) {
              done = true;
              return { value: undefined, done: true };
            }
            const message = await waitForNext();
            if (message === null) {
              done = true;
              return { value: undefined, done: true };
            }
            nextSeq = message.seq + 1;
            return { value: message, done: false };
          },
          async return(): Promise<IteratorResult<ThreadMessage>> {
            done = true;
            return { value: undefined, done: true };
          },
        };
      },
    };
  }

  // ── internals ──────────────────────────────────────────────────────

  private waitForNext(threadId: string): Promise<ThreadMessage | null> {
    return new Promise<ThreadMessage | null>((resolve) => {
      let set = this.waiters.get(threadId);
      if (!set) {
        set = new Set<Waiter>();
        this.waiters.set(threadId, set);
      }
      set.add(resolve);
    });
  }

  private wakeWaiters(threadId: string, message: ThreadMessage | null): void {
    const set = this.waiters.get(threadId);
    if (!set || set.size === 0) return;
    this.waiters.delete(threadId);
    for (const w of set) w(message);
  }

  private wakeAllWaiters(m: ThreadMessage | null): void {
    for (const [, set] of this.waiters) {
      for (const w of set) w(m);
    }
    this.waiters.clear();
  }

  /**
   * Hard-remove a thread + its message history. Not part of the
   * {@link ThreadStore} contract (request_delete sets status to
   * `pending_delete` instead); this helper exists so tests can force-
   * clear state between test cases without fighting the action state
   * machine. Also wakes any parked observers.
   */
  _hardDelete(threadId: string): void {
    this.stmts.deleteMessages.run(threadId);
    this.stmts.deleteThread.run(threadId);
    this.wakeWaiters(threadId, null);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Schema + SQL strings
// ─────────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  title TEXT,
  last_seq INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT,
  unread_count INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  muted INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('active','archived','pending_delete')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_threads_owner_lastmsg
  ON threads(owner_id, last_message_at);
CREATE INDEX IF NOT EXISTS idx_threads_owner_status
  ON threads(owner_id, status);

CREATE TABLE IF NOT EXISTS thread_messages (
  thread_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  key TEXT NOT NULL,
  at TEXT NOT NULL,
  author_role TEXT NOT NULL,
  kind TEXT NOT NULL,
  blocks TEXT NOT NULL,
  card_snapshot TEXT,
  text_preview TEXT NOT NULL,
  ai_context TEXT,
  PRIMARY KEY (thread_id, seq),
  UNIQUE (thread_id, key),
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);
`;

const INSERT_THREAD_SQL = `
INSERT INTO threads (
  id, app_id, owner_id, title, last_seq, last_message_at, unread_count,
  pinned, muted, status, created_at, updated_at, metadata
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const INSERT_MESSAGE_SQL = `
INSERT INTO thread_messages (
  thread_id, seq, key, at, author_role, kind, blocks, card_snapshot,
  text_preview, ai_context
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

// ─────────────────────────────────────────────────────────────────────
// Row ↔ domain conversions
// ─────────────────────────────────────────────────────────────────────

function rowToThread(row: ThreadRow): Thread {
  const out: Thread = {
    id: row.id,
    appId: row.app_id,
    ownerId: row.owner_id,
    lastSeq: row.last_seq,
    unreadCount: row.unread_count,
    pinned: row.pinned === 1,
    muted: row.muted === 1,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.title !== null) out.title = row.title;
  if (row.last_message_at !== null) out.lastMessageAt = row.last_message_at;
  if (row.metadata !== null) {
    const parsed = parseJsonOrNull(row.metadata);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      out.metadata = parsed as Record<string, unknown>;
    }
  }
  return out;
}

function rowToMessage(row: MessageRow): ThreadMessage {
  // Validate array-ness instead of asserting it — the column is
  // operator-mutable; a non-array JSON value degrades to [] the same
  // way unparseable JSON always has.
  const parsedBlocks = parseJsonOrNull(row.blocks);
  const out: ThreadMessage = {
    threadId: row.thread_id,
    key: row.key,
    seq: row.seq,
    at: row.at,
    authorRole: row.author_role,
    kind: row.kind,
    blocks: Array.isArray(parsedBlocks) ? parsedBlocks : [],
    textPreview: row.text_preview,
  };
  if (row.card_snapshot !== null) {
    out.cardSnapshot = parseJsonOrNull(row.card_snapshot);
  }
  if (row.ai_context !== null) {
    out.aiContext = parseJsonOrNull(row.ai_context);
  }
  return out;
}

function parseJsonOrNull(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const match = cursor.match(/^offset:(\d+)$/);
  if (!match) return 0;
  const n = Number(match[1]);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function deriveTitle(hint: string | undefined): string | undefined {
  if (hint === undefined) return undefined;
  const trimmed = hint.trim();
  if (trimmed === '') return undefined;
  return trimmed.length > MAX_TITLE_LENGTH
    ? trimmed.slice(0, MAX_TITLE_LENGTH)
    : trimmed;
}
