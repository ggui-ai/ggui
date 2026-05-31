/** (scope, exactKey) → blueprint UUID. Sibling of VectorStore: the vector store holds the
 *  embedding+metadata row keyed by UUID; this index resolves the deterministic exact-lookup
 *  key to that UUID without a scope scan. Rebuildable from VectorStore metadata; a stale
 *  binding self-heals at the read site. Spec §7.2. */
export interface BlueprintIndex {
  getId(scope: string, exactKey: string): Promise<string | null>;
  /** First-write-wins on (scope, exactKey) — the dedup primitive. MUST NOT overwrite. */
  putId(scope: string, exactKey: string, blueprintId: string): Promise<void>;
  deleteId(scope: string, exactKey: string): Promise<void>;
}
