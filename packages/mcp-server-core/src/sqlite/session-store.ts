/**
 * SqliteSessionStore — file-backed reference implementation of
 * {@link SessionStore}.
 *
 * Ships as the OSS default for `@ggui-ai/mcp-server` when the operator
 * points `ggui serve` at a durable session file instead of running
 * purely in-memory. Event history + session rows survive process
 * restart, which is the promise `ggui serve` needs to honor.
 *
 * ## Storage layout
 *
 * Two tables + two indexes:
 *
 *   - `sessions(id PK, app_id, user_id, stack JSON, current_stack_index,
 *     adapter_permissions JSON, event_sequence, created_at, last_activity_at,
 *     expires_at, end_user_identity JSON?, connection_id?, closed)`
 *   - `session_events(session_id, seq, type, data JSON, timestamp,
 *     PRIMARY KEY (session_id, seq))`
 *   - `idx_sessions_app_id` + `idx_sessions_user_id` for list filters.
 *
 * Writes go through `BEGIN IMMEDIATE` transactions so concurrent
 * callers can't tear sequence state. SQLite's own WAL + serialized
 * writer model is what keeps `seq` gap-free without an explicit lock.
 *
 * ## Observe semantics — honest subset
 *
 * Historical replay is read directly from `session_events` by
 * `(session_id, seq >= fromSeq)` — this is fully persistent and
 * survives restart, equivalent to {@link InMemorySessionStore}.
 *
 * Live tailing is served by an in-process `EventEmitter`. That's
 * **intentionally narrower** than the interface allows:
 *
 *   - Within a single OSS server process, tail works identically to
 *     the in-memory impl — callers subscribed to `observe` see
 *     post-catchup events as soon as the writing `appendEvent` /
 *     `appendStackItem` returns.
 *   - Across processes (multi-`ggui serve`, external writer, sidecar
 *     tool), writers on process B do **not** fan out to observers on
 *     process A. Those observers will only see the new events on their
 *     next call after catching up — effectively poll-on-reconnect.
 *
 * This is the reference SQLite story. Cross-process fanout needs an
 * external broker (Postgres LISTEN/NOTIFY, Redis Pub/Sub, DDB+AppSync)
 * and belongs to the corresponding adapter package, not here. Single
 * `ggui serve` — the personal-mode default — has full fidelity.
 */
import Database, {
  type Database as SqliteDatabase,
  type Statement as SqliteStatement,
} from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import type { Session, SessionStackEntry } from '@ggui-ai/protocol';
import type {
  AppendEventInput,
  CreateSessionInput,
  ObserveOptions,
  SessionEvent,
  SessionFilter,
  SessionPatch,
  SessionStore,
} from '../session-store.js';

export interface SqliteSessionStoreOptions {
  /**
   * SQLite database file path. Pass `:memory:` for ephemeral tests
   * — shares the `SqliteSessionStore` code path but gets reset on
   * every instance. Default: `./ggui-sessions.sqlite` (relative to
   * the process CWD).
   */
  filename?: string;
  /**
   * Existing `better-sqlite3` instance to use. Useful when the host
   * already manages a shared database file for multiple stores (e.g.
   * colocating sessions + blueprints). Mutually exclusive with
   * `filename` — if both are passed, `database` wins.
   */
  database?: SqliteDatabase;
  /** Clock. Defaults to `Date.now`. Inject for deterministic tests. */
  now?: () => number;
  /** Id generator. Defaults to a counter-based "sess-N" id. */
  idGenerator?: () => string;
  /**
   * Default session TTL in ms. Defaults to "effectively infinite"
   * (`Number.MAX_SAFE_INTEGER` ms ≈ 285k years) — matches the
   * in-memory reference. Chat conversations on hosted clients
   * (Claude.ai, ChatGPT) routinely span weeks of inactivity; reaping
   * a session because the agent paused for 7 days would surface as
   * a `session_not_found` error to a freshly-resumed agent.
   * Monetization-driven expiration is a separate concern.
   *
   * Pass a finite ms value to enable TTL eviction (e.g. `7 * 24 * 60
   * * 60 * 1000` for the prior 7-day default).
   */
  defaultTtlMs?: number;
}

