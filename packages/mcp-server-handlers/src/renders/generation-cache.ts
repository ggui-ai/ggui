/**
 * Generation cache — legacy types + console-admin enumeration helpers.
 *
 * The original intent-keyed cache was superseded by the
 * contract-keyed `blueprint-registry.ts` + `blueprint-matcher.ts`.
 * `render.ts` routes the production cache lookup through
 * `matchBlueprint` now; this module's `lookupGenerationCache` and
 * `recordGenerationCache` functions have been retired.
 *
 * What still lives here:
 *
 *   - `GenerationCacheDeps` + `GenerationCacheHit` — projection shapes
 *     `render.ts` + `commitCachedGguiSession` read on the cache-hit commit
 *     path. The fields stay aligned with what the blueprint-matcher
 *     produces so the commit-site code is one shape regardless of
 *     which match path fired.
 *   - `GenerationCacheEntry` + `listGenerationCache` +
 *     `invalidateGenerationCache` + `clearGenerationCache` — admin
 *     route helpers backing `/ggui/console/blueprints/cached`. Project
 *     the blueprint-registry row shape so the console viewer sees
 *     live cache rows.
 *   - `DEFAULT_CACHE_SIMILARITY_THRESHOLD` + `generationCacheKey` —
 *     still exported for any future diagnostic that wants the legacy
 *     threshold constant or a stable per-intent hash; no live consumer
 *     today.
 */
import { createHash } from 'node:crypto';
import type {
  BlueprintIndex,
  EmbeddingProvider,
  EnumerableVectorStore,
  VectorStore,
} from '@ggui-ai/mcp-server-core';

/**
 * Default cosine-similarity band above which a retrieval counts as a
 * cache hit. Matches `@ggui-ai/negotiator`'s `HIGH_CONFIDENCE_THRESHOLD`
 * so both seams agree on "exact match" semantics.
 */
export const DEFAULT_CACHE_SIMILARITY_THRESHOLD = 0.45;

/** Dependencies for {@link lookupGenerationCache} + {@link recordGenerationCache}. */
export interface GenerationCacheDeps {
  readonly embedding: EmbeddingProvider;
  readonly vectorStore: VectorStore;
  /**
   * `(scope, exactKey) → blueprintId` identity index. Threaded into the
   * `BlueprintRegistryDeps` the render handler composes from this bundle
   * so the matcher + registry share one index instance. See
   * {@link BlueprintIndex}.
   */
  readonly index: BlueprintIndex;
  /**
   * Score above which a top-1 hit is treated as a cache hit. Defaults
   * to {@link DEFAULT_CACHE_SIMILARITY_THRESHOLD}. Callers override
   * when benchmarks tune the band for a specific embedding model
   * (e.g. local bge-small may warrant a different knob than OpenAI's
   * `text-embedding-3-small`).
   */
  readonly similarityThreshold?: number;
}

