/**
 * Search-blueprints handler tests. Uses in-memory fakes from
 * `@ggui-ai/mcp-server-core/in-memory` to drive the handler against
 * real `VectorStore` + `EmbeddingProvider` implementations — no
 * concrete-class mocking, no AWS, no network.
 *
 * Ports the coverage shape from the original hosted test suite so
 * behavior parity is mechanically provable.
 */
import { describe, expect, it } from 'vitest';
import {
  InMemoryVectorStore,
  ManifestBlueprintProvider,
  MockEmbeddingProvider,
} from '@ggui-ai/mcp-server-core/in-memory';
import type { HandlerContext } from '../types.js';
import {
  createSearchBlueprintsHandler,
  MANIFEST_EXACT_NAME_SCORE,
  MANIFEST_SUBSTRING_SCORE,
  MIN_SIMILARITY_SCORE,
} from './search-blueprints.js';

const ctx: HandlerContext = { appId: 'app-a', requestId: 'r-1' };

function makeDeps(): {
  embedding: MockEmbeddingProvider;
  vectors: InMemoryVectorStore;
} {
  return {
    embedding: new MockEmbeddingProvider({ dimensions: 16 }),
    vectors: new InMemoryVectorStore(),
  };
}

/**
 * Seed a blueprint-registry-shaped row (the `blueprintToMetadata`
 * layout): `intent` prose + flat provenance scalars. Tests that need
 * a row WITHOUT valid provenance pass `sourceKind: ''` overrides.
 */
async function seed(
  embedding: MockEmbeddingProvider,
  vectors: InMemoryVectorStore,
  scope: string,
  key: string,
  text: string,
  metadata: Record<string, string | number | boolean> = {},
): Promise<void> {
  const vec = await embedding.embed(text);
  await vectors.putVector(scope, {
    key,
    vector: vec,
    metadata: { intent: text, sourceKind: 'user', ...metadata },
  });
}

