/**
 * BlueprintProvider — blueprint catalog / search seam.
 *
 * Two responsibilities, and only two:
 *
 * - Catalog browsing (`list`).
 * - Id → blueprint hydration (`get`).
 *
 * That's it. Two read methods. The harness consults this during
 * generation to pull candidate blueprints; the negotiator ranks
 * the results. Provider + index are the middle layer of the
 * three-layer stack:
 *
 *     negotiator  →  provider (this)  →  registry
 *
 * Provider sits between the decision layer (negotiator,
 * registry-agnostic) and the source layer (registry, authoritative
 * storage of UI artifacts in `@ggui-ai/ui-registry`). Dependency
 * direction never reverses.
 *
 * What the provider is NOT:
 *
 * - NOT a source of truth for UI artifacts. Authoring / publishing
 *   / conflict detection belongs to `UiRegistry` in
 *   `@ggui-ai/ui-registry`. The provider's prior `put` method was
 *   a source-write concern; it's been removed.
 * - NOT the vector / semantic search engine. Embedding-based
 *   retrieval belongs to {@link VectorStore}. The provider's prior
 *   `search` method duplicated that responsibility and had no
 *   callers; it's been removed.
 *
 * Planned: make the provider registry-backed so a single
 * implementation can serve multiple registries (local `ggui dev`,
 * cloud, etc.) through the same search-seam interface.
 *
 * Reference implementations:
 *   - LocalBlueprintProvider    (OSS default; local blueprints folder + SQLite index)
 *   - HostedBlueprintProvider   (optional; read-through cache of the hosted-runtime curated catalog)
 *   - DynamoBlueprintProvider   (hosted runtime — `cloud/`, closed)
 */
import type { ScreenBlueprint } from '@ggui-ai/protocol';

/**
 * Catalog entry — list returns these; `get` returns the full
 * {@link ScreenBlueprint}.
 *
 * Kept small so `list()` can paginate across large catalogs cheaply.
 */
export interface BlueprintEntry {
  id: string;
  /** Short human-readable name for UIs and logs. */
  name: string;
  /** Optional description for the catalog browser / RAG hinting. */
  description?: string;
  /** Source of truth — informs retrieval behavior. */
  source: 'curated' | 'heuristic' | 'llm' | 'user';
  /** ISO timestamp of last modification. */
  updatedAt: string;
  /** Free-form tags for filter/search. */
  tags?: string[];
}

/**
 * Filter for {@link BlueprintProvider.list}.
 */
export interface BlueprintFilter {
  source?: BlueprintEntry['source'];
  tag?: string;
  /** Full-text-ish match against name+description. Provider may ignore. */
  query?: string;
  limit?: number;
  cursor?: string;
}

export interface BlueprintProvider {
  /** Browse the catalog. Pagination via `filter.cursor`. */
  list(filter: BlueprintFilter): Promise<BlueprintEntry[]>;

  /** Fetch the full blueprint by id. Returns null if not found. */
  get(id: string): Promise<ScreenBlueprint | null>;
}
