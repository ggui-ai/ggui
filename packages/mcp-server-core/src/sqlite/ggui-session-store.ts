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
 * Live tailing is served by an in-process waiter set (one resolver per
 * parked `observe` iterator). That's **intentionally narrower** than
 * the interface allows:
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
import { isRecord } from '@ggui-ai/protocol';
import type {
  EndUserIdentity,
  GguiSession,
  HostContextProjection,
} from '@ggui-ai/protocol';
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
} from '../ggui-session-store.js';

export interface SqliteGguiSessionStoreOptions {
  /**
   * SQLite database file path. Pass `:memory:` for ephemeral tests
   * — shares the `SqliteGguiSessionStore` code path but gets reset on
   * every instance. Default: `./ggui-sessions.sqlite` (relative to
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
  /**
   * ISO 8601 UTC timestamp stamped at append time. Legacy rows
   * (pre-Wave-7) stored a numeric ms-epoch; {@link rowToEvent} coerces
   * those on read so consumers always see the ISO string.
   */
  timestamp: string | number;
}

/** Per-render tail waiter — parked on `waitForNext()` until an append
 *  or delete wakes it via the per-render waiter set. */
type Waiter = (event: GguiSessionEvent | null) => void;

export class SqliteGguiSessionStore implements GguiSessionStore {
  private readonly db: SqliteDatabase;
  private readonly ownsDatabase: boolean;
  private readonly now: () => number;
  private readonly idGenerator: () => string;
  private readonly defaultTtlMs: number;

  /** Fanout: sessionId → listeners waiting for the next append / close. */
  private readonly waiters = new Map<string, Set<Waiter>>();

  /**
   * Prepared statements — built once at construction for hot paths.
   * Row-returning statements deliberately keep the default `unknown`
   * result type: the database file is operator-mutable in self-hosted
   * deployments, so every read narrows through {@link asGguiSessionRow} /
   * {@link asEventRow} instead of asserting the row shape.
   */
  private readonly stmts: {
    insertRender: SqliteStatement<unknown[]>;
    upsertRenderPayload: SqliteStatement<unknown[]>;
    getGguiSession: SqliteStatement<unknown[]>;
    listAll: SqliteStatement<unknown[]>;
    updateTimestamps: SqliteStatement<unknown[]>;
    updateHostContext: SqliteStatement<unknown[]>;
    deleteRender: SqliteStatement<unknown[]>;
    deleteRenderEvents: SqliteStatement<unknown[]>;
    insertEvent: SqliteStatement<unknown[]>;
    bumpSequence: SqliteStatement<unknown[]>;
    selectEventsFromSeq: SqliteStatement<unknown[]>;
    selectEventsSinceLimited: SqliteStatement<unknown[]>;
  };

  private idCounter = 0;