/** A cache hit the render handler can reconstruct a {@link ComponentGguiSession} from. */
export interface GenerationCacheHit {
  /** Short-hash identifier the render handler echoes on the `cache` marker. */
  readonly cachedBlueprintId: string;
  /** Cosine similarity in `[0, 1]`. Always ≥ the configured threshold. */
  readonly similarity: number;
  /** Cached JS componentCode — dropped straight onto a new `ComponentGguiSession`. */
  readonly componentCode: string;
  /** Original intent that produced the cached blueprint. Diagnostic-only. */
  readonly cachedIntent: string;
  /** ISO timestamp the cached entry was written. Diagnostic-only. */
  readonly cachedAt: string;
  /**
   * Optional contract projections on the cache hit. Today's writer
   * ({@link recordGenerationCache}) does not persist contracts, so
   * cache hits always emit these as `undefined`; they're declared
   * here so the cached-commit path in
   * `commitCachedGguiSession` can project them onto the ComponentGguiSession
   * symmetrically with the cold-generation path. When the cache
   * store evolves to persist contracts, only the writer + reader
   * here change; the consumer site stays untouched.
   */
  readonly actionSpec?: import('@ggui-ai/protocol').ActionSpec;
  readonly streamSpec?: import('@ggui-ai/protocol').StreamSpec;
  readonly propsSpec?: import('@ggui-ai/protocol').PropsSpec;
  readonly contextSpec?: import('@ggui-ai/protocol').ContextSpec;
  /**
   * Agent's declared tool catalog. Used by `commitCachedGguiSession`
   * to project onto the ComponentGguiSession so the schema-compat backstop
   * recognizes cross-MCP tools (tools the agent declared in the
   * contract catalog but doesn't expect to live on this server).
   * Today's cache writer doesn't persist contracts, so cache hits
   * surface `undefined`; declared here for symmetric commit-path
   * shape.
   */
  readonly agentCapabilities?: import('@ggui-ai/protocol').AgentCapabilitiesSpec;
  /**
   * `clientCapabilities` projection used by `commitCachedGguiSession`
   * to derive the iframe's Permissions-Policy directive set. Today's
   * cache writer doesn't persist contracts, so cache hits surface
   * `undefined`; declared here for symmetric commit-path shape.
   */
  readonly clientCapabilities?: import('@ggui-ai/protocol').ClientCapabilitiesSpec;
}

/**
 * Compute the deterministic cache key for an intent. Exported so
 * consumers (tests, future handshake-negotiator integration) can read
 * the same shape the lookup + record paths write.
 *
 * Normalization: trim whitespace. No lowercasing yet — intents like
 * "Weather in Tokyo" vs "weather in tokyo" arguably should collide,
 * but the embedding-similarity band already absorbs small surface-
 * level differences; keeping the key case-sensitive avoids false
 * collisions on intents that legitimately differ in emphasis.
 */
