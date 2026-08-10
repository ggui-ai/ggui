/**
 * ggui_search_blueprints — search across every discoverable blueprint
 * on this server.
 *
 * Up to three sources are consulted in parallel, then merged +
 * de-duplicated by id:
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
 *      pair. Covers prior `ggui_render` cache entries + any other
 *      producer that has written into the scope. Continues to honor
 *      `MIN_SIMILARITY_SCORE`.
 *
 *   3. **Registry source** (optional, opt-in via deps.registry) —
 *      bounded public /search call for published blueprint
 *      candidates; appended after local hits, degrades typed on
 *      failure.
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
import {
  bundleHostScheme,
  DEFAULT_BUNDLE_HOST,
  flatToBlueprintSource,
  searchBlueprintsInputShape,
  type GguiSearchBlueprintsOutput,
} from '@ggui-ai/protocol';
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

/**
 * Default budget for the registry `/search` round-trip. The registry
 * source is advisory — a slow registry must never stall the local
 * sources past this bound. Operator-overridable per-deps.
 */
export const DEFAULT_REGISTRY_SEARCH_TIMEOUT_MS = 3000;

/**
 * Registry-backed discovery source configuration. Presence of this
 * object on `SearchBlueprintsDeps` ACTIVATES the source (opt-in —
 * a zero-config server never makes an outbound registry request).
 */
export interface SearchBlueprintsRegistrySource {
  /**
   * Registry host (`host[:port]`). Absent = `DEFAULT_BUNDLE_HOST`.
   * Scheme derives via `bundleHostScheme` — http for loopback,
   * https otherwise (the same resolution the gadget bundleHost
   * uses).
   */
  readonly host?: string;
  /** Fetch budget in ms. Default `DEFAULT_REGISTRY_SEARCH_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** Injectable fetch for tests. Defaults to the global fetch. */
  readonly fetch?: typeof fetch;
}

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
  /**
   * Optional registry discovery source. When bound, the handler
   * queries the registry's public `/search` for published blueprint
   * candidates and appends them after the local sources. Omitted =
   * no outbound registry traffic (the zero-config default).
   */
  readonly registry?: SearchBlueprintsRegistrySource;
}

// Canonical SSoT shape — authored once in `@ggui-ai/protocol`
// (`schemas/mcp.ts`).
const inputSchema = searchBlueprintsInputShape;

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
  degradedSources: z
    .array(
      z.object({
        source: z.literal('registry'),
        reason: z.enum(['unreachable', 'timeout', 'invalid_response']),
      }),
    )
    .optional(),
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
      "Search this app's blueprints — manifest-declared UIs (ggui.json#blueprints.include), previously cached generations, and, when a registry is configured, published blueprint candidates from the artifact registry. Local sources match by name/description and cosine similarity; registry candidates are advisory matches appended after local results, labeled origin 'registry'. Optional tool/server filters narrow registry candidates to artifacts declaring those MCP tool bindings. The agent can decide to reuse a match or generate from scratch; installing a registry candidate remains a human/operator act.",
    inputSchema,
    outputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<GguiSearchBlueprintsOutput> {
      const { query, limit = 10, tool, server } = z
        .object(inputSchema)
        .parse(rawInput);

      // Fan out all sources in parallel. The manifest source is a
      // pure metadata read (cheap); the semantic source is one
      // `embed` + one `query` round-trip; the registry source is a
      // bounded HTTP call that degrades typed instead of throwing.
      const [semantic, manifest, registry] = await Promise.all([
        searchSemantic(deps, ctx.appId, query, limit),
        searchManifest(deps.blueprints, query, limit),
        searchRegistry(deps.registry, { query, tool, server, limit }, ctx.signal),
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

      // Registry candidates append AFTER the local sources (advisory
      // per the discovery design §3) and never displace a local id.
      const registryHits = registry.hits.filter((hit) => !byId.has(hit.id));

      return {
        results: [...trimmed, ...registryHits],
        total: merged.length + registryHits.length,
        query,
        ...(registry.degraded ? { degradedSources: [registry.degraded] } : {}),
      };
    },
  };
}

/**
 * Semantic-source branch: embed + single `VectorStore.query`. Preserves
 * the pre-merge behavior — same threshold, same id-shape translation,
 * same score-rounding. A manifest-only OSS boot with an empty vector
 * store returns `[]` here and all visible hits come from the manifest
 * branch.
 *
 * Rows are blueprint-registry rows (`blueprintToMetadata` layout):
 * `description` reads the stored `intent`, and `category` surfaces the
 * provenance discriminant (`llm` / `user` / `curated`). Rows without
 * valid provenance — legacy flat-vocabulary rows, foreign vector
 * families sharing the scope — are dropped at this trust boundary,
 * never surfaced with coerced labels.
 */