describe('createSearchBlueprintsHandler', () => {
  it('returns the handler shape with name + schemas', () => {
    const deps = makeDeps();
    const handler = createSearchBlueprintsHandler(deps);
    expect(handler.name).toBe('ggui_search_blueprints');
    expect(handler.inputSchema).toBeDefined();
    expect(handler.outputSchema).toBeDefined();
    expect(typeof handler.handler).toBe('function');
  });

  it('returns empty results when the index is empty', async () => {
    const deps = makeDeps();
    const handler = createSearchBlueprintsHandler(deps);
    const result = await handler.handler({ query: 'weather' }, ctx);
    expect(result.query).toBe('weather');
    expect(result.total).toBe(0);
    expect(result.results).toEqual([]);
  });

  it('returns matches that clear the MIN_SIMILARITY_SCORE threshold', async () => {
    const { embedding, vectors } = makeDeps();
    // Seed two blueprints — one close to the query text, one orthogonal.
    await seed(embedding, vectors, 'app-a', 'bp_weather', 'weather card', {
      sourceKind: 'llm',
      sourceGenerator: 'ui-gen-default-haiku-4-5',
      sourceModel: 'claude-haiku-4-5',
    });
    await seed(embedding, vectors, 'app-a', 'bp_kanban', 'kanban board');
    const handler = createSearchBlueprintsHandler({ embedding, vectors });
    const result = await handler.handler({ query: 'weather card' }, ctx);
    expect(result.total).toBeGreaterThan(0);
    // Every returned score clears the threshold.
    for (const r of result.results) {
      expect(r.score).toBeGreaterThanOrEqual(MIN_SIMILARITY_SCORE);
    }
    // Intent prose surfaces as the description; category is the
    // provenance discriminant.
    const weatherHit = result.results.find((r) => r.id === 'c_bp_weather');
    expect(weatherHit).toBeDefined();
    expect(weatherHit?.description).toBe('weather card');
    expect(weatherHit?.category).toBe('llm');
  });

  it('maps blueprint ids to c_*/Cached_ naming', async () => {
    const { embedding, vectors } = makeDeps();
    await seed(embedding, vectors, 'app-a', 'abc123def', 'weather');
    const handler = createSearchBlueprintsHandler({ embedding, vectors });
    const result = await handler.handler({ query: 'weather' }, ctx);
    const hit = result.results[0];
    expect(hit?.id).toBe('c_abc123def');
    expect(hit?.name?.startsWith('Cached_')).toBe(true);
  });

  it('scopes queries to the caller appId — cross-tenant data does not leak', async () => {
    const { embedding, vectors } = makeDeps();
    await seed(embedding, vectors, 'app-b', 'bp_secret', 'weather card');
    const handler = createSearchBlueprintsHandler({ embedding, vectors });
    const result = await handler.handler({ query: 'weather card' }, ctx);
    expect(result.total).toBe(0);
  });

  it('honors the limit input', async () => {
    const { embedding, vectors } = makeDeps();
    for (let i = 0; i < 8; i++) {
      await seed(embedding, vectors, 'app-a', `bp_${i}`, 'weather card');
    }
    const handler = createSearchBlueprintsHandler({ embedding, vectors });
    const result = await handler.handler({ query: 'weather card', limit: 3 }, ctx);
    expect(result.results.length).toBeLessThanOrEqual(3);
  });

  it('surfaces honest empties for fields registry rows do not carry', async () => {
    // Registry rows carry intent + provenance, not per-prop docs /
    // callback lists / a featured flag — the handler must not invent
    // them from metadata keys no writer ever stamps.
    const { embedding, vectors } = makeDeps();
    await seed(embedding, vectors, 'app-a', 'bp_rich', 'weather card');
    const handler = createSearchBlueprintsHandler({ embedding, vectors });
    const result = await handler.handler({ query: 'weather card' }, ctx);
    const hit = result.results[0];
    expect(hit?.props).toEqual([]);
    expect(hit?.callbacks).toEqual([]);
    expect(hit?.featured).toBe(false);
  });

  it('drops rows without valid provenance (legacy flat vocabulary / foreign vector families)', async () => {
    const { embedding, vectors } = makeDeps();
    // A legacy row carrying the retired flat `provenance` scalar and
    // no sourceKind — must not surface under a coerced label.
    const vec = await embedding.embed('weather card');
    await vectors.putVector('app-a', {
      key: 'bp_legacy',
      vector: vec,
      metadata: { intent: 'weather card', provenance: 'synth' },
    });
    const handler = createSearchBlueprintsHandler({ embedding, vectors });
    const result = await handler.handler({ query: 'weather card' }, ctx);
    expect(result.total).toBe(0);
  });

  it('rejects invalid input via zod', async () => {
    const deps = makeDeps();
    const handler = createSearchBlueprintsHandler(deps);
    await expect(handler.handler({ query: '' }, ctx)).rejects.toThrow();
    await expect(handler.handler({ query: 'ok', limit: 0 }, ctx)).rejects.toThrow();
    await expect(handler.handler({ query: 'ok', limit: 101 }, ctx)).rejects.toThrow();
  });

  it('rounds scores to three decimal places', async () => {
    const { embedding, vectors } = makeDeps();
    await seed(embedding, vectors, 'app-a', 'bp_x', 'weather');
    const handler = createSearchBlueprintsHandler({ embedding, vectors });
    const result = await handler.handler({ query: 'weather' }, ctx);
    const score = result.results[0]?.score;
    expect(score).toBeDefined();
    // 3-decimal rounding: multiplied by 1000, should be integer-ish.
    expect(Number.isFinite(score)).toBe(true);
    const times1000 = (score ?? 0) * 1000;
    expect(Math.abs(times1000 - Math.round(times1000))).toBeLessThan(1e-9);
  });
});

