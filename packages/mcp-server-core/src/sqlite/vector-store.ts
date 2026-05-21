/**
 * SqliteVectorStore — file-backed reference implementation of
 * {@link VectorStore}. Ships as the OSS persistence default for
 * local RAG — blueprints, contract hashes, any scope-partitioned
 * vector index the negotiator wants to persist.
 *
 * Goals:
 *
 *   - **Zero-ops.** One SQLite file. No Postgres, no Qdrant, no
 *     network calls. Works inside `ggui serve`'s process.
 *   - **Auditable.** JSON-encoded vector + metadata per row. `cat`
 *     + `jq` inspection is a supported workflow, not an accident.
 *   - **Deterministic.** Cosine scoring happens in-process over
 *     the full scope; no approximate-ANN jitter, no index warmup.
 *   - **Honest for OSS scale.** Brute-force cosine scales linearly
 *     with scope size. Personal-mode scopes (< ~10k vectors) see
 *     single-digit-ms queries on a modern laptop. Larger scopes
 *     should bind pgvector / Qdrant / etc. against the same
 *     interface — this adapter is the default, not a ceiling.
 *
 * ## Schema
 *
 * One table; composite primary key on `(scope, key)`:
 *
 * ```sql
 * CREATE TABLE vectors (
 *   scope     TEXT NOT NULL,
 *   key       TEXT NOT NULL,
 *   vector    TEXT NOT NULL,  -- JSON-encoded number[]
 *   metadata  TEXT NOT NULL,  -- JSON-encoded scalar map
 *   PRIMARY KEY (scope, key)
 * );
 * ```
 *
 * No secondary indexes — the PK already answers scope-prefix
 * scans efficiently. A `magnitude` column (precomputed) was
 * considered and rejected: cosine over fully-normalized vectors
 * (the {@link EmbeddingProvider} contract pre-normalizes) reduces
 * to dot-product, and JSON parse dominates the compute cost
 * anyway. Optimise when a real consumer needs it.
 *
 * ## Trade-offs vs {@link InMemoryVectorStore}
 *
 *   - Survives process restart — the point of this adapter.
 *   - Reads pay JSON parse per row. For scope < 10k this is
 *     sub-millisecond per query in practice.
 *   - Writes are O(1) — single prepared statement, no sidecar
 *     index rebuild.
 *
 * Scaffold commit: shape + schema + prepared statements + close.
 * `putVector` / `deleteVector` / `query` bodies land in the next
 * commit so reviewers can see the skeleton independent of the
 * semantics.
 */
import Database, {
  type Database as SqliteDatabase,
  type Statement as SqliteStatement,
} from 'better-sqlite3';
import type {
  EnumerableVectorStore,
  VectorEntry,
  VectorSearchResult,
} from '../vector-store.js';

export interface SqliteVectorStoreOptions {
  /**
   * SQLite database file path. Pass `:memory:` for ephemeral
   * tests. Default: `./ggui-vectors.sqlite` (relative to the
   * process CWD).
   */
  filename?: string;
  /**
   * Existing `better-sqlite3` instance to reuse. Mutually
   * exclusive with `filename` — if both, `database` wins.
   * Useful when colocating multiple stores on one DB file.
   */
  database?: SqliteDatabase;
}

/** Row shape stored in the `vectors` table. */
interface VectorRow {
  scope: string;
  key: string;
  vector: string;
  metadata: string;
}

export class SqliteVectorStore implements EnumerableVectorStore {
  private readonly db: SqliteDatabase;
  private readonly ownsDatabase: boolean;

  /** Prepared statements — built once at construction. */
  private readonly stmts: {
    upsert: SqliteStatement<unknown[]>;
    del: SqliteStatement<unknown[]>;
    selectScope: SqliteStatement<unknown[], VectorRow>;
  };

  constructor(opts: SqliteVectorStoreOptions = {}) {
    if (opts.database) {
      this.db = opts.database;
      this.ownsDatabase = false;
    } else {
      this.db = new Database(opts.filename ?? './ggui-vectors.sqlite');
      this.ownsDatabase = true;
    }

    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA_SQL);

