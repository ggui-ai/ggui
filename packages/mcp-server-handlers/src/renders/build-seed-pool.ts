import {
  InMemoryBlueprintIndex,
  InMemoryVectorStore,
} from '@ggui-ai/mcp-server-core/in-memory';
import type {
  EmbeddingProvider,
  EnumerableVectorStore,
  VectorEntry,
  VectorSearchResult,
} from '@ggui-ai/mcp-server-core';
import { fromPortableBlueprint } from '@ggui-ai/protocol/blueprint-key';
import { registerBlueprint } from './blueprint-registry.js';
import type { BlueprintPool } from './decide-handshake.js';
import type { BlueprintSource } from './blueprint-source.js';

/** Embedding provider that never produces a meaningful vector. The seed
 *  pool is exact-key-only, so the vector is never used for similarity —
 *  this keeps loading free of any real embedding model (no provider
 *  coupling) while satisfying registerBlueprint's mandatory embed() call. */
const INERT_EMBEDDING: EmbeddingProvider = {
  id: 'seed-pool-inert',
  dimensions: 1,
  embed: async () => [0],
};

/** Wraps an enumerable store so semantic `query()` yields nothing, while
 *  exact-key reads (listByScope) and writes still work. This is what makes
 *  the seed pool contribute ONLY exact-key hits. */
function semanticInert(inner: EnumerableVectorStore): EnumerableVectorStore {
  return {
    putVector: (scope: string, entry: VectorEntry) => inner.putVector(scope, entry),
    deleteVector: (scope: string, key: string) => inner.deleteVector(scope, key),
    listByScope: (scope: string) => inner.listByScope(scope),
    query: async (): Promise<VectorSearchResult[]> => [],
  };
}

export interface BuildSeedPoolOptions {
  /** Fixed scope for the pool's blueprints (default 'shared'). */
  readonly scope?: string;
}

/**
 * Build a read-only, exact-key-only {@link BlueprintPool} from a
 * {@link BlueprintSource}. Records are loaded into a fresh in-memory
 * registry; keys are recomputed on load (shipped keys are advisory).
 */
export async function buildSeedPool(
  source: BlueprintSource,
  options: BuildSeedPoolOptions,
): Promise<BlueprintPool> {
  const scope = options.scope ?? 'shared';
  const inner = new InMemoryVectorStore();
  const index = new InMemoryBlueprintIndex();
  const registry = { embedding: INERT_EMBEDDING, vectorStore: inner, index };

  for (const record of await source.loadAll()) {
    const { input, keyMismatch } = fromPortableBlueprint(record);
    if (keyMismatch) {
      // eslint-disable-next-line no-console -- operator-visible integrity warning
      console.warn(
        '[ggui] seed pool: a shipped blueprint key did not match recompute; using the recomputed key',
      );
    }
    // A blueprint is a completed template; 'template' is the constant the
    // match path keys on, so the loaded exactKey matches what the handshake computes.
    await registerBlueprint(registry, scope, {
      kind: 'template',
      contract: input.contract,
      intent: input.variance.seedPrompt ?? input.variance.persona ?? 'shared blueprint',
      componentCode: input.componentCode,
      provenance: 'register',
      variance: input.variance,
    });
  }

  return {
    registry: { embedding: INERT_EMBEDDING, vectorStore: semanticInert(inner), index },
    scope,
    label: source.label,
  };
}
