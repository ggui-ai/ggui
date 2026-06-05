/**
 * SqliteGguiSessionStore — file-backed reference implementation of
 * {@link GguiSessionStore}.
 *
 * Ships as the OSS default for `@ggui-ai/mcp-server` when the operator
 * points `ggui serve` at a durable database file instead of running
 * purely in-memory. Event history + render rows survive process
 * restart, which is the promise `ggui serve` needs to honor.
 *
 * ## Storage layout
 *
 * Post-Phase-B (flatten-render-identity): one table per render — no
 * vessel-and-children split, no secondary stack-item index. A render
 * IS the addressable row.
 *
 *   - `renders(id PK, app_id, user_id, payload JSON, event_sequence,
 *     created_at, last_activity_at, expires_at, end_user_identity JSON?,
 *     theme_id, host_context JSON?, host_name, host_session_id)`
 *   - `render_events(render_id, seq, type, data JSON, timestamp,
 *     PRIMARY KEY (render_id, seq))`
 *   - `idx_renders_app_id` + `idx_renders_user_id` + `idx_renders_host` for list filters.
 *
 * The `closed` column + `'render.closed'` event type are absent by
 * design — renders decay implicitly via `expires_at` (TTL), so there
 * is no second termination signal to persist.
 *
 * Writes go through `BEGIN IMMEDIATE` transactions so concurrent
 * callers can't tear sequence state. SQLite's own WAL + serialized
 * writer model is what keeps `seq` gap-free without an explicit lock.
 *
 * ## Observe semantics — honest subset
 *
 * Historical replay is read directly from `render_events` by
 * `(render_id, seq >= fromSeq)` — this is fully persistent and
 * survives restart, equivalent to {@link InMemoryGguiSessionStore}.
 *
 * Live tailing is served by an in-process `EventEmitter`. That's
 * **intentionally narrower** than the interface allows:
 *
 *   - Within a single OSS server process, tail works identically to
 *     the in-memory impl — callers subscribed to `observe` see
 *     post-catchup events as soon as the writing `appendEvent` /
 *     `commit` returns.
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
import type { GguiSession } from '@ggui-ai/protocol';
import type {
  AppendEventInput,
  CommitGguiSessionInput,
  CreateGguiSessionInput,
  ObserveOptions,
  GguiSessionEvent,
  GguiSessionFilter,
  GguiSessionPatch,
  GguiSessionStore,
  StoredGguiSession,
} from '../render-store.js';

export interface SqliteGguiSessionStoreOptions {
  /**
   * SQLite database file path. Pass `:memory:` for ephemeral tests
   * — shares the `SqliteGguiSessionStore` code path but gets reset on
   * every instance. Default: `./ggui-renders.sqlite` (relative to
   * the process CWD).
   */
  filename?: string;
  /**
   * Existing `better-sqlite3` instance to use. Useful when the host
   * already manages a shared database file for multiple stores (e.g.
   * colocating renders + blueprints). Mutually exclusive with
   * `filename` — if both are passed, `database` wins.
   */
  database?: SqliteDatabase;
  /** Clock. Defaults to `Date.now`. Inject for deterministic tests. */
  now?: () => number;
  /** Id generator. Defaults to a counter-based "render-N" id. */
  idGenerator?: () => string;
  /**
   * Default render TTL in ms. Defaults to "effectively infinite"
   * (`Number.MAX_SAFE_INTEGER` ms ≈ 285k years) — matches the
   * in-memory reference.
   */
  defaultTtlMs?: number;
}

/** Sentinel for "effectively infinite" TTL — `Number.MAX_SAFE_INTEGER` ms. */
const EFFECTIVELY_INFINITE_TTL_MS = Number.MAX_SAFE_INTEGER;

/** Shape of a raw `renders` row as stored in SQLite. */
interface GguiSessionRow {
  id: string;
  app_id: string;
  user_id: string | null;
  /** JSON-serialised wire-shape GguiSession payload. */
  payload: string;
  event_sequence: number;
  created_at: number;
  last_activity_at: number;
  expires_at: number;
  end_user_identity: string | null;
  theme_id: string | null;
  host_context: string | null;
  host_name: string | null;
  host_session_id: string | null;
}

/** Shape of a raw `render_events` row as stored in SQLite. */
interface EventRow {
  render_id: string;
  seq: number;
  type: string;
  data: string;
  /** ISO 8601 UTC timestamp stamped at append time. */
  timestamp: string;
}