/** Sentinel for "effectively infinite" TTL — `Number.MAX_SAFE_INTEGER` ms. */
const EFFECTIVELY_INFINITE_TTL_MS = Number.MAX_SAFE_INTEGER;

/** Shape of a raw `sessions` row as stored in SQLite. */
interface SessionRow {
  id: string;
  app_id: string;
  user_id: string | null;
  stack: string;
  current_stack_index: number;
  adapter_permissions: string;
  event_sequence: number;
  created_at: number;
  last_activity_at: number;
  expires_at: number;
  end_user_identity: string | null;
  connection_id: string | null;
  closed: number;
  theme_id: string | null;
  host_context: string | null;
  active_stack_item_id: string | null;
  host_name: string | null;
  host_session_id: string | null;
}

/** Shape of a raw `session_events` row as stored in SQLite. */
interface EventRow {
  session_id: string;
  seq: number;
  type: string;
  data: string;
  timestamp: number;
}

/** Per-session tail waiter — parked on `waitForNext()` until an append
 *  or delete wakes them via the shared `EventEmitter`. */
type Waiter = (event: SessionEvent | null) => void;

export class SqliteSessionStore implements SessionStore {
  private readonly db: SqliteDatabase;
  private readonly ownsDatabase: boolean;
  private readonly now: () => number;
  private readonly idGenerator: () => string;
  private readonly defaultTtlMs: number;

  /** Fanout: sessionId → listeners waiting for the next append / close. */
  private readonly waiters = new Map<string, Set<Waiter>>();

  /** Prepared statements — built once at construction for hot paths.
   *  Every statement uses the positional `unknown[]` bind form so calls
   *  can pass the table column values as ordered `run(...)` args. */
  private readonly stmts: {
    insertSession: SqliteStatement<unknown[]>;
    getSession: SqliteStatement<unknown[], SessionRow>;
    listAll: SqliteStatement<unknown[], SessionRow>;
    updateTimestamps: SqliteStatement<unknown[]>;
    updateStack: SqliteStatement<unknown[]>;
    updateHostContext: SqliteStatement<unknown[]>;
    updateActiveStackItemId: SqliteStatement<unknown[]>;
    deleteSession: SqliteStatement<unknown[]>;
    deleteSessionEvents: SqliteStatement<unknown[]>;
    deleteSessionPageIndex: SqliteStatement<unknown[]>;
    insertEvent: SqliteStatement<unknown[]>;
    bumpSequenceAndClose: SqliteStatement<unknown[]>;
    bumpSequence: SqliteStatement<unknown[]>;
    selectEventsFromSeq: SqliteStatement<unknown[], EventRow>;
    selectEventsSinceLimited: SqliteStatement<unknown[], EventRow>;
    upsertPageIndex: SqliteStatement<unknown[]>;
    deletePageIndexEntry: SqliteStatement<unknown[]>;
    selectPageIndex: SqliteStatement<
      unknown[],
      { session_id: string; app_id: string }
    >;
  };

  private idCounter = 0;