  constructor(opts: SqliteGguiSessionStoreOptions = {}) {
    if (opts.database) {
      this.db = opts.database;
      this.ownsDatabase = false;
    } else {
      this.db = new Database(opts.filename ?? './ggui-sessions.sqlite');
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
      getGguiSession: this.db.prepare<unknown[]>(
        `SELECT * FROM renders WHERE id = ?`,
      ),
      listAll: this.db.prepare<unknown[]>(
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
      selectEventsFromSeq: this.db.prepare<unknown[]>(
        `SELECT * FROM render_events WHERE render_id = ? AND seq >= ? ORDER BY seq ASC`,
      ),
      // R7 — `listEventsSince(sessionId, sinceSeq, limit)` backing.
      // STRICT inequality (`seq > ?`) since callers pass their cursor
      // and want only events newer than what they've already seen.
      // We fetch `limit + 1` to compute `hasMore` in a single query.
      selectEventsSinceLimited: this.db.prepare<unknown[]>(
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
    const existing = asGguiSessionRow(this.stmts.getGguiSession.get(id));
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
    const row = asGguiSessionRow(this.stmts.getGguiSession.get(id));
    return row ? rowToStored(row) : null;
  }

  async list(filter: GguiSessionFilter): Promise<StoredGguiSession[]> {
    const rows = this.stmts.listAll
      .all()
      .map((raw) => requireGguiSessionRow(raw));
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
    const row = asGguiSessionRow(this.stmts.getGguiSession.get(id));
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
    const updated = requireGguiSessionRow(this.stmts.getGguiSession.get(id));
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
    const existing = asGguiSessionRow(
      this.stmts.getGguiSession.get(incoming.id),
    );
    const t = this.now();
    if (existing) {
      // Replace visible-bits surface; preserve lifecycle (createdAt,
      // eventSequence, hostSession captured at create time).
      this.stmts.upsertRenderPayload.run(
        JSON.stringify(incoming),
        t,
        incoming.id,
      );
      const updated = requireGguiSessionRow(
        this.stmts.getGguiSession.get(incoming.id),
      );
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
      const row = asGguiSessionRow(
        this.stmts.getGguiSession.get(input.sessionId),
      );
      if (!row) {
        throw new Error(
          `SqliteGguiSessionStore.appendEvent: render not found: ${input.sessionId}`,
        );
      }
      const seq = row.event_sequence + 1;
      const nowMs = this.now();
      const timestampIso = new Date(nowMs).toISOString();
      this.stmts.insertEvent.run(
        input.sessionId,
        seq,
        input.type,
        JSON.stringify(input.data ?? null),
        timestampIso,
      );
      // `last_activity_at` stays numeric ms-epoch — it tracks the
      // render row's lifecycle clock, not the ledger's wire shape.
      this.stmts.bumpSequence.run(seq, nowMs, input.sessionId);
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
    this.wakeWaiters(input.sessionId, event);
    return seq;
  }

  async listEventsSince(
    sessionId: string,
    sinceSeq: number,
    limit: number,
  ): Promise<{
    readonly events: readonly GguiSessionEvent[];
    readonly lastSequence: number;
    readonly hasMore: boolean;
    readonly horizonSeq: number;
  } | null> {
    const row = asGguiSessionRow(this.stmts.getGguiSession.get(sessionId));
    if (!row) return null;
    const lastSequence = row.event_sequence;
    const horizonSeq = 0;
    if (sinceSeq < horizonSeq) {
      return { events: [], lastSequence, hasMore: false, horizonSeq };
    }
    const fetched = this.stmts.selectEventsSinceLimited
      .all(sessionId, sinceSeq, limit + 1)
      .map((raw) => requireEventRow(raw));
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
    const waitForNext = (sessionId: string): Promise<GguiSessionEvent | null> =>
      this.waitForNext(sessionId);

    return {
      [Symbol.asyncIterator](): AsyncIterator<GguiSessionEvent> {
        let nextSeq = fromSeq;
        let done = false;
        return {
          async next(): Promise<IteratorResult<GguiSessionEvent>> {
            if (done) return { value: undefined, done: true };
            const row = asGguiSessionRow(getStmt.get(id));
            if (!row) {
              done = true;
              return { value: undefined, done: true };
            }
            const backlog = asEventRow(selectStmt.get(id, nextSeq));
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

  private waitForNext(sessionId: string): Promise<GguiSessionEvent | null> {
    return new Promise<GguiSessionEvent | null>((resolve) => {
      let waiters = this.waiters.get(sessionId);
      if (!waiters) {
        waiters = new Set<Waiter>();
        this.waiters.set(sessionId, waiters);
      }
      waiters.add(resolve);
    });
  }

  private wakeWaiters(sessionId: string, event: GguiSessionEvent | null): void {
    const waiters = this.waiters.get(sessionId);
    if (!waiters || waiters.size === 0) return;
    this.waiters.delete(sessionId);
    for (const w of waiters) w(event);
  }

  private wakeAllWaiters(event: GguiSessionEvent | null): void {
    for (const [, waiters] of this.waiters) {
      for (const w of waiters) w(event);
    }
    this.waiters.clear();
  }
}

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
-- Composite index for ggui_list_sessions(hostName, hostSessionId).
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
// Row narrowing + row ↔ domain conversions
//
// The database file is operator-mutable in self-hosted deployments, so
// SQLite reads are a trust boundary: every row is narrowed by checking
// column types before assembly — never asserted via `as Row`. A row
// whose columns don't match the schema fails LOUDLY (the file was
// written by an incompatible schema or mutated externally); JSON
// payload *columns* that parse but don't match their expected shape
// degrade per-field (placeholder render / omitted optional field),
// matching the long-standing unparseable-JSON posture.
// ─────────────────────────────────────────────────────────────────────

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function malformedRowError(table: string, id: unknown): Error {
  const suffix = typeof id === 'string' ? ` (id=${id})` : '';
  return new Error(
    `SqliteGguiSessionStore: malformed \`${table}\` row${suffix} — column types do not match the expected schema. The database file was written by an incompatible schema version or mutated externally.`,
  );
}

/** Narrow a raw `renders` row. `undefined` (no row) passes through. */
function asGguiSessionRow(raw: unknown): GguiSessionRow | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw malformedRowError('renders', undefined);
  const {
    id,
    app_id,
    user_id,
    payload,
    event_sequence,
    created_at,
    last_activity_at,
    expires_at,
    end_user_identity,
    theme_id,
    host_context,
    host_name,
    host_session_id,
  } = raw;
  if (
    typeof id !== 'string' ||
    typeof app_id !== 'string' ||
    !isNullableString(user_id) ||
    typeof payload !== 'string' ||
    typeof event_sequence !== 'number' ||
    typeof created_at !== 'number' ||
    typeof last_activity_at !== 'number' ||
    typeof expires_at !== 'number' ||
    !isNullableString(end_user_identity) ||
    !isNullableString(theme_id) ||
    !isNullableString(host_context) ||
    !isNullableString(host_name) ||
    !isNullableString(host_session_id)
  ) {
    throw malformedRowError('renders', raw.id);
  }
  return {
    id,
    app_id,
    user_id,
    payload,
    event_sequence,
    created_at,
    last_activity_at,
    expires_at,
    end_user_identity,
    theme_id,
    host_context,
    host_name,
    host_session_id,
  };
}

/** Like {@link asGguiSessionRow} but for reads that just wrote the row. */
function requireGguiSessionRow(raw: unknown): GguiSessionRow {
  const row = asGguiSessionRow(raw);
  if (!row) throw malformedRowError('renders', undefined);
  return row;
}

/** Narrow a raw `render_events` row. `undefined` (no row) passes through. */
function asEventRow(raw: unknown): EventRow | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw malformedRowError('render_events', undefined);
  const { render_id, seq, type, data, timestamp } = raw;
  if (
    typeof render_id !== 'string' ||
    typeof seq !== 'number' ||
    typeof type !== 'string' ||
    typeof data !== 'string' ||
    // Legacy rows (pre-Wave-7) store a numeric ms-epoch timestamp;
    // `rowToEvent` coerces it to the ISO string the protocol promises.
    !(typeof timestamp === 'string' || typeof timestamp === 'number')
  ) {
    throw malformedRowError('render_events', raw.render_id);
  }
  return { render_id, seq, type, data, timestamp };
}

function requireEventRow(raw: unknown): EventRow {
  const row = asEventRow(raw);
  if (!row) throw malformedRowError('render_events', undefined);
  return row;
}

/**
 * Structural narrower for the persisted wire-shape payload. The
 * payload was serialized from a typed {@link GguiSession} at the
 * `create`/`commit` seam, so this checks the union's load-bearing
 * discriminants + identity fields rather than re-deriving the full
 * protocol shape here (the deep field types are protocol-owned and
 * were enforced at the write seam). A payload mutated into a different
 * shape fails the guard and the read degrades to the placeholder
 * render rebuilt from the validated columns.
 */
function isPersistedGguiSession(value: unknown): value is GguiSession {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string') return false;
  if (value.type === 'mcpApps') {
    // McpAppsGguiSession carries locator metadata only — no server
    // lifecycle fields on the wire shape.
    return typeof value.createdAt === 'string' && isRecord(value.source);
  }
  if (
    typeof value.appId !== 'string' ||
    typeof value.eventSequence !== 'number' ||
    typeof value.createdAt !== 'number' ||
    typeof value.lastActivityAt !== 'number' ||
    typeof value.expiresAt !== 'number'
  ) {
    return false;
  }
  if (value.type === 'system') return typeof value.kind === 'string';
  // ComponentGguiSession: `type` is 'component' or absent.
  return (
    (value.type === undefined || value.type === 'component') &&
    typeof value.componentCode === 'string'
  );
}

function isEndUserIdentity(value: unknown): value is EndUserIdentity {
  return (
    isRecord(value) &&
    typeof value.userId === 'string' &&
    (value.provider === 'ggui' || value.provider === 'custom') &&
    typeof value.authenticatedAt === 'string'
  );
}

/**
 * Every {@link HostContextProjection} field is optional; the
 * load-bearing check is object-shape. Field-level validation happened
 * at the wire ingress (`host_context_observed` handler) before the
 * projection was persisted via `update()`.
 */
function isHostContextProjection(
  value: unknown,
): value is HostContextProjection {
  return isRecord(value);
}

function rowToStored(row: GguiSessionRow): StoredGguiSession {
  const now = Date.now();
  const status: 'active' | 'expired' = row.expires_at <= now
    ? 'expired'
    : 'active';
  const fallbackRender: GguiSession = {
    type: 'component',
    id: row.id,
    appId: row.app_id,
    componentCode: '',
    eventSequence: row.event_sequence,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    expiresAt: row.expires_at,
  };
  const payload = parseJsonValue(row.payload);
  const render: GguiSession = isPersistedGguiSession(payload)
    ? payload
    : fallbackRender;
  const endUserIdentity = row.end_user_identity
    ? parseJsonShaped(row.end_user_identity, isEndUserIdentity)
    : undefined;
  const hostContext = row.host_context
    ? parseJsonShaped(row.host_context, isHostContextProjection)
    : undefined;
  return {
    id: row.id,
    appId: row.app_id,
    userId: row.user_id ?? undefined,
    eventSequence: row.event_sequence,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    expiresAt: row.expires_at,
    status,
    render,
    ...(endUserIdentity !== undefined ? { endUserIdentity } : {}),
    ...(row.theme_id ? { themeId: row.theme_id } : {}),
    ...(hostContext !== undefined ? { hostContext } : {}),
    ...(row.host_name && row.host_session_id
      ? {
          hostSession: {
            hostName: row.host_name,
            hostSessionId: row.host_session_id,
          },
        }
      : {}),
  };
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
    data: parseJsonValue(row.data) ?? null,
  };
}

/** Parse JSON, returning `undefined` on syntax failure. */
function parseJsonValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** Parse JSON and narrow through `guard`; `undefined` on either failure. */
function parseJsonShaped<T>(
  raw: string,
  guard: (value: unknown) => value is T,
): T | undefined {
  const parsed = parseJsonValue(raw);
  return guard(parsed) ? parsed : undefined;
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
