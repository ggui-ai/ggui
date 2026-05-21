/**
 * InMemoryVectorStore — reference implementation of {@link VectorStore}.
 *
 * Intended for tests and dev. Stores vectors in a Map keyed by scope;
 * cosine similarity computed locally. No persistence, no concurrency
 * guarantees beyond single-threaded JS. Not a production backend.
 *
 * Production bindings (S3 Vectors, pgvector, Redis/RediSearch, Neo4j)
 * ship as separate packages and MUST pass `vectorStoreContract` to be
 * considered compatible.
 */
import type {
  EnumerableVectorStore,
  VectorEntry,
  VectorSearchResult,
} from '../vector-store.js';

export class InMemoryVectorStore implements EnumerableVectorStore {
  /** scope → key → entry */
  private readonly index = new Map<string, Map<string, VectorEntry>>();

  async putVector(scope: string, entry: VectorEntry): Promise<void> {
    let bucket = this.index.get(scope);
    if (!bucket) {
      bucket = new Map();
      this.index.set(scope, bucket);
    }
    // Clone so downstream mutations don't leak into the store. Vector
    // array is copied by slice(); metadata is a flat scalar map so a
    // shallow spread is sufficient.
    bucket.set(entry.key, {
      key: entry.key,
      vector: entry.vector.slice(),
      metadata: { ...entry.metadata },
    });
  }

  async deleteVector(scope: string, key: string): Promise<void> {
    this.index.get(scope)?.delete(key);
  }

  async query(
    scope: string,
    queryEmbedding: number[],
    topK = 10,
  ): Promise<VectorSearchResult[]> {
    const bucket = this.index.get(scope);
    if (!bucket || bucket.size === 0) return [];
    const results: VectorSearchResult[] = [];
    for (const entry of bucket.values()) {
      results.push({
        key: entry.key,
        score: cosineSimilarity(queryEmbedding, entry.vector),
        metadata: { ...entry.metadata },
      });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  async listByScope(scope: string): Promise<readonly VectorEntry[]> {
    const bucket = this.index.get(scope);
    if (!bucket || bucket.size === 0) return [];
    // Clone on the way out — same invariant as `query` / `putVector`:
    // the store never hands out its internal references.
    return Array.from(bucket.values(), (entry) => ({
      key: entry.key,
      vector: entry.vector.slice(),
      metadata: { ...entry.metadata },
    }));
  }
}

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
  if (mag === 0) return 0;
  // Clamp to [-1, 1] to absorb floating-point drift. Identical
  // unit-norm vectors produce `dot/mag = 1 + ε` on some architectures
  // (observed with MockEmbeddingProvider's sine/cosine basis), and
  // downstream consumers (e.g. `pushOutputSchema.cache.similarity`
  // and `handshakeOutputSchema.match.confidence`) enforce `.max(1)`
  // via zod. Without this clamp a legitimate identity match fails
  // wire validation. The mathematical contract for cosine is already
  // [-1, 1]; the clamp is a numerical-stability guard, not a
  // semantic change.
  const raw = dot / mag;
  return Math.min(1, Math.max(-1, raw));
}