  constructor(opts: SqliteSessionStoreOptions = {}) {
    if (opts.database) {
      this.db = opts.database;
      this.ownsDatabase = false;
    } else {
      this.db = new Database(opts.filename ?? './ggui-sessions.sqlite');
      this.ownsDatabase = true;
    }
    this.now = opts.now ?? Date.now;
    this.idGenerator = opts.idGenerator ?? (() => `sess-${++this.idCounter}`);
    this.defaultTtlMs = opts.defaultTtlMs ?? EFFECTIVELY_INFINITE_TTL_MS;

    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.db.exec(SCHEMA_SQL);

    // Lazy schema migration. Pragma reads the live column set;
    // ALTER TABLE fires only for absent columns. Fresh DBs got the
    // columns from CREATE TABLE so the pragma check correctly skips
    // them. No version table needed; the additive pattern generalises
    // as new columns land.
    const sessionsCols = this.db.pragma('table_info(sessions)') as Array<{
      name: string;
    }>;
    const hasCol = (name: string): boolean =>
      sessionsCols.some((c) => c.name === name);
    if (!hasCol('theme_id')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN theme_id TEXT`);
    }
    if (!hasCol('host_context')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN host_context TEXT`);
    }
    if (!hasCol('active_stack_item_id')) {
      this.db.exec(
        `ALTER TABLE sessions ADD COLUMN active_stack_item_id TEXT`,
      );
    }
    if (!hasCol('host_name')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN host_name TEXT`);
    }
    if (!hasCol('host_session_id')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN host_session_id TEXT`);
    }
    // Composite index for host-scoped lookups. `CREATE INDEX IF NOT
    // EXISTS` is idempotent — same statement as in SCHEMA_SQL above
    // (which doesn't run on already-migrated databases that already had
    // the table). Repeating here covers the upgrade path on DBs that
    // existed before the index was introduced.
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_sessions_host ON sessions(host_name, host_session_id)`,
    );

    this.stmts = {
      insertSession: this.db.prepare<unknown[]>(INSERT_SESSION_SQL),
      getSession: this.db.prepare<unknown[], SessionRow>(
        `SELECT * FROM sessions WHERE id = ?`,
      ),
      listAll: this.db.prepare<unknown[], SessionRow>(
        `SELECT * FROM sessions ORDER BY created_at ASC, id ASC`,
      ),
      updateTimestamps: this.db.prepare<unknown[]>(
        `UPDATE sessions SET last_activity_at = COALESCE(?, last_activity_at), expires_at = COALESCE(?, expires_at) WHERE id = ?`,
      ),
      updateStack: this.db.prepare<unknown[]>(
        `UPDATE sessions SET stack = ?, current_stack_index = ?, last_activity_at = ? WHERE id = ?`,
      ),
      updateHostContext: this.db.prepare<unknown[]>(
        `UPDATE sessions SET host_context = ? WHERE id = ?`,
      ),
      updateActiveStackItemId: this.db.prepare<unknown[]>(
        `UPDATE sessions SET active_stack_item_id = ? WHERE id = ?`,
      ),
      deleteSession: this.db.prepare<unknown[]>(`DELETE FROM sessions WHERE id = ?`),
      deleteSessionEvents: this.db.prepare<unknown[]>(
        `DELETE FROM session_events WHERE session_id = ?`,
      ),
      deleteSessionPageIndex: this.db.prepare<unknown[]>(
        `DELETE FROM session_stack_item_index WHERE session_id = ?`,
      ),
      insertEvent: this.db.prepare<unknown[]>(
        `INSERT INTO session_events (session_id, seq, type, data, timestamp) VALUES (?, ?, ?, ?, ?)`,
      ),
      bumpSequenceAndClose: this.db.prepare<unknown[]>(
        `UPDATE sessions SET event_sequence = ?, last_activity_at = ?, closed = 1 WHERE id = ?`,
      ),
      bumpSequence: this.db.prepare<unknown[]>(
        `UPDATE sessions SET event_sequence = ?, last_activity_at = ? WHERE id = ?`,
      ),
      selectEventsFromSeq: this.db.prepare<unknown[], EventRow>(
        `SELECT * FROM session_events WHERE session_id = ? AND seq >= ? ORDER BY seq ASC`,
      ),
      // R7 — `listEventsSince(sessionId, sinceSeq, limit)` backing.
      // STRICT inequality (`seq > ?`) since callers pass their cursor
      // and want only events newer than what they've already seen.
      // We fetch `limit + 1` to compute `hasMore` in a single query.
      selectEventsSinceLimited: this.db.prepare<unknown[], EventRow>(
        `SELECT * FROM session_events WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
      ),
      upsertPageIndex: this.db.prepare<unknown[]>(
        `INSERT INTO session_stack_item_index (stack_item_id, session_id, app_id) VALUES (?, ?, ?)
         ON CONFLICT(stack_item_id) DO UPDATE SET session_id = excluded.session_id, app_id = excluded.app_id`,
      ),
      deletePageIndexEntry: this.db.prepare<unknown[]>(
        `DELETE FROM session_stack_item_index WHERE stack_item_id = ?`,
      ),
      selectPageIndex: this.db.prepare<
        unknown[],
        { session_id: string; app_id: string }
      >(
        `SELECT session_id, app_id FROM session_stack_item_index WHERE stack_item_id = ?`,
      ),
    };
  }

  /** Release the underlying database handle, if this instance owns it.
   *  Safe to call multiple times; a no-op when a caller-supplied
   *  `database` was passed at construction. */
  close(): void {
    this.wakeAllWaiters(null);
    if (this.ownsDatabase) this.db.close();
  }

  async create(input: CreateSessionInput): Promise<Session> {
    const id = input.id ?? this.idGenerator();
    const existing = this.stmts.getSession.get(id) as SessionRow | undefined;
    if (existing) {
      throw new Error(
        `SqliteSessionStore.create: session already exists: ${id}`,
      );
    }
    const t = this.now();
    const session: Session = {
      id,
      appId: input.appId,
      userId: input.userId,
      ...(input.endUserIdentity
        ? { endUserIdentity: input.endUserIdentity }
        : {}),
      ...(input.themeId !== undefined ? { themeId: input.themeId } : {}),
      ...(input.hostSession !== undefined
        ? { hostSession: input.hostSession }
        : {}),
      stack: [],
      currentStackIndex: -1,
      adapterPermissions: {},
      eventSequence: 0,
      createdAt: t,
      lastActivityAt: t,
      expiresAt: t + this.defaultTtlMs,
    };
    this.stmts.insertSession.run(
      session.id,
      session.appId,
      session.userId ?? null,
      JSON.stringify(session.stack),
      session.currentStackIndex,
      JSON.stringify(session.adapterPermissions),
      session.eventSequence,
      session.createdAt,
      session.lastActivityAt,
      session.expiresAt,
      session.endUserIdentity ? JSON.stringify(session.endUserIdentity) : null,
      null, // connection_id
      0, // closed
      session.themeId ?? null,
      session.hostSession?.hostName ?? null,
      session.hostSession?.hostSessionId ?? null,
    );
    return cloneSession(session);
  }

  async get(id: string): Promise<Session | null> {
    const row = this.stmts.getSession.get(id) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  async list(filter: SessionFilter): Promise<Session[]> {
    // SQLite stable sort: (createdAt ASC, id ASC), matching the in-memory
    // contract. Apply filters in-memory because `status='expired'`
    // depends on wall-clock vs `expires_at` and `status='completed'`
    // depends on the `closed` flag — both fit trivially here without
    // dynamic SQL composition.
    const rows = this.stmts.listAll.all() as SessionRow[];
    const now = this.now();
    const filtered: Session[] = [];
    for (const row of rows) {
      if (filter.appId !== undefined && row.app_id !== filter.appId) continue;
      if (filter.userId !== undefined && (row.user_id ?? undefined) !== filter.userId) continue;
      if (filter.createdAfter !== undefined && row.created_at <= filter.createdAfter) continue;
      if (filter.createdBefore !== undefined && row.created_at >= filter.createdBefore) continue;
      if (filter.status !== undefined) {
        if (computeRowStatus(row, now) !== filter.status) continue;
      }
      if (filter.hostName !== undefined && row.host_name !== filter.hostName) continue;
      if (filter.hostSessionId !== undefined && row.host_session_id !== filter.hostSessionId) continue;
      filtered.push(rowToSession(row));
    }
    const offset = parseCursor(filter.cursor);
    const limit = filter.limit ?? filtered.length;
    return filtered.slice(offset, offset + limit);
  }

  async update(id: string, patch: SessionPatch): Promise<Session> {
    const row = this.stmts.getSession.get(id) as SessionRow | undefined;
    if (!row) {
      throw new Error(`SqliteSessionStore.update: session not found: ${id}`);
    }
    // metadata is documented as ignorable by stores that don't layer
    // it on — we follow the in-memory reference and drop it silently.
    this.stmts.updateTimestamps.run(
      patch.lastActivityAt ?? null,
      patch.expiresAt ?? null,
      id,
    );
    // Each column is updated independently so partial patches don't
    // disturb fields the caller didn't pass. `null` on
    // `activeStackItemId` clears the column (matches the in-memory
    // reference's clear semantics).
    if (patch.hostContext !== undefined) {
      this.stmts.updateHostContext.run(JSON.stringify(patch.hostContext), id);
    }
    if (patch.activeStackItemId !== undefined) {
      this.stmts.updateActiveStackItemId.run(patch.activeStackItemId, id);
    }
    const updated = this.stmts.getSession.get(id) as SessionRow;
    return rowToSession(updated);
  }

  async delete(id: string): Promise<void> {
    // session_events cascades via FK ON DELETE CASCADE (see SCHEMA_SQL).
    // We still clear explicitly to be robust to SQLite builds where
    // `foreign_keys` was disabled. Same applies to session_stack_item_index.
    this.stmts.deleteSessionEvents.run(id);
    this.stmts.deleteSessionPageIndex.run(id);
    this.stmts.deleteSession.run(id);
    this.wakeWaiters(id, null);
  }

  async getSessionByStackItemId(
    stackItemId: string,
  ): Promise<{ readonly sessionId: string; readonly appId: string } | null> {
    const row = this.stmts.selectPageIndex.get(stackItemId) as
      | { session_id: string; app_id: string }
      | undefined;
    if (!row) return null;
    // Defensive read: confirm the owning session row still exists.
    // Cascading delete should have cleaned the index, but a torn
    // write would leave a stale entry — return null over a
    // dereference of a vanished session.
    const session = this.stmts.getSession.get(row.session_id) as
      | SessionRow
      | undefined;
    if (!session) return null;
    return { sessionId: row.session_id, appId: row.app_id };
  }

  async appendStackItem(
    sessionId: string,
    entry: SessionStackEntry,
  ): Promise<Session> {
    const row = this.stmts.getSession.get(sessionId) as SessionRow | undefined;
    if (!row) {
      throw new Error(
        `SqliteSessionStore.appendStackItem: session not found: ${sessionId}`,
      );
    }
    if (row.closed) {
      throw new Error(
        `SqliteSessionStore.appendStackItem: session is closed: ${sessionId}`,
      );
    }
    const stack = parseStack(row.stack);
    // Upsert by id — see SessionStore.appendStackItem JSDoc for the why.
    const existingIdx = stack.findIndex((existing) => existing.id === entry.id);
    let activeIndex: number;
    if (existingIdx >= 0) {
      stack[existingIdx] = entry;
      activeIndex = existingIdx;
    } else {
      stack.push(entry);
      activeIndex = stack.length - 1;
    }
    const t = this.now();
    this.stmts.updateStack.run(
      JSON.stringify(stack),
      activeIndex,
      t,
      sessionId,
    );
    // Maintain stackItemId secondary index. Idempotent re-upsert when the
    // same stackItemId is replaced in place; first-time-write inserts.
    this.stmts.upsertPageIndex.run(entry.id, sessionId, row.app_id);
    const updated = this.stmts.getSession.get(sessionId) as SessionRow;
    return rowToSession(updated);
  }

  async popStackItem(
    sessionId: string,
  ): Promise<{ readonly poppedId: string | null; readonly stackSize: number }> {
    const row = this.stmts.getSession.get(sessionId) as SessionRow | undefined;
    if (!row) {
      throw new Error(
        `SqliteSessionStore.popStackItem: session not found: ${sessionId}`,
      );
    }
    if (row.closed) {
      throw new Error(
        `SqliteSessionStore.popStackItem: session is closed: ${sessionId}`,
      );
    }
    const stack = parseStack(row.stack);
    const t = this.now();
    if (stack.length === 0) {
      // Idempotent at bottom — bump activity timestamp; no stack write.
      this.stmts.updateTimestamps.run(t, t, sessionId);
      return { poppedId: null, stackSize: 0 };
    }
    const popped = stack.pop()!;
    const newIndex = Math.max(0, stack.length - 1);
    this.stmts.updateStack.run(JSON.stringify(stack), newIndex, t, sessionId);
    // Drop the popped id from the secondary index — getSessionByStackItemId
    // returns null for it post-pop.
    this.stmts.deletePageIndexEntry.run(popped.id);
    return { poppedId: popped.id, stackSize: stack.length };
  }

  async appendEvent(input: AppendEventInput): Promise<number> {
    // Serialize the read-then-write under `BEGIN IMMEDIATE` so
    // concurrent appends can't both read `eventSequence = N` and
    // race on `N+1`. better-sqlite3 executes this synchronously on
    // the single thread, so the transaction is short.
    const txn = this.db.transaction((): { seq: number; event: SessionEvent } => {
      const row = this.stmts.getSession.get(input.sessionId) as
        | SessionRow
        | undefined;
      if (!row) {
        throw new Error(
          `SqliteSessionStore.appendEvent: session not found: ${input.sessionId}`,
        );
      }
      if (row.closed) {
        throw new Error(
          `SqliteSessionStore.appendEvent: session is closed: ${input.sessionId}`,
        );
      }
      const seq = row.event_sequence + 1;
      const timestamp = this.now();
      this.stmts.insertEvent.run(
        input.sessionId,
        seq,
        input.type,
        JSON.stringify(input.data ?? null),
        timestamp,
      );
      if (input.type === 'session.closed') {
        this.stmts.bumpSequenceAndClose.run(seq, timestamp, input.sessionId);
      } else {
        this.stmts.bumpSequence.run(seq, timestamp, input.sessionId);
      }
      const event: SessionEvent = {
        seq,
        type: input.type,
        timestamp,
        data: input.data,
      };
      return { seq, event };
    });

    const { seq, event } = txn.immediate();
    // Fanout to in-process observers AFTER the transaction commits —
    // observers should never see an event that might be rolled back.
    this.wakeWaiters(input.sessionId, event);
    return seq;
  }

  async listEventsSince(
    sessionId: string,
    sinceSeq: number,
    limit: number,
  ): Promise<{
    readonly events: readonly SessionEvent[];
    readonly lastSequence: number;
    readonly hasMore: boolean;
    readonly horizonSeq: number;
  } | null> {
    const row = this.stmts.getSession.get(sessionId) as SessionRow | undefined;
    if (!row) return null;
    const lastSequence = row.event_sequence;
    // Sqlite store keeps every event for the session's lifetime — no
    // horizon eviction. `horizonSeq=0` ⇒ full history is replayable
    // until the session is deleted.
    const horizonSeq = 0;
    if (sinceSeq < horizonSeq) {
      return { events: [], lastSequence, hasMore: false, horizonSeq };
    }
    // Fetch limit + 1 to detect hasMore without a second query.
    const fetched = this.stmts.selectEventsSinceLimited.all(
      sessionId,
      sinceSeq,
      limit + 1,
    ) as EventRow[];
    let hasMore = false;
    let pageRows = fetched;
    if (fetched.length > limit) {
      hasMore = true;
      pageRows = fetched.slice(0, limit);
    }
    const events = pageRows.map(rowToEvent);
    return { events, lastSequence, hasMore, horizonSeq };
  }

  observe(id: string, opts: ObserveOptions = {}): AsyncIterable<SessionEvent> {
    const fromSeq = opts.fromSeq ?? 1;
    const tail = opts.tail ?? true;
    const selectStmt = this.stmts.selectEventsFromSeq;
    const getStmt = this.stmts.getSession;
    const waitForNext = (sessionId: string): Promise<SessionEvent | null> =>
      this.waitForNext(sessionId);

    return {
      [Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
        let nextSeq = fromSeq;
        let done = false;
        return {
          async next(): Promise<IteratorResult<SessionEvent>> {
            if (done) return { value: undefined, done: true };
            const row = getStmt.get(id) as SessionRow | undefined;
            if (!row) {
              done = true;
              return { value: undefined, done: true };
            }
            // Pull the next backlog event — O(log n + k) via the
            // (session_id, seq) primary key index, k = returned rows.
            const backlog = selectStmt.get(id, nextSeq) as EventRow | undefined;
            if (backlog) {
              const event = rowToEvent(backlog);
              nextSeq = event.seq + 1;
              if (event.type === 'session.closed') done = true;
              return { value: event, done: false };
            }
            if (!tail || row.closed) {
              done = true;
              return { value: undefined, done: true };
            }
            const event = await waitForNext(id);
            if (event === null) {
              done = true;
              return { value: undefined, done: true };
            }
            // The waiter woke us on the next appended event. Its seq
            // might be larger than `nextSeq` if the caller started
            // mid-stream — that's fine, we jump to it.
            nextSeq = event.seq + 1;
            if (event.type === 'session.closed') done = true;
            return { value: event, done: false };
          },
          async return(): Promise<IteratorResult<SessionEvent>> {
            done = true;
            return { value: undefined, done: true };
          },
        };
      },
    };
  }

  // ── internals ──────────────────────────────────────────────────────

  private waitForNext(sessionId: string): Promise<SessionEvent | null> {
    return new Promise<SessionEvent | null>((resolve) => {
      let waiters = this.waiters.get(sessionId);
      if (!waiters) {
        waiters = new Set<Waiter>();
        this.waiters.set(sessionId, waiters);
      }
      waiters.add(resolve);
    });
  }

  private wakeWaiters(sessionId: string, event: SessionEvent | null): void {
    const waiters = this.waiters.get(sessionId);
    if (!waiters || waiters.size === 0) return;
    this.waiters.delete(sessionId);
    for (const w of waiters) w(event);
  }

  private wakeAllWaiters(event: SessionEvent | null): void {
    for (const [, waiters] of this.waiters) {
      for (const w of waiters) w(event);
    }
    this.waiters.clear();
  }
}