export function generationCacheKey(intent: string): string {
  const normalized = intent.trim();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Narrow scalar-string read for `VectorStore` metadata. The contract
 * allows `string | number | boolean | null`; we accept only string for
 * componentCode / intent / createdAt and fall back to undefined on any
 * other shape.
 */
function readScalarString(
  value: string | number | boolean | null | undefined,
): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readScalarNumber(
  value: string | number | boolean | null | undefined,
): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/**
 * Operator-facing cache entry shape returned by {@link listGenerationCache}.
 * Intentionally **omits** `componentCode` — the console cache viewer
 * lists entries for triage, not rendering; the code blob can be ~10 KB
 * per entry and serializing the full scope would bloat the endpoint
 * response for no paint-time benefit.
 *
 * `contractKey` + `kind` come from the blueprint-registry row's
 * metadata. The id (`entry.key`) is the opaque `bp_<uuid>` minted once
 * at first registration — slot identity is NOT derivable from it, so
 * the console gets `kind` + `contractKey` projected as their own
 * fields for ops display.
 * `hitCount` / `lastHitAt` are populated by `recordBlueprintHit`.
 */
export interface GenerationCacheEntry {
  readonly id: string;
  readonly cachedIntent: string;
  readonly cachedAt: string;
  readonly contractKey: string;
  readonly kind: string;
  readonly hitCount?: number;
  readonly lastHitAt?: string;
}

/**
 * Predicate — does this row carry the blueprint-registry metadata
 * shape? We require `intent + componentCode + contract +
 * contractKey + kind` so the legacy intent-keyed rows (if any survive
 * a sqlite vector store across the migration) are silently skipped.
 * Same defensive guard the list path has always applied; the predicate
 * now matches what `registerBlueprint` writes today.
 */
function isBlueprintCacheRow(
  metadata: Record<string, string | number | boolean | null>,
): boolean {
  return (
    readScalarString(metadata.intent) !== undefined &&
    readScalarString(metadata.componentCode) !== undefined &&
    readScalarString(metadata.contract) !== undefined &&
    readScalarString(metadata.contractKey) !== undefined &&
    readScalarString(metadata.kind) !== undefined
  );
}

/**
 * Enumerate every blueprint-cache entry in `scope`. Requires an
 * {@link EnumerableVectorStore}; callers must type-narrow at the
 * compose boundary (server endpoint) before invoking.
 *
 * Reads the blueprint-registry row shape. Rows that don't match
 * (other vector families in the same scope, legacy intent-keyed
 * orphans from before the registry shipped) are silently skipped.
 *
 * No paging — scopes are operator-bounded by construction. If real
 * usage pushes a single scope past ~1k entries, this signature can
 * grow to take `{ cursor, limit }` under the pre-launch no-backcompat
 * rule; YAGNI today.
 */
export async function listGenerationCache(
  deps: { readonly vectorStore: EnumerableVectorStore },
  scope: string,
): Promise<readonly GenerationCacheEntry[]> {
  const entries = await deps.vectorStore.listByScope(scope);
  const result: GenerationCacheEntry[] = [];
  for (const entry of entries) {
    if (!isBlueprintCacheRow(entry.metadata)) continue;
    const cachedIntent = readScalarString(entry.metadata.intent) ?? '';
    const contractKey = readScalarString(entry.metadata.contractKey) ?? '';
    const kind = readScalarString(entry.metadata.kind) ?? '';
    const cachedAt = readScalarString(entry.metadata.createdAt) ?? '';
    const hitCount = readScalarNumber(entry.metadata.hitCount);
    const lastHitAt = readScalarString(entry.metadata.lastHitAt);
    result.push({
      id: entry.key,
      cachedIntent,
      cachedAt,
      contractKey,
      kind,
      ...(hitCount !== undefined ? { hitCount } : {}),
      ...(lastHitAt !== undefined ? { lastHitAt } : {}),
    });
  }
  return result;
}

/**
 * Remove a single cache entry by id from `scope`. Idempotent — per the
 * {@link VectorStore} contract, deleting a missing key is a no-op.
 * The console endpoint returns 204 either way; operators don't need a
 * separate "was it actually there?" signal because the list they
 * clicked through is the source of truth they just saw.
 *
 * The id is whatever `listGenerationCache` returned, which is the raw
 * `entry.key` from the vector store. For blueprint-registry rows that's
 * the opaque `bp_<uuid>` minted once per `(kind, contractKey,
 * variantKey)` slot. Deleting a row leaves the slot's index binding
 * dangling; the next registration at the same slot self-heals (drops
 * the stale binding, mints a fresh id — see `registerBlueprint`), so a
 * delete→re-prime lands on the same slot under a new id. The function
 * doesn't gate on shape — operators can delete any row by id from this
 * surface, and the row's shape is the registry's concern.
 */
export async function invalidateGenerationCache(
  deps: { readonly vectorStore: VectorStore },
  scope: string,
  id: string,
): Promise<void> {
  await deps.vectorStore.deleteVector(scope, id);
}

/**
 * Delete every blueprint-cache entry in `scope`. Returns the count so
 * the console can echo "cleared N entries." Requires an
 * {@link EnumerableVectorStore} because the `VectorStore` contract
 * has no bulk-delete primitive; we enumerate then delete per-id.
 *
 * Non-cache rows in the scope are left alone — same shape guard the
 * list path uses. Single-scope clears only: neither OSS backend
 * exposes a "list all scopes" API, and building one would leak
 * multi-tenant state.
 */
export async function clearGenerationCache(
  deps: { readonly vectorStore: EnumerableVectorStore },
  scope: string,
): Promise<{ deletedCount: number }> {
  const entries = await deps.vectorStore.listByScope(scope);
  let deletedCount = 0;
  for (const entry of entries) {
    if (!isBlueprintCacheRow(entry.metadata)) continue;
    await deps.vectorStore.deleteVector(scope, entry.key);
    deletedCount++;
  }
  return { deletedCount };
}
