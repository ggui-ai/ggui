/**
 * Generation cache — the blueprint-cache dep bundle, the cache-hit
 * projection shape, and the console-admin enumeration helpers.
 *
 * Production cache traffic routes through the contract-keyed
 * `blueprint-registry.ts` + `blueprint-matcher.ts`: `render.ts` resolves
 * reuse via `matchBlueprint` / the §6 point-read and registers cold-gen
 * output via `registerBlueprint`. This module carries the surrounding
 * shapes:
 *
 *   - `GenerationCacheDeps` — the `(embedding, vectorStore, index)`
 *     storage bundle callers wire onto `GenerationDeps.cache`;
 *     `render.ts` composes `BlueprintRegistryDeps` from it.
 *   - `GenerationCacheHit` — projection shape `render.ts` builds from a
 *     matched blueprint and `commitCachedGguiSession` reads on the
 *     cache-hit commit path. Kept field-aligned with the cold-gen
 *     render build so both paths emit one shape.
 *   - `GenerationCacheEntry` + `listGenerationCache` +
 *     `invalidateGenerationCache` + `clearGenerationCache` — admin
 *     route helpers backing `/ggui/console/blueprints/cached`. Project
 *     the blueprint-registry row shape so the console viewer sees
 *     live cache rows.
 */
import type {
  BlueprintIndex,
  EmbeddingProvider,
  EnumerableVectorStore,
  VectorStore,
} from '@ggui-ai/mcp-server-core';

/**
 * Blueprint-cache storage bundle. Threaded into the
 * `BlueprintRegistryDeps` the render handler composes so the matcher +
 * registry share one vector store and one identity index instance.
 */
export interface GenerationCacheDeps {
  readonly embedding: EmbeddingProvider;
  readonly vectorStore: VectorStore;
  /**
   * `(scope, exactKey) → blueprintId` identity index. See
   * {@link BlueprintIndex}.
   */
  readonly index: BlueprintIndex;
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
   * Contract projections on the cache hit. `registerBlueprint`
   * persists the full contract in the row metadata, and `render.ts`
   * projects each declared spec from the matched blueprint's contract
   * when it builds the hit. `commitCachedGguiSession` lands them on the
   * ComponentGguiSession symmetrically with the cold-generation path —
   * both paths emit one shape, and bootstrap-meta derivation reads
   * from one place. Absent only when the matched contract itself
   * omitted the spec.
   */
  readonly actionSpec?: import('@ggui-ai/protocol').ActionSpec;
  readonly streamSpec?: import('@ggui-ai/protocol').StreamSpec;
  readonly propsSpec?: import('@ggui-ai/protocol').PropsSpec;
  readonly contextSpec?: import('@ggui-ai/protocol').ContextSpec;
  /**
   * Agent's declared tool catalog, projected from the matched
   * blueprint's contract. Used by `commitCachedGguiSession` so the
   * schema-compat backstop recognizes cross-MCP tools (tools the agent
   * declared in the contract catalog but doesn't expect to live on
   * this server). Without it any reused blueprint whose
   * `actionSpec.nextStep` names a domain (non-`ggui_*`) tool would
   * fail "tool not registered".
   */
  readonly agentCapabilities?: import('@ggui-ai/protocol').AgentCapabilitiesSpec;
  /**
   * `clientCapabilities` projection (from the matched blueprint's
   * contract) used by `commitCachedGguiSession` to derive the iframe's
   * Permissions-Policy directive set.
   */
  readonly clientCapabilities?: import('@ggui-ai/protocol').ClientCapabilitiesSpec;
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