/** Per-render tail waiter — parked on `waitForNext()` until an append
 *  or delete wakes them via the shared `EventEmitter`. */
type Waiter = (event: GguiSessionEvent | null) => void;

export class SqliteGguiSessionStore implements GguiSessionStore {
  private readonly db: SqliteDatabase;
  private readonly ownsDatabase: boolean;
  private readonly now: () => number;
  private readonly idGenerator: () => string;
  private readonly defaultTtlMs: number;

  /** Fanout: renderId → listeners waiting for the next append / close. */
  private readonly waiters = new Map<string, Set<Waiter>>();

  /** Prepared statements — built once at construction for hot paths. */
  private readonly stmts: {
    insertRender: SqliteStatement<unknown[]>;
    upsertRenderPayload: SqliteStatement<unknown[]>;
    getGguiSession: SqliteStatement<unknown[], GguiSessionRow>;
    listAll: SqliteStatement<unknown[], GguiSessionRow>;
    updateTimestamps: SqliteStatement<unknown[]>;
    updateHostContext: SqliteStatement<unknown[]>;
    deleteRender: SqliteStatement<unknown[]>;
    deleteRenderEvents: SqliteStatement<unknown[]>;
    insertEvent: SqliteStatement<unknown[]>;
    bumpSequence: SqliteStatement<unknown[]>;
    selectEventsFromSeq: SqliteStatement<unknown[], EventRow>;
    selectEventsSinceLimited: SqliteStatement<unknown[], EventRow>;
  };

  private idCounter = 0;