async function searchSemantic(
  deps: SearchBlueprintsDeps,
  scope: string,
  query: string,
  limit: number,
): Promise<MergedHit[]> {
  // An unavailable embedding provider (e.g. the local model failed its
  // native load) must degrade to "no semantic hits", never fail the
  // whole merged search — the manifest branch is embedding-independent
  // by contract and its hits must survive. This branch races the
  // manifest branch in a Promise.all, so a rejection here would
  // otherwise discard the manifest's correct results (bit us 2026-08-04
  // when a dual-sharp libvips collision broke the local embedder in CI).
  let vector: number[];
  try {
    vector = await deps.embedding.embed(query);
  } catch {
    return [];
  }
  const raw = await deps.vectors.query(scope, vector, limit);
  const hits: MergedHit[] = [];
  for (const r of raw) {
    if (r.score < MIN_SIMILARITY_SCORE) continue;
    const source = flatToBlueprintSource(r.metadata);
    if (source === null) continue;
    const key = r.key;
    hits.push({
      id: `c_${key}`,
      name: `Cached_${key.substring(0, 8)}`,
      description: asString(r.metadata.intent),
      category: source.kind,
      // Registry rows don't carry per-prop docs / callback lists /
      // a featured flag — surface honest empties rather than parse
      // keys no writer ever stamps.
      props: [],
      callbacks: [],
      featured: false,
      relevance: 'match' as const,
      score: Math.round(r.score * 1000) / 1000,
    });
  }
  return hits;
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

type DegradedSource = NonNullable<GguiSearchBlueprintsOutput['degradedSources']>[number];

interface RegistrySourceResult {
  readonly hits: MergedHit[];
  readonly degraded?: DegradedSource;
}

/**
 * Wire subset of the registry `GET /search` response this handler
 * consumes. Local on purpose: this package does not depend on the
 * registry server implementation, and zod's default strip semantics
 * keep the guard forward-compatible with response additions.
 */
const registrySearchEntrySchema = z.object({
  artifactId: z.string().min(1),
  latestVersion: z.string().min(1),
  kind: z.string(),
  description: z.string().optional(),
  mcpTools: z.array(z.object({ server: z.string().optional(), tool: z.string() })).optional(),
  scopeVerification: z.enum(['verified', 'unverified']).optional(),
});

const registrySearchResponseSchema = z.object({
  results: z.array(registrySearchEntrySchema),
});

/**
 * Registry-source branch: bounded public `/search` call. Inactive
 * (empty hits, no degradation) when no registry source is
 * configured. Never throws — every failure mode maps onto the typed
 * `degraded` indication so the merged tool result always succeeds.
 */
async function searchRegistry(
  registry: SearchBlueprintsRegistrySource | undefined,
  filters: {
    readonly query: string;
    readonly tool: string | undefined;
    readonly server: string | undefined;
    readonly limit: number;
  },
  signal: AbortSignal | undefined,
): Promise<RegistrySourceResult> {
  if (!registry) return { hits: [] };

  // Operator-override-then-default host resolution — the same
  // precedence + scheme rule as gadget bundleHost (`DEFAULT_BUNDLE_HOST`
  // + `bundleHostScheme` from `@ggui-ai/protocol`).
  const host =
    typeof registry.host === 'string' && registry.host.length > 0
      ? registry.host
      : DEFAULT_BUNDLE_HOST;
  const params = new URLSearchParams();
  params.set('q', filters.query);
  // This tool's kind scope is blueprints; gadget discovery is served
  // by the registry HTTP surface directly.
  params.set('kind', 'blueprint');
  if (filters.tool !== undefined) params.set('tool', filters.tool);
  if (filters.server !== undefined) params.set('server', filters.server);
  params.set('limit', String(filters.limit));
  const url = `${bundleHostScheme(host)}://${host}/search?${params.toString()}`;

  const timeoutMs = registry.timeoutMs ?? DEFAULT_REGISTRY_SEARCH_TIMEOUT_MS;
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  const fetchImpl = registry.fetch ?? fetch;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.any(signals),
    });
  } catch (err) {
    const reason: DegradedSource['reason'] =
      err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'unreachable';
    return { hits: [], degraded: { source: 'registry', reason } };
  }
  if (!res.ok) {
    // Undici doesn't return the socket to the pool until the body is
    // consumed or canceled. We never read this body (non-2xx), so
    // cancel it explicitly — a rejecting cancel() must still surface
    // the already-typed degradation, not throw past this branch.
    try {
      await res.body?.cancel();
    } catch {
      // Deliberately swallowed — see comment above.
    }
    return {
      hits: [],
      degraded: { source: 'registry', reason: 'invalid_response' },
    };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return {
      hits: [],
      degraded: { source: 'registry', reason: 'invalid_response' },
    };
  }
  const parsed = registrySearchResponseSchema.safeParse(body);
  if (!parsed.success) {
    return {
      hits: [],
      degraded: { source: 'registry', reason: 'invalid_response' },
    };
  }
  return { hits: parsed.data.results.map(toRegistryHit) };
}

function toRegistryHit(entry: z.infer<typeof registrySearchEntrySchema>): MergedHit {
  return {
    id: `${entry.artifactId}@${entry.latestVersion}`,
    name: entry.artifactId,
    description: entry.description ?? '',
    category: entry.kind,
    // Registry search rows carry no contract details — honest empties.
    props: [],
    callbacks: [],
    featured: false,
    relevance: 'match' as const,
    // The registry source computes no similarity. Entries always
    // append AFTER the score-sorted local sources, so this value
    // carries no ranking weight; 0 is the honest "not measured".
    score: 0,
    origin: 'registry' as const,
    artifactId: entry.artifactId,
    version: entry.latestVersion,
    ...(entry.mcpTools ? { mcpTools: entry.mcpTools } : {}),
    ...(entry.scopeVerification ? { scopeVerification: entry.scopeVerification } : {}),
  };
}
