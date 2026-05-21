/**
 * VectorStore — indexed vector storage for RAG retrieval.
 *
 * Decouples the negotiator and RAG search from AWS S3 Vectors so
 * self-hosters can back RAG by SQLite, Postgres/pgvector,
 * Redis/RediSearch, Neo4j, or any vector index.
 *
 * Distinct from {@link BlueprintProvider}:
 *   - `BlueprintProvider` is the catalog / search seam (`list` + `get`
 *     only). It hands out candidate entries the negotiator ranks. The
 *     authoritative source lives in `@ggui-ai/ui-registry`, not here.
 *   - `VectorStore` is the _index_ (put/query embeddings, k-NN) used
 *     by the negotiator for semantic retrieval. A rebuild from the
 *     underlying registry should always be possible.
 *
 * Reference implementations:
 *   - InMemoryVectorStore       (OSS dev default; cosine in memory)
 *   - SqliteVectorStore         (OSS persistence default; sqlite-vss or brute cosine)
 *   - FileVectorStore           (benchmarks; JSON per scope)
 *   - S3VectorsStore            (hosted runtime — `cloud/`, closed)
 *
 * Community-buildable against this contract:
 *   - Postgres / pgvector
 *   - Redis / RediSearch
 *   - Neo4j vector index
 *   - Weaviate / Qdrant / Pinecone wrappers
 */

/** One vector + its metadata, indexed within a scope. */
export interface VectorEntry {
  /**
   * Stable primary key within scope. Typically `contractHash` or
   * `blueprintHash`. Writing the same `(scope, key)` twice MUST upsert
   * atomically — retries never duplicate.
   */
  key: string;

  /** Pre-normalized vector from {@link EmbeddingProvider}. */
  vector: number[];

  /**
   * Free-form metadata the consumer may project on or filter against.
   * Keep values scalar — arrays/objects should be JSON-stringified by the
   * caller so every backend (DynamoDB, Redis hash, SQLite column, Neo4j
   * property) can roundtrip without translation.
   */
  metadata: Record<string, string | number | boolean | null>;
}

/** One hit from a k-NN query. */
export interface VectorSearchResult {
  key: string;
  /** Cosine similarity in `[0, 1]`. `1` = identical, `0` = orthogonal. */
  score: number;
  metadata: Record<string, string | number | boolean | null>;
}

export interface VectorStore {
  /**
   * Upsert a vector within a scope. Idempotent on `(scope, entry.key)`.
   *
   * `scope` is the tenant / index partition — typically `appId`, or the
   * literal `"shared"` for a global catalog index.
   */
  putVector(scope: string, entry: VectorEntry): Promise<void>;

  /** Delete `(scope, key)`. No-op if missing. */
  deleteVector(scope: string, key: string): Promise<void>;

  /**
   * Return the top-`topK` vectors by cosine similarity within `scope`.
   *
   * Normative semantics:
   * - Results MUST be sorted by `score` descending.
   * - Vectors from other scopes MUST NOT leak (no cross-tenant contamination).
   * - An empty scope returns `[]`, never an error.
   * - Implementations MAY return fewer than `topK` results if the scope
   *   has fewer entries.
   */
  query(
    scope: string,
    queryEmbedding: number[],
    topK?: number,
  ): Promise<VectorSearchResult[]>;
}

/**
 * Optional capability: enumerate all entries in a scope without
 * scoring against a query vector. Kept separate from {@link VectorStore}
 * because not every backend has a cheap "list all" API — notably AWS
 * S3 Vectors exposes only paginated `ListVectorsCommand` (≤500/page),
 * which is honest work that doesn't belong on the base contract.
 *
 * Consumers that need enumeration (the OSS console cache viewer, seed
 * / export tooling) MUST type-narrow with {@link isEnumerableVectorStore}
 * before calling `listByScope` and surface a clear "backend doesn't
 * support enumeration" error otherwise — never a runtime throw from
 * inside a stubbed method.
 *
 * Implementation note: `listByScope` returns {@link VectorEntry}, not
 * {@link VectorSearchResult} — there's no query vector, so no score.
 * Results are returned in insertion order when the backend naturally
 * preserves it; implementations MAY reorder freely.
 */
export interface EnumerableVectorStore extends VectorStore {
  /**
   * Return every entry in `scope`. Empty scope returns `[]`, never an
   * error. No paging — see class-level discussion on the scope-bounded
   * semantics. Backends facing real enumeration cost should NOT
   * implement this interface.
   */
  listByScope(scope: string): Promise<readonly VectorEntry[]>;
}

/** Type guard: does this store support `listByScope`? */
export function isEnumerableVectorStore(
  store: VectorStore,
): store is EnumerableVectorStore {
  return (
    typeof (store as { listByScope?: unknown }).listByScope === 'function'
  );
}
