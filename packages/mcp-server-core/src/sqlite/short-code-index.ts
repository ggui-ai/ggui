/**
 * SqliteShortCodeIndex — file-backed reference implementation of
 * {@link ShortCodeIndex}.
 *
 * Ships as the OSS persistence default for `ggui serve --persistent`
 * (and the implicit-default story without `--ephemeral`). Survives
 * process restart so claude.ai chat-history revisits whose cached
 * `_meta.ggui.bootstrap` envelope still references a previously-minted
 * shortCode keep resolving against `/api/bootstrap/<code>` instead of
 * 404'ing.
 *
 * ## Schema
 *
 * Single table; primary key on the shortCode itself, with an index on
 * `render_id` so {@link findBySessionId} + {@link revokeBySessionId}
 * stay O(matches) instead of O(table).
 *
 * ```sql
 * CREATE TABLE short_codes (
 *   short_code     TEXT PRIMARY KEY,
 *   render_id      TEXT NOT NULL,
 *   app_id         TEXT NOT NULL,
 *   created_at     INTEGER NOT NULL
 * );
 * CREATE INDEX idx_short_codes_render ON short_codes(render_id);
 * ```
 *
 * `created_at` is the deciding signal for {@link findBySessionId}'s
 * "latest shortCode wins" semantics — the in-memory impl tracks this
 * implicitly via Map insertion order; SQLite needs an explicit column
 * so `ORDER BY created_at DESC LIMIT 1` gives the same answer across
 * restarts.
 *
 * ## Trade-offs vs InMemoryShortCodeIndex
 *
 *   - Survives restart — the point.
 *   - Writes are one INSERT OR REPLACE; read paths are one prepared
 *     statement each. No transactions needed: every method is a
 *     single SQL op, and SQLite's serialised writer guarantees
 *     atomicity per-statement.
 *   - Lifetime: the reference never evicts. Renders decay implicitly
 *     via TTL; orphan rows after a crashed process are inert and
 *     cleared by the next `revokeBySessionId` if the operator runs
 *     a teardown sweep, otherwise they sit until manually vacuumed.
 */
import Database, {
  type Database as SqliteDatabase,
  type Statement as SqliteStatement,
} from 'better-sqlite3';
import type {
  ShortCodeBinding,
  ShortCodeIndex,
} from '../short-code-index.js';

export interface SqliteShortCodeIndexOptions {
  /**
   * SQLite database file path. Pass `:memory:` for ephemeral tests
   * (shares the prod code path but resets each instance). Default:
   * `./ggui-short-codes.sqlite` relative to the process CWD —
   * `ggui serve` overrides this with a path under the persistent
   * dir.
   */
  filename?: string;
  /**
   * Existing `better-sqlite3` instance to reuse. Useful when the host
   * colocates multiple stores on one DB file (e.g. renders +
   * short-codes in `ggui-state.sqlite`). Mutually exclusive with
   * `filename` — if both are passed, `database` wins, and `close()`
   * becomes a no-op so the caller still controls the handle.
   */
  database?: SqliteDatabase;
  /** Clock. Defaults to `Date.now`. Inject for deterministic tests. */
  now?: () => number;
}

/** Row shape stored in the `short_codes` table. */
interface ShortCodeRow {
  short_code: string;
  render_id: string;
  app_id: string;
  created_at: number;
}

export class SqliteShortCodeIndex implements ShortCodeIndex {
  private readonly db: SqliteDatabase;
  private readonly ownsDatabase: boolean;
  private readonly now: () => number;

  private readonly stmts: {
    upsert: SqliteStatement<unknown[]>;
    selectByCode: SqliteStatement<unknown[], ShortCodeRow>;
    selectLatestByRender: SqliteStatement<unknown[], ShortCodeRow>;
    deleteByCode: SqliteStatement<unknown[]>;
    deleteByRender: SqliteStatement<unknown[]>;
  };

  constructor(opts: SqliteShortCodeIndexOptions = {}) {
    if (opts.database) {
      this.db = opts.database;
      this.ownsDatabase = false;
    } else {
      this.db = new Database(opts.filename ?? './ggui-short-codes.sqlite');
      this.ownsDatabase = true;
    }
    this.now = opts.now ?? Date.now;

    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA_SQL);

    this.stmts = {
      upsert: this.db.prepare<unknown[]>(
        `INSERT INTO short_codes (short_code, render_id, app_id, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(short_code) DO UPDATE SET
           render_id = excluded.render_id,
           app_id = excluded.app_id,
           created_at = excluded.created_at`,
      ),
      selectByCode: this.db.prepare<unknown[], ShortCodeRow>(
        `SELECT short_code, render_id, app_id, created_at
         FROM short_codes WHERE short_code = ?`,
      ),
      selectLatestByRender: this.db.prepare<unknown[], ShortCodeRow>(
        `SELECT short_code, render_id, app_id, created_at
         FROM short_codes WHERE render_id = ?
         ORDER BY created_at DESC LIMIT 1`,
      ),
      deleteByCode: this.db.prepare<unknown[]>(
        `DELETE FROM short_codes WHERE short_code = ?`,
      ),
      deleteByRender: this.db.prepare<unknown[]>(
        `DELETE FROM short_codes WHERE render_id = ?`,
      ),
    };
  }

  /** Release the underlying database handle, if owned. Idempotent. */
  close(): void {
    if (this.ownsDatabase) this.db.close();
  }

  async put(shortCode: string, binding: ShortCodeBinding): Promise<void> {
    if (!shortCode) {
      throw new Error('SqliteShortCodeIndex.put: shortCode is required');
    }
    this.stmts.upsert.run(
      shortCode,
      binding.sessionId,
      binding.appId,
      this.now(),
    );
  }

  async lookup(shortCode: string): Promise<ShortCodeBinding | null> {
    if (!shortCode) return null;
    const row = this.stmts.selectByCode.get(shortCode);
    if (!row) return null;
    return rowToBinding(row);
  }

  async findBySessionId(sessionId: string): Promise<string | null> {
    if (!sessionId) return null;
    const row = this.stmts.selectLatestByRender.get(sessionId);
    return row ? row.short_code : null;
  }

  async revoke(shortCode: string): Promise<void> {
    if (!shortCode) return;
    this.stmts.deleteByCode.run(shortCode);
  }

  async revokeBySessionId(sessionId: string): Promise<number> {
    if (!sessionId) return 0;
    const result = this.stmts.deleteByRender.run(sessionId);
    return result.changes;
  }
}

function rowToBinding(row: ShortCodeRow): ShortCodeBinding {
  // Defensive shape — callers may mutate.
  return {
    sessionId: row.render_id,
    appId: row.app_id,
  };
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS short_codes (
  short_code  TEXT PRIMARY KEY,
  render_id   TEXT NOT NULL,
  app_id      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_short_codes_render
  ON short_codes(render_id);
`;
