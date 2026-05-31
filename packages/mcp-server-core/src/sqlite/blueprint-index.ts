/**
 * SqliteBlueprintIndex — file-backed reference implementation of
 * {@link BlueprintIndex}. Ships as the OSS persistence default for the
 * `(scope, exactKey) → blueprint UUID` exact-lookup index — the
 * deterministic sibling of {@link SqliteVectorStore}, which holds the
 * embedding+metadata row keyed by that same UUID.
 *
 * Goals:
 *
 *   - **Zero-ops.** One SQLite table. No network calls. Works inside
 *     `ggui serve`'s process, and can colocate on a shared DB file.
 *   - **Deterministic dedup.** `putId` is first-write-wins via
 *     `INSERT … ON CONFLICT DO NOTHING` — the registry's dedup
 *     primitive survives process restart unchanged.
 *   - **Rebuildable.** The binding is a cache over `VectorStore`
 *     metadata; a stale or dropped row self-heals at the read site.
 *
 * ## Schema
 *
 * One table; composite primary key on `(scope, exact_key)`:
 *
 * ```sql
 * CREATE TABLE blueprint_index (
 *   scope        TEXT NOT NULL,
 *   exact_key    TEXT NOT NULL,
 *   blueprint_id TEXT NOT NULL,
 *   PRIMARY KEY (scope, exact_key)
 * );
 * ```
 *
 * No secondary indexes — the PK already answers every access path
 * (`getId`, `putId` conflict resolution, `deleteId`) directly.
 *
 * ## Trade-offs vs {@link InMemoryBlueprintIndex}
 *
 *   - Survives process restart — the point of this adapter.
 *   - Every method is a single prepared statement; SQLite's serialised
 *     writer guarantees per-statement atomicity, so no transactions are
 *     needed for the first-write-wins guarantee.
 */
import Database, {
  type Database as SqliteDatabase,
  type Statement as SqliteStatement,
} from 'better-sqlite3';
import type { BlueprintIndex } from '../blueprint-index.js';

export interface SqliteBlueprintIndexOptions {
  /**
   * SQLite database file path. Pass `:memory:` for ephemeral tests
   * (shares the prod code path but resets each instance). Default:
   * `./ggui-blueprint-index.sqlite` relative to the process CWD.
   */
  filename?: string;
  /**
   * Existing `better-sqlite3` instance to reuse. Useful when the host
   * colocates multiple stores on one DB file. Mutually exclusive with
   * `filename` — if both are passed, `database` wins, and `close()`
   * becomes a no-op so the caller still controls the handle.
   */
  database?: SqliteDatabase;
}

/** Row shape stored in the `blueprint_index` table. */
interface BlueprintIndexRow {
  blueprint_id: string;
}

export class SqliteBlueprintIndex implements BlueprintIndex {
  private readonly db: SqliteDatabase;
  private readonly ownsDatabase: boolean;
  private closed = false;

  /** Prepared statements — built once at construction. */
  private readonly stmts: {
    insert: SqliteStatement<unknown[]>;
    select: SqliteStatement<unknown[], BlueprintIndexRow>;
    del: SqliteStatement<unknown[]>;
  };

  constructor(opts: SqliteBlueprintIndexOptions = {}) {
    if (opts.database) {
      this.db = opts.database;
      this.ownsDatabase = false;
    } else {
      this.db = new Database(opts.filename ?? './ggui-blueprint-index.sqlite');
      this.ownsDatabase = true;
    }

    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA_SQL);

    this.stmts = {
      // First-write-wins: `ON CONFLICT DO NOTHING` keeps the existing
      // binding on a (scope, exact_key) collision. This is the dedup
      // primitive — never an overwrite.
      insert: this.db.prepare<unknown[]>(
        `INSERT INTO blueprint_index (scope, exact_key, blueprint_id)
         VALUES (?, ?, ?)
         ON CONFLICT(scope, exact_key) DO NOTHING`,
      ),
      select: this.db.prepare<unknown[], BlueprintIndexRow>(
        `SELECT blueprint_id FROM blueprint_index
         WHERE scope = ? AND exact_key = ?`,
      ),
      del: this.db.prepare<unknown[]>(
        `DELETE FROM blueprint_index WHERE scope = ? AND exact_key = ?`,
      ),
    };
  }

  /** Release the underlying database handle, if owned. Idempotent. */
  close(): void {
    if (this.ownsDatabase && !this.closed) {
      this.closed = true;
      this.db.close();
    }
  }

  async getId(scope: string, exactKey: string): Promise<string | null> {
    const row = this.stmts.select.get(scope, exactKey);
    return row ? row.blueprint_id : null;
  }

  async putId(
    scope: string,
    exactKey: string,
    blueprintId: string,
  ): Promise<void> {
    // `ON CONFLICT DO NOTHING` makes this first-write-wins — a second
    // write of the same (scope, exact_key) is a silent no-op.
    this.stmts.insert.run(scope, exactKey, blueprintId);
  }

  async deleteId(scope: string, exactKey: string): Promise<void> {
    // `DELETE WHERE` is naturally idempotent — zero-row deletes are not
    // errors in SQLite, matching the BlueprintIndex contract.
    this.stmts.del.run(scope, exactKey);
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS blueprint_index (
  scope        TEXT NOT NULL,
  exact_key    TEXT NOT NULL,
  blueprint_id TEXT NOT NULL,
  PRIMARY KEY (scope, exact_key)
);
`;