  constructor(opts: SqliteGguiSessionStoreOptions = {}) {
    if (opts.database) {
      this.db = opts.database;
      this.ownsDatabase = false;
    } else {
      this.db = new Database(opts.filename ?? './ggui-renders.sqlite');
      this.ownsDatabase = true;
    }
    this.now = opts.now ?? Date.now;
    this.idGenerator = opts.idGenerator ?? (() => `render-${++this.idCounter}`);
    this.defaultTtlMs = opts.defaultTtlMs ?? EFFECTIVELY_INFINITE_TTL_MS;

    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.db.exec(SCHEMA_SQL);

    this.stmts = {
      insertRender: this.db.prepare<unknown[]>(INSERT_RENDER_SQL),
      upsertRenderPayload: this.db.prepare<unknown[]>(UPSERT_RENDER_PAYLOAD_SQL),
      getGguiSession: this.db.prepare<unknown[], GguiSessionRow>(
        `SELECT * FROM renders WHERE id = ?`,
      ),
      listAll: this.db.prepare<unknown[], GguiSessionRow>(
        `SELECT * FROM renders ORDER BY created_at ASC, id ASC`,
      ),
      updateTimestamps: this.db.prepare<unknown[]>(
        `UPDATE renders SET last_activity_at = COALESCE(?, last_activity_at), expires_at = COALESCE(?, expires_at) WHERE id = ?`,
      ),
      updateHostContext: this.db.prepare<unknown[]>(
        `UPDATE renders SET host_context = ? WHERE id = ?`,
      ),
      deleteRender: this.db.prepare<unknown[]>(`DELETE FROM renders WHERE id = ?`),
      deleteRenderEvents: this.db.prepare<unknown[]>(
        `DELETE FROM render_events WHERE render_id = ?`,
      ),
      insertEvent: this.db.prepare<unknown[]>(
        `INSERT INTO render_events (render_id, seq, type, data, timestamp) VALUES (?, ?, ?, ?, ?)`,
      ),
      bumpSequence: this.db.prepare<unknown[]>(
        `UPDATE renders SET event_sequence = ?, last_activity_at = ? WHERE id = ?`,
      ),
      selectEventsFromSeq: this.db.prepare<unknown[], EventRow>(
        `SELECT * FROM render_events WHERE render_id = ? AND seq >= ? ORDER BY seq ASC`,
      ),
      // R7 — `listEventsSince(renderId, sinceSeq, limit)` backing.
      // STRICT inequality (`seq > ?`) since callers pass their cursor
      // and want only events newer than what they've already seen.
      // We fetch `limit + 1` to compute `hasMore` in a single query.
      selectEventsSinceLimited: this.db.prepare<unknown[], EventRow>(
        `SELECT * FROM render_events WHERE render_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
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

  async create(input: CreateGguiSessionInput): Promise<StoredGguiSession> {
    const id = input.id ?? this.idGenerator();
    const existing = this.stmts.getGguiSession.get(id) as GguiSessionRow | undefined;
    if (existing) {
      throw new Error(
        `SqliteGguiSessionStore.create: render already exists: ${id}`,
      );
    }
    const t = this.now();
    // Placeholder ComponentGguiSession — visible-bits surface fills on `commit`.
    const placeholder: GguiSession = {
      type: 'component',
      id,
      appId: input.appId,
      componentCode: '',
      eventSequence: 0,
      createdAt: t,
      lastActivityAt: t,
      expiresAt: t + this.defaultTtlMs,
    };
    const stored: StoredGguiSession = {
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
      eventSequence: 0,
      createdAt: t,
      lastActivityAt: t,
      expiresAt: t + this.defaultTtlMs,
      render: placeholder,
    };
    this.stmts.insertRender.run(
      stored.id,
      stored.appId,
      stored.userId ?? null,
      JSON.stringify(placeholder),
      stored.eventSequence,
      stored.createdAt,
      stored.lastActivityAt,
      stored.expiresAt,
      stored.endUserIdentity ? JSON.stringify(stored.endUserIdentity) : null,
      stored.themeId ?? null,
      stored.hostSession?.hostName ?? null,
      stored.hostSession?.hostSessionId ?? null,
    );
    return stored;
  }

  async get(id: string): Promise<StoredGguiSession | null> {
    const row = this.stmts.getGguiSession.get(id) as GguiSessionRow | undefined;
    return row ? rowToStored(row) : null;
  }

  async list(filter: GguiSessionFilter): Promise<StoredGguiSession[]> {
    const rows = this.stmts.listAll.all() as GguiSessionRow[];
    const now = this.now();
    const filtered: StoredGguiSession[] = [];
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
      filtered.push(rowToStored(row));
    }
    const offset = parseCursor(filter.cursor);
    const limit = filter.limit ?? filtered.length;
    return filtered.slice(offset, offset + limit);
  }

  async update(id: string, patch: GguiSessionPatch): Promise<StoredGguiSession> {
    const row = this.stmts.getGguiSession.get(id) as GguiSessionRow | undefined;
    if (!row) {
      throw new Error(`SqliteGguiSessionStore.update: render not found: ${id}`);
    }
    this.stmts.updateTimestamps.run(
      patch.lastActivityAt ?? null,
      patch.expiresAt ?? null,
      id,
    );
    if (patch.hostContext !== undefined) {
      this.stmts.updateHostContext.run(JSON.stringify(patch.hostContext), id);
    }
    const updated = this.stmts.getGguiSession.get(id) as GguiSessionRow;
    return rowToStored(updated);
  }

  async delete(id: string): Promise<void> {
    // render_events cascades via FK ON DELETE CASCADE (see SCHEMA_SQL).
    // We still clear explicitly to be robust to SQLite builds where
    // `foreign_keys` was disabled.
    this.stmts.deleteRenderEvents.run(id);
    this.stmts.deleteRender.run(id);
    this.wakeWaiters(id, null);
  }

  async commit(input: CommitGguiSessionInput): Promise<StoredGguiSession> {
    const incoming = input.render;
    const existing = this.stmts.getGguiSession.get(incoming.id) as
      | GguiSessionRow
      | undefined;
    const t = this.now();
    if (existing) {
      // Replace visible-bits surface; preserve lifecycle (createdAt,
      // eventSequence, hostSession captured at create time).
      this.stmts.upsertRenderPayload.run(
        JSON.stringify(incoming),
        t,
        incoming.id,
      );
      const updated = this.stmts.getGguiSession.get(incoming.id) as GguiSessionRow;
      return rowToStored(updated);
    }
    // First-write — mint a fresh row using the supplied lifecycle slice.
    const stored: StoredGguiSession = {
      id: incoming.id,
      appId: input.appId,
      userId: input.userId,
      ...(input.endUserIdentity ? { endUserIdentity: input.endUserIdentity } : {}),
      ...(input.themeId !== undefined ? { themeId: input.themeId } : {}),
      ...(input.hostSession !== undefined ? { hostSession: input.hostSession } : {}),
      eventSequence: 0,
      createdAt: t,
      lastActivityAt: t,
      expiresAt: t + this.defaultTtlMs,
      render: incoming,
    };
    this.stmts.insertRender.run(
      stored.id,
      stored.appId,
      stored.userId ?? null,
      JSON.stringify(incoming),
      stored.eventSequence,
      stored.createdAt,
      stored.lastActivityAt,
      stored.expiresAt,
      stored.endUserIdentity ? JSON.stringify(stored.endUserIdentity) : null,
      stored.themeId ?? null,
      stored.hostSession?.hostName ?? null,
      stored.hostSession?.hostSessionId ?? null,
    );
    return stored;
  }

  async appendEvent(input: AppendEventInput): Promise<number> {
    // Serialize the read-then-write under `BEGIN IMMEDIATE` so
    // concurrent appends can't both read `eventSequence = N` and
    // race on `N+1`.
    const txn = this.db.transaction((): { seq: number; event: GguiSessionEvent } => {
      const row = this.stmts.getGguiSession.get(input.renderId) as
        | GguiSessionRow
        | undefined;
      if (!row) {
        throw new Error(
          `SqliteGguiSessionStore.appendEvent: render not found: ${input.renderId}`,
        );
      }
      const seq = row.event_sequence + 1;
      const nowMs = this.now();
      const timestampIso = new Date(nowMs).toISOString();
      this.stmts.insertEvent.run(
        input.renderId,
        seq,
        input.type,
        JSON.stringify(input.data ?? null),
        timestampIso,
      );
      // `last_activity_at` stays numeric ms-epoch — it tracks the
      // render row's lifecycle clock, not the ledger's wire shape.
      this.stmts.bumpSequence.run(seq, nowMs, input.renderId);
      const event: GguiSessionEvent = {
        seq,
        type: input.type,
        timestamp: timestampIso,
        data: input.data,
      };
      return { seq, event };
    });

    const { seq, event } = txn.immediate();
    // Fanout to in-process observers AFTER the transaction commits —
    // observers should never see an event that might be rolled back.
    this.wakeWaiters(input.renderId, event);
    return seq;
  }

  async listEventsSince(
    renderId: string,
    sinceSeq: number,
    limit: number,
  ): Promise<{
    readonly events: readonly GguiSessionEvent[];
    readonly lastSequence: number;
    readonly hasMore: boolean;
    readonly horizonSeq: number;
  } | null> {
    const row = this.stmts.getGguiSession.get(renderId) as GguiSessionRow | undefined;
    if (!row) return null;
    const lastSequence = row.event_sequence;
    const horizonSeq = 0;
    if (sinceSeq < horizonSeq) {
      return { events: [], lastSequence, hasMore: false, horizonSeq };
    }
    const fetched = this.stmts.selectEventsSinceLimited.all(
      renderId,
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

  observe(id: string, opts: ObserveOptions = {}): AsyncIterable<GguiSessionEvent> {
    const fromSeq = opts.fromSeq ?? 1;
    const tail = opts.tail ?? true;
    const selectStmt = this.stmts.selectEventsFromSeq;
    const getStmt = this.stmts.getGguiSession;
    const waitForNext = (renderId: string): Promise<GguiSessionEvent | null> =>
      this.waitForNext(renderId);

    return {
      [Symbol.asyncIterator](): AsyncIterator<GguiSessionEvent> {
        let nextSeq = fromSeq;
        let done = false;
        return {
          async next(): Promise<IteratorResult<GguiSessionEvent>> {
            if (done) return { value: undefined, done: true };
            const row = getStmt.get(id) as GguiSessionRow | undefined;
            if (!row) {
              done = true;
              return { value: undefined, done: true };
            }
            const backlog = selectStmt.get(id, nextSeq) as EventRow | undefined;
            if (backlog) {
              const event = rowToEvent(backlog);
              nextSeq = event.seq + 1;
              return { value: event, done: false };
            }
            if (!tail) {
              done = true;
              return { value: undefined, done: true };
            }
            const event = await waitForNext(id);
            if (event === null) {
              done = true;
              return { value: undefined, done: true };
            }
            nextSeq = event.seq + 1;
            return { value: event, done: false };
          },
          async return(): Promise<IteratorResult<GguiSessionEvent>> {
            done = true;
            return { value: undefined, done: true };
          },
        };
      },
    };
  }

  // ── internals ──────────────────────────────────────────────────────

  private waitForNext(renderId: string): Promise<GguiSessionEvent | null> {
    return new Promise<GguiSessionEvent | null>((resolve) => {
      let waiters = this.waiters.get(renderId);
      if (!waiters) {
        waiters = new Set<Waiter>();
        this.waiters.set(renderId, waiters);
      }
      waiters.add(resolve);
    });
  }

  private wakeWaiters(renderId: string, event: GguiSessionEvent | null): void {
    const waiters = this.waiters.get(renderId);
    if (!waiters || waiters.size === 0) return;
    this.waiters.delete(renderId);
    for (const w of waiters) w(event);
  }

  private wakeAllWaiters(event: GguiSessionEvent | null): void {
    for (const [, waiters] of this.waiters) {
      for (const w of waiters) w(event);
    }
    this.waiters.clear();
  }
}

// `EventEmitter` import kept reachable so its type surface stays valid
// under `noUnusedLocals`. We don't use it directly — the per-render
// waiter set above is purpose-built and cheaper.
void EventEmitter;

// ─────────────────────────────────────────────────────────────────────
// Schema + SQL strings
// ─────────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS renders (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  user_id TEXT,
  payload TEXT NOT NULL,
  event_sequence INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  end_user_identity TEXT,
  theme_id TEXT,
  host_context TEXT,
  host_name TEXT,
  host_session_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_renders_app_id ON renders(app_id);
CREATE INDEX IF NOT EXISTS idx_renders_user_id ON renders(user_id);
-- Composite index for ggui_list_renders(hostName, hostSessionId).
CREATE INDEX IF NOT EXISTS idx_renders_host
  ON renders(host_name, host_session_id);

CREATE TABLE IF NOT EXISTS render_events (
  render_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  -- ISO 8601 UTC string (Wave 7 flatten-render-identity, 2026-05-28).
  -- Previously stored as INTEGER ms-epoch; column type widened to TEXT
  -- so existing sqlite files keep parsing — the column still accepts
  -- numerics in legacy rows. New writes are ISO strings.
  timestamp TEXT NOT NULL,
  PRIMARY KEY (render_id, seq),
  FOREIGN KEY (render_id) REFERENCES renders(id) ON DELETE CASCADE
);
`;

const INSERT_RENDER_SQL = `
INSERT INTO renders (
  id, app_id, user_id, payload,
  event_sequence, created_at, last_activity_at, expires_at,
  end_user_identity, theme_id,
  host_name, host_session_id
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const UPSERT_RENDER_PAYLOAD_SQL = `
UPDATE renders SET payload = ?, last_activity_at = ? WHERE id = ?
`;

// ─────────────────────────────────────────────────────────────────────
// Row ↔ domain conversions
// ─────────────────────────────────────────────────────────────────────

function rowToStored(row: GguiSessionRow): StoredGguiSession {
  const now = Date.now();
  const status: 'active' | 'expired' = row.expires_at <= now
    ? 'expired'
    : 'active';
  const render = parseJson<GguiSession>(row.payload, {
    type: 'component',
    id: row.id,
    appId: row.app_id,
    componentCode: '',
    eventSequence: row.event_sequence,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    expiresAt: row.expires_at,
  } as GguiSession);
  const stored: StoredGguiSession = {
    id: row.id,
    appId: row.app_id,
    userId: row.user_id ?? undefined,
    eventSequence: row.event_sequence,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    expiresAt: row.expires_at,
    status,
    render,
  };
  if (row.end_user_identity) {
    const identity = parseJson<NonNullable<StoredGguiSession['endUserIdentity']> | null>(
      row.end_user_identity,
      null,
    );
    if (identity) (stored as { endUserIdentity?: unknown }).endUserIdentity = identity;
  }
  if (row.theme_id) (stored as { themeId?: string }).themeId = row.theme_id;
  if (row.host_context) {
    const ctx = parseJson<NonNullable<StoredGguiSession['hostContext']> | null>(
      row.host_context,
      null,
    );
    if (ctx) (stored as { hostContext?: unknown }).hostContext = ctx;
  }
  if (row.host_name && row.host_session_id) {
    (stored as { hostSession?: unknown }).hostSession = {
      hostName: row.host_name,
      hostSessionId: row.host_session_id,
    };
  }
  return stored;
}

function rowToEvent(row: EventRow): GguiSessionEvent {
  // Legacy rows (pre-Wave-7) stored a numeric ms-epoch. Coerce on
  // read so downstream consumers always see the ISO string the
  // protocol promises.
  const timestamp =
    typeof row.timestamp === 'number'
      ? new Date(row.timestamp).toISOString()
      : row.timestamp;
  return {
    seq: row.seq,
    type: row.type,
    timestamp,
    data: parseJson<unknown>(row.data, null),
  };
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function computeRowStatus(
  row: GguiSessionRow,
  now: number,
): 'active' | 'expired' {
  if (row.expires_at <= now) return 'expired';
  return 'active';
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const match = cursor.match(/^offset:(\d+)$/);
  return match ? Number(match[1]) : 0;
}
