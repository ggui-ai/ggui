/**
 * ggui_search_blueprints — search across every discoverable blueprint
 * on this server.
 *
 * Two sources are consulted in parallel, then merged + de-duplicated
 * by id:
 *
 *   1. **Manifest source** (optional `BlueprintProvider`) — authored
 *      UIs declared in `ggui.json#blueprints.include`. Matched by
 *      substring against name + description (the same shape
 *      `BlueprintProvider.list({query})` honors). Scores are
 *      deterministic: 1.0 for an exact (case-insensitive) name hit,
 *      0.7 otherwise. No embeddings needed — the manifest has its
 *      own human-authored text so semantic matching has nothing to
 *      add for this source.
 *
 *   2. **Semantic source** — the `VectorStore` / `EmbeddingProvider`
 *      pair. Covers prior `ggui_push` cache entries + any other
 *      producer that has written into the scope. Continues to honor
 *      `MIN_SIMILARITY_SCORE`.
 *
 * When both sources return the same id (a manifest blueprint that
 * also has a cached generation), the manifest entry wins — its
 * metadata is the source of truth and its name/description don't
 * depend on whether a cache entry happens to exist. Score is the
 * max of the two so a lexical OR semantic hit keeps the entry in
 * the top band.
 *
 * The merge stays under the `limit` request by taking the top-N
 * after sort. `total` reflects pre-trim matches.
 *
 * ## Why merge vs. a dedicated tool
 *
 * Agents do not know (and should not care) whether a blueprint came
 * from the authored manifest or from a cached generation. They ask
 * "is there something that already fits?". One tool with one merged
 * result gives them that answer; two tools force the agent to make
 * the split the server already knows how to make.
 *
 * Pure over `@ggui-ai/mcp-server-core`'s seams. No AWS imports. No
 * config loading. The hosted server's logger wrapper decorates this
 * when composing.
 */
import { z } from 'zod';
import type {
  BlueprintEntry,
  BlueprintProvider,
  EmbeddingProvider,
  VectorStore,
} from '@ggui-ai/mcp-server-core';
import type { GguiSearchBlueprintsOutput } from '@ggui-ai/protocol';
import type { HandlerContext, SharedHandler } from '../types.js';

/**
 * Matches the hosted `MIN_SIMILARITY_SCORE`. Below this is noise —
 * callers that want stricter matching post-filter by `score`.
 */
export const MIN_SIMILARITY_SCORE = 0.3;

/**
 * Score stamped on a manifest hit whose name (case-insensitive)
 * equals the query exactly. Deterministic — the manifest source
 * doesn't have an embedding to measure against.
 */
export const MANIFEST_EXACT_NAME_SCORE = 1.0;

/**
 * Score stamped on a manifest hit whose name or description
 * contains the query as a substring but does not exactly match.
 * Deliberately above `MIN_SIMILARITY_SCORE` so a substring match
 * always survives the threshold filter and below
 * `MANIFEST_EXACT_NAME_SCORE` so a lexical tie breaks toward the
 * stronger signal.
 */
export const MANIFEST_SUBSTRING_SCORE = 0.7;

export interface SearchBlueprintsDeps {
  readonly embedding: EmbeddingProvider;
  readonly vectors: VectorStore;
  /**
   * Optional manifest catalog source. When bound, manifest-declared
   * blueprints (ggui.json#blueprints.include → ggui.ui.json) are
   * included in the search results alongside the semantic
   * `VectorStore` matches.
   *
   * Omitted = semantic-only behavior (the pre-merge default). The
   * hosted server historically ran without a manifest provider on
   * this handler; OSS `createGguiServer` constructs a
   * `ManifestBlueprintProvider` at boot and threads it through.
   */
  readonly blueprints?: BlueprintProvider;
}

const inputSchema = {
  query: z
    .string()
    .min(1)
    .describe("Natural-language description of the UI you're looking for"),
  limit: z.number().int().min(1).max(100).optional(),
};

const outputSchema = {
  // `z.record(z.string(), z.unknown())` — zod v4 dropped the single-arg
  // form `z.record(z.unknown())` that implicitly defaulted the key type
  // to `z.string()`. Keeping the explicit two-arg form so schema
  // construction works under both zod v3 and v4 at runtime, which
  // matters for the OSS tarball where one package's resolved zod
  // major may differ from another's in the flattened node_modules tree.
  results: z.array(z.record(z.string(), z.unknown())),
  total: z.number().int().nonnegative(),
  query: z.string(),
};

/** One row on the merged result, before final serialization. */
type MergedHit = GguiSearchBlueprintsOutput['results'][number];

/**
 * Build a search-blueprints handler bound to concrete `embedding` +
 * `vectors` implementations (required) + an optional manifest
 * `BlueprintProvider`. Tests inject in-memory fakes from
 * `@ggui-ai/mcp-server-core/in-memory`; production hosts bind to
 * AWS Bedrock + S3 Vectors for the semantic source and a
 * `ManifestBlueprintProvider` for the manifest source.
 */