    this.stmts = {
      upsert: this.db.prepare<unknown[]>(UPSERT_SQL),
      del: this.db.prepare<unknown[]>(
        `DELETE FROM vectors WHERE scope = ? AND key = ?`,
      ),
      // Shared between `query` and `listByScope` — both are full-scope
      // scans keyed on the composite PK; SQLite's index answers the
      // `scope = ?` predicate without a table scan.
      selectScope: this.db.prepare<unknown[], VectorRow>(
        `SELECT scope, key, vector, metadata FROM vectors WHERE scope = ?`,
      ),
    };
  }

  /** Release the underlying database handle, if owned. Idempotent. */
  close(): void {
    if (this.ownsDatabase) this.db.close();
  }

  async putVector(scope: string, entry: VectorEntry): Promise<void> {
    // Upsert via `ON CONFLICT(scope, key) DO UPDATE`. The composite
    // primary key makes (scope, key) collision the only conflict path;
    // double-writes are atomic inside SQLite's single writer model.
    this.stmts.upsert.run(
      scope,
      entry.key,
      JSON.stringify(entry.vector),
      JSON.stringify(entry.metadata),
    );
  }

  async deleteVector(scope: string, key: string): Promise<void> {
    // `DELETE WHERE` is naturally idempotent — zero-row deletes are
    // not errors in SQLite, which matches the VectorStore contract.
    this.stmts.del.run(scope, key);
  }

  async query(
    scope: string,
    queryEmbedding: number[],
    topK = 10,
  ): Promise<VectorSearchResult[]> {
    // Full-scope scan. SQLite's PK index answers the `scope = ?`
    // predicate; we parse + score each row in process. Brute-force
    // cosine is honest for OSS scope sizes; see the class JSDoc.
    const rows = this.stmts.selectScope.all(scope);
    if (rows.length === 0) return [];

    const results: VectorSearchResult[] = [];
    for (const row of rows) {
      const vector = parseVector(row.vector);
      if (!vector) continue; // corrupt row — skip rather than throw
      const metadata = parseMetadata(row.metadata);
      results.push({
        key: row.key,
        score: cosineSimilarity(queryEmbedding, vector),
        metadata,
      });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  async listByScope(scope: string): Promise<readonly VectorEntry[]> {
    // Same PK-scoped scan as `query`, minus the cosine step.
    // Corrupt rows are skipped (matching `query`'s behavior) rather
    // than surfaced — operators debugging via `cat` + `jq` still see
    // them at the SQL level.
    const rows = this.stmts.selectScope.all(scope);
    if (rows.length === 0) return [];
    const entries: VectorEntry[] = [];
    for (const row of rows) {
      const vector = parseVector(row.vector);
      if (!vector) continue;
      entries.push({
        key: row.key,
        vector,
        metadata: parseMetadata(row.metadata),
      });
    }
    return entries;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Row ↔ domain conversions
// ─────────────────────────────────────────────────────────────────────

function parseVector(raw: string): number[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    for (const n of parsed) {
      if (typeof n !== 'number' || !Number.isFinite(n)) return null;
    }
    return parsed as number[];
  } catch {
    return null;
  }
}

function parseMetadata(
  raw: string,
): Record<string, string | number | boolean | null> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object') return {};
    // The VectorStore contract constrains metadata to scalar values;
    // we defensively cast here rather than re-validate every key —
    // the adapter trusts what it wrote.
    return parsed as Record<string, string | number | boolean | null>;
  } catch {
    return {};
  }
}

/**
 * Cosine similarity. Mirrors the in-memory reference bit-for-bit so
 * the two adapters rank identical inputs identically. Returns 0 for
 * mismatched-length or zero-magnitude pairs — matches VectorStore
 * contract "never throw on malformed inputs."
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    magA += ai * ai;
    magB += bi * bi;
  }
  const mag = Math.sqrt(magA) * Math.sqrt(magB);
  return mag === 0 ? 0 : dot / mag;
}

// ─────────────────────────────────────────────────────────────────────
// SQL
// ─────────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS vectors (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  vector TEXT NOT NULL,
  metadata TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);
`;

const UPSERT_SQL = `
INSERT INTO vectors (scope, key, vector, metadata) VALUES (?, ?, ?, ?)
ON CONFLICT(scope, key) DO UPDATE SET
  vector = excluded.vector,
  metadata = excluded.metadata
`;