// `EventEmitter` import kept reachable so its type surface stays valid
// under `noUnusedLocals`. We don't use it directly — the per-session
// waiter set above is purpose-built and cheaper.
void EventEmitter;

// ─────────────────────────────────────────────────────────────────────
// Schema + SQL strings
// ─────────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  user_id TEXT,
  stack TEXT NOT NULL,
  current_stack_index INTEGER NOT NULL,
  adapter_permissions TEXT NOT NULL,
  event_sequence INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  end_user_identity TEXT,
  connection_id TEXT,
  closed INTEGER NOT NULL DEFAULT 0,
  theme_id TEXT,
  host_context TEXT,
  active_stack_item_id TEXT,
  host_name TEXT,
  host_session_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_app_id ON sessions(app_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
-- Composite index for ggui_list_sessions(hostName, hostSessionId).
-- Rows without a host slice (legacy / opt-out hosts) carry NULL on both
-- columns and so never appear in host-scoped queries — which is the
-- correct semantics (those sessions are non-rehydratable by design).
CREATE INDEX IF NOT EXISTS idx_sessions_host
  ON sessions(host_name, host_session_id);

CREATE TABLE IF NOT EXISTS session_events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Secondary index: stackItemId -> owning session metadata. Maintained by
-- appendStackItem (upsert) + delete (cascade on session removal).
-- Powers ggui_update's stackItemId-only input shape (no sessionId on the
-- wire -- server resolves the owning session in O(1)).
CREATE TABLE IF NOT EXISTS session_stack_item_index (
  stack_item_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_stack_item_index_session ON session_stack_item_index(session_id);
CREATE INDEX IF NOT EXISTS idx_stack_item_index_app ON session_stack_item_index(app_id);
`;

const INSERT_SESSION_SQL = `
INSERT INTO sessions (
  id, app_id, user_id, stack, current_stack_index, adapter_permissions,
  event_sequence, created_at, last_activity_at, expires_at,
  end_user_identity, connection_id, closed, theme_id,
  host_name, host_session_id
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

// ─────────────────────────────────────────────────────────────────────
// Row ↔ domain conversions
// ─────────────────────────────────────────────────────────────────────

function rowToSession(row: SessionRow): Session {
  // Lifecycle status derived from the `closed` column + `expires_at`.
  // Cheaper than reading the event log; equivalent to the InMemory
  // store's computeStatus helper. Pure projection — no I/O.
  const now = Date.now();
  const status: 'active' | 'completed' | 'expired' = row.closed
    ? 'completed'
    : row.expires_at <= now
      ? 'expired'
      : 'active';
  const session: Session = {
    id: row.id,
    appId: row.app_id,
    userId: row.user_id ?? undefined,
    stack: parseStack(row.stack),
    currentStackIndex: row.current_stack_index,
    adapterPermissions: parseJson<Session['adapterPermissions']>(
      row.adapter_permissions,
      {},
    ),
    eventSequence: row.event_sequence,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    expiresAt: row.expires_at,
    status,
  };
  if (row.connection_id) session.connectionId = row.connection_id;
  if (row.end_user_identity) {
    const identity = parseJson<NonNullable<Session['endUserIdentity']> | null>(
      row.end_user_identity,
      null,
    );
    if (identity) session.endUserIdentity = identity;
  }
  if (row.theme_id) session.themeId = row.theme_id;
  if (row.host_context) {
    const ctx = parseJson<NonNullable<Session['hostContext']> | null>(
      row.host_context,
      null,
    );
    if (ctx) session.hostContext = ctx;
  }
  if (row.active_stack_item_id) {
    session.activeStackItemId = row.active_stack_item_id;
  }
  // Host-session slice — both columns required together. A row with
  // only one populated indicates writer-side corruption (or a partial
  // hand-migration); treat as absent so the consumer's "is rehydratable"
  // check stays a single null check.
  if (row.host_name && row.host_session_id) {
    session.hostSession = {
      hostName: row.host_name,
      hostSessionId: row.host_session_id,
    };
  }
  return session;
}

function rowToEvent(row: EventRow): SessionEvent {
  return {
    seq: row.seq,
    type: row.type as SessionEvent['type'],
    timestamp: row.timestamp,
    data: parseJson<unknown>(row.data, null),
  };
}

function parseStack(json: string): SessionStackEntry[] {
  const parsed = parseJson<SessionStackEntry[]>(json, []);
  return Array.isArray(parsed) ? parsed : [];
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function cloneSession(s: Session): Session {
  return {
    ...s,
    stack: s.stack.slice(),
    adapterPermissions: { ...s.adapterPermissions },
    ...(s.endUserIdentity ? { endUserIdentity: { ...s.endUserIdentity } } : {}),
  };
}

function computeRowStatus(
  row: SessionRow,
  now: number,
): 'active' | 'completed' | 'expired' {
  if (row.closed) return 'completed';
  if (row.expires_at <= now) return 'expired';
  return 'active';
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const match = cursor.match(/^offset:(\d+)$/);
  return match ? Number(match[1]) : 0;
}
