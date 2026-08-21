/** (scope, exactKey) → blueprint UUID. Sibling of VectorStore: the vector store holds the
 *  embedding+metadata row keyed by UUID; this index resolves the deterministic exact-lookup
 *  key to that UUID without a scope scan. Rebuildable from VectorStore metadata; a stale
 *  binding self-heals at the read site. Spec §7.2. */
export interface BlueprintIndex {
  getId(scope: string, exactKey: string): Promise<string | null>;
  /** First-write-wins on (scope, exactKey) — the dedup primitive. MUST NOT overwrite. */
  putId(scope: string, exactKey: string, blueprintId: string): Promise<void>;
  deleteId(scope: string, exactKey: string): Promise<void>;
  /**
   * Optional: number of bindings in `scope` whose exactKey starts with
   * the LITERAL `exactKeyPrefix` (no pattern semantics). Powers the
   * registry's eviction count-gate — while the bucket is provably under
   * cap, the O(scope) enumeration is skipped entirely. Implementations
   * MAY over-count (a stale binding merely costs one unnecessary walk);
   * an under-count only risks a single put past the soft ceiling.
   * Callers MUST treat absence or failure as "walk instead", never as
   * an error.
   */
  countIds?(scope: string, exactKeyPrefix: string): Promise<number>;
}