describe('createSearchBlueprintsHandler — manifest + semantic merge', () => {
  it('returns a manifest blueprint even when the semantic index is empty', async () => {
    // Load-bearing happy-path assertion. An OSS server that declared
    // a blueprint in ggui.json but has never run `ggui_render` yet has
    // an empty VectorStore — the only path that can surface the
    // manifest entry is the BlueprintProvider branch.
    const { embedding, vectors } = makeDeps();
    const blueprints = new ManifestBlueprintProvider({
      manifests: [
        {
          id: 'weather-card-fixture',
          name: 'Weather Card Fixture',
          description: 'A weather card declared via ggui.ui.json',
          category: 'data',
        },
      ],
    });
    const handler = createSearchBlueprintsHandler({ embedding, vectors, blueprints });
    const result = await handler.handler({ query: 'weather' }, ctx);
    expect(result.total).toBeGreaterThan(0);
    const hit = result.results.find((r) => r.id === 'weather-card-fixture');
    expect(hit).toBeDefined();
    expect(hit?.name).toBe('Weather Card Fixture');
    // Query "weather" is a substring of the name, not an exact match,
    // so the scoring tier pinned is the substring score.
    expect(hit?.score).toBe(MANIFEST_SUBSTRING_SCORE);
  });

  it('stamps the exact-name-match score when query equals the manifest name (case-insensitive)', async () => {
    const { embedding, vectors } = makeDeps();
    const blueprints = new ManifestBlueprintProvider({
      manifests: [
        {
          id: 'kanban-board',
          name: 'Kanban Board',
          description: 'Task tracking',
          category: 'layout',
        },
      ],
    });
    const handler = createSearchBlueprintsHandler({ embedding, vectors, blueprints });
    const result = await handler.handler({ query: 'kanban board' }, ctx);
    const hit = result.results.find((r) => r.id === 'kanban-board');
    expect(hit?.score).toBe(MANIFEST_EXACT_NAME_SCORE);
  });

  it('merges manifest + semantic matches in one result set ordered by score', async () => {
    // Mixed scope: one manifest blueprint + one semantic-only cache
    // entry. Both should appear; ordering by score has the manifest
    // exact-name match (1.0) ahead of whatever semantic score lands.
    const { embedding, vectors } = makeDeps();
    await seed(embedding, vectors, 'app-a', 'cached-blueprint-hash', 'weather card');
    const blueprints = new ManifestBlueprintProvider({
      manifests: [
        {
          id: 'weather-manifest',
          name: 'Weather',
          description: 'Manifest-declared weather UI',
          category: 'data',
        },
      ],
    });
    const handler = createSearchBlueprintsHandler({ embedding, vectors, blueprints });
    const result = await handler.handler({ query: 'weather' }, ctx);
    const ids = result.results.map((r) => r.id);
    expect(ids).toContain('weather-manifest');
    // Semantic entry id gets `c_` prefixed by the handler.
    expect(ids).toContain('c_cached-blueprint-hash');
    // Ordering: descending score. First row is the exact-name
    // manifest hit at 1.0, ahead of the semantic cosine score.
    const scores = result.results.map((r) => r.score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]!).toBeLessThanOrEqual(scores[i - 1]!);
    }
    expect(result.results[0]?.id).toBe('weather-manifest');
  });

  it('dedupes by id when the same blueprint exists in both sources (manifest wins on metadata)', async () => {
    // Pathological-but-possible: a cached generation was written with
    // the same id the manifest uses. The merged row must carry the
    // manifest's author-curated name/description, not the cached one.
    const { embedding, vectors } = makeDeps();
    await seed(embedding, vectors, 'app-a', 'shared-id', 'weather card');
    const blueprints = new ManifestBlueprintProvider({
      manifests: [
        {
          // Must match semantic's `c_` prefix shape so the merge step
          // sees the id collision. In practice this is still a
          // contrived fixture — OSS manifests use kebab-case ids, not
          // `c_*` hashes — but the merge invariant is what's under test.
          id: 'c_shared-id',
          name: 'Authoritative Weather Manifest',
          description: 'Weather — authoritative copy from the manifest',
        },
      ],
    });
    const handler = createSearchBlueprintsHandler({ embedding, vectors, blueprints });
    const result = await handler.handler({ query: 'weather' }, ctx);
    const hits = result.results.filter((r) => r.id === 'c_shared-id');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.name).toBe('Authoritative Weather Manifest');
    expect(hits[0]?.description).toBe(
      'Weather — authoritative copy from the manifest',
    );
  });

  it('honors the limit on the merged result set', async () => {
    const { embedding, vectors } = makeDeps();
    for (let i = 0; i < 4; i++) {
      await seed(embedding, vectors, 'app-a', `cached-${i}`, 'weather card');
    }
    const blueprints = new ManifestBlueprintProvider({
      manifests: Array.from({ length: 4 }, (_, i) => ({
        id: `manifest-${i}`,
        name: `Weather Manifest ${i}`,
        description: `weather variant ${i}`,
      })),
    });
    const handler = createSearchBlueprintsHandler({ embedding, vectors, blueprints });
    const result = await handler.handler({ query: 'weather', limit: 3 }, ctx);
    // 4+4 match both sources; limit trims to 3 even though total > 3.
    expect(result.results.length).toBeLessThanOrEqual(3);
    expect(result.total).toBeGreaterThan(3);
  });

  it('stays scoped to the caller appId on the semantic branch even when the manifest provider is global', async () => {
    // The manifest provider is process-scoped (one per `ggui serve`
    // process), but the VectorStore is appId-partitioned. A manifest
    // blueprint surfaces for any appId that hits this handler — that's
    // the intended shape (the manifest IS the app). The semantic
    // branch must still partition so cached-gen entries from a
    // different tenant don't leak in.
    const { embedding, vectors } = makeDeps();
    await seed(embedding, vectors, 'app-b', 'secret-cached', 'weather card');
    const blueprints = new ManifestBlueprintProvider({
      manifests: [
        {
          id: 'weather-local',
          name: 'Weather',
          description: 'Local manifest',
        },
      ],
    });
    const handler = createSearchBlueprintsHandler({ embedding, vectors, blueprints });
    const result = await handler.handler({ query: 'weather' }, ctx);
    expect(result.results.find((r) => r.id === 'weather-local')).toBeDefined();
    // Cross-tenant semantic entry must NOT leak into app-a's view.
    expect(result.results.find((r) => r.id === 'c_secret-cached')).toBeUndefined();
  });
});