export function createSearchBlueprintsHandler(
  deps: SearchBlueprintsDeps,
): SharedHandler<typeof inputSchema, typeof outputSchema, GguiSearchBlueprintsOutput> {
  return {
    name: 'ggui_search_blueprints',
    title: 'Search blueprints',
    audience: ['agent'],
    description:
      "Search this app's blueprints — both manifest-declared UIs (ggui.json#blueprints.include) and any previously cached generations. Matches by name/description against the manifest source and by cosine similarity against the semantic vector index. Returns entries ordered by score (descending). The agent can decide to reuse a match or generate from scratch.",
    inputSchema,
    outputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<GguiSearchBlueprintsOutput> {
      const { query, limit = 10 } = z.object(inputSchema).parse(rawInput);

      // Fan out both sources in parallel. The manifest source is a
      // pure metadata read (cheap); the semantic source is one
      // `embed` + one `query` round-trip. Running them concurrently
      // keeps handler latency close to the slower of the two.
      const [semantic, manifest] = await Promise.all([
        searchSemantic(deps, ctx.appId, query, limit),
        searchManifest(deps.blueprints, query, limit),
      ]);

      // Merge + dedupe by id. Manifest entries win on collision —
      // their metadata is author-curated and cannot drift against a
      // cached-generation shape that happens to share the id. Score
      // is the max of both so a lexical OR semantic hit keeps the
      // entry visible.
      const byId = new Map<string, MergedHit>();
      for (const hit of semantic) byId.set(hit.id, hit);
      for (const hit of manifest) {
        const prior = byId.get(hit.id);
        byId.set(
          hit.id,
          prior ? { ...hit, score: Math.max(hit.score, prior.score) } : hit,
        );
      }

      const merged = Array.from(byId.values()).sort((a, b) => b.score - a.score);
      const trimmed = merged.slice(0, limit);
      return { results: trimmed, total: merged.length, query };
    },
  };
}

/**
 * Semantic-source branch: embed + single `VectorStore.query`. Preserves
 * the pre-merge behavior — same threshold, same id-shape translation,
 * same score-rounding. A manifest-only OSS boot with an empty vector
 * store returns `[]` here and all visible hits come from the manifest
 * branch.
 */
async function searchSemantic(
  deps: SearchBlueprintsDeps,
  scope: string,
  query: string,
  limit: number,
): Promise<MergedHit[]> {
  const vector = await deps.embedding.embed(query);
  const raw = await deps.vectors.query(scope, vector, limit);
  return raw
    .filter((r) => r.score >= MIN_SIMILARITY_SCORE)
    .map((r) => {
      const blueprintHash = r.key;
      const prompt = asString(r.metadata.prompt);
      const category = asString(r.metadata.category) || 'generated';
      const props = parseJsonArray<{
        name: string;
        type: string;
        required: boolean;
        description: string;
      }>(r.metadata.props);
      const callbacks = parseJsonArray<string>(r.metadata.callbacks);
      const featured = asBoolean(r.metadata.featured);
      return {
        id: blueprintHash.startsWith('p_') ? blueprintHash : `c_${blueprintHash}`,
        name: blueprintHash.startsWith('p_')
          ? `Predefined_${blueprintHash.substring(2)}`
          : `Cached_${blueprintHash.substring(0, 8)}`,
        description: prompt,
        category,
        props: props.map((p) => ({
          name: p.name,
          type: p.type,
          required: p.required,
          description: p.description,
        })),
        callbacks,
        featured,
        relevance: 'match' as const,
        score: Math.round(r.score * 1000) / 1000,
      };
    });
}

/**
 * Manifest-source branch: text-match against `BlueprintProvider.list`
 * using its existing `query` filter (the provider already matches
 * case-insensitively against name + description).
 *
 * Scoring: exact name match (case-insensitive) → 1.0; any other match
 * that survived the provider's filter → 0.7. The provider doesn't
 * expose a match-strength signal, so the two-tier heuristic is what
 * we have; both values sit above `MIN_SIMILARITY_SCORE` so a manifest
 * hit always surfaces.
 *
 * Returns `[]` on missing provider — the caller's merge treats an
 * empty array as "no manifest source wired" without branching.
 */
async function searchManifest(
  blueprints: BlueprintProvider | undefined,
  query: string,
  limit: number,
): Promise<MergedHit[]> {
  if (!blueprints) return [];
  const entries = await blueprints.list({ query, limit });
  const queryLower = query.toLowerCase();
  return entries.map((entry) => toManifestHit(entry, queryLower));
}

function toManifestHit(entry: BlueprintEntry, queryLower: string): MergedHit {
  const score =
    entry.name.toLowerCase() === queryLower
      ? MANIFEST_EXACT_NAME_SCORE
      : MANIFEST_SUBSTRING_SCORE;
  // `BlueprintEntry` carries optional `description`/`tags`; the
  // handler's return shape requires concrete arrays (not unions with
  // undefined). Manifest entries don't carry props / callbacks /
  // featured today — fill safe defaults that don't mislead the agent
  // (empty props, empty callbacks, featured=false unless the manifest
  // ever surfaces a featured flag).
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description ?? '',
    category: (entry.tags && entry.tags[0]) ?? 'manifest',
    props: [],
    callbacks: [],
    featured: false,
    relevance: 'match' as const,
    score: Math.round(score * 1000) / 1000,
  };
}

function asString(
  value: string | number | boolean | null | undefined,
): string {
  return typeof value === 'string' ? value : '';
}

function asBoolean(
  value: string | number | boolean | null | undefined,
): boolean {
  return Boolean(value);
}

function parseJsonArray<T>(
  value: string | number | boolean | null | undefined,
): T[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}
