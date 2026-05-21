/**
 * RAG Search — embedding-similarity blueprint retrieval over the
 * public `@ggui-ai/mcp-server-core` storage seam.
 *
 * Given agent `prompt` + a tenant `scope` (typically appId, or the
 * literal `"shared"` for the global catalog), this helper:
 *
 *   1. Embeds the prompt via {@link EmbeddingProvider.embed}.
 *   2. Queries the {@link VectorStore} for the top-K nearest neighbors
 *      (server-side cosine, scope-partitioned — no cross-tenant leak).
 *   3. Filters by minimum score, biases private (per-app registered
 *      UIs) over shared (generated pool) at the same score band, and
 *      projects each hit into a {@link NegotiatorOption}.
 *
 * Two pipeline paths emerge from the confidence band:
 *   - **High confidence** (`score >= HIGH_CONFIDENCE_THRESHOLD`): the
 *     hit is marked `exact`. Upstream callers (V3 `negotiate()`) can
 *     short-circuit the decision LLM entirely.
 *   - **Medium confidence** (`score >= RETRIEVAL_MIN_SCORE` and below
 *     the exact threshold): marked `partial`. Upstream passes these to
 *     the decision LLM as candidates.
 *
 * ### Public-seam contract
 *
 * This function reads only the public `VectorStore` surface (scalar
 * metadata). Consumers that still hold the rich `EmbeddingStorage`
 * shape bridge via
 * `@ggui-cloud/aws-adapters.embeddingStorageToVectorStore`, which
 * encodes array-valued fields (`props`, `callbacks`, `sourceTools`)
 * as JSON strings inside `metadata`. Any `VectorStore` implementation
 * that stores fresh writes through `writeRagVector` (see
 * `mcp-servers/ggui-protocol/src/adapters/vector-store.ts`) uses the
 * same encoding — so existing caches, fresh writes, and community
 * `VectorStore` backends all collide on the same retrieval key.
 *
 * ### Scope
 *
 * No AWS bindings, no LLM dependency. Pure composition over the two
 * public seams. The one-LLM-call `makeDecision()` step is separate.
 */

import type {
  EmbeddingProvider,
  VectorSearchResult,
  VectorStore,
} from '@ggui-ai/mcp-server-core';
import type { DataContract, JsonValue } from '@ggui-ai/protocol';
import { inferJsonSchemaType } from './pure.js';
import type { NegotiatorOption } from './types.js';

/** RAG search result with per-stage timing. */
export interface RagSearchResult {
  options: NegotiatorOption[];
  embeddingLatencyMs: number;
  searchLatencyMs: number;
}

/** Dependencies — both public seams from `@ggui-ai/mcp-server-core`. */
export interface RagSearchDeps {
  embedding: EmbeddingProvider;
  vectors: VectorStore;
}

export interface RagSearchInput {
  /** Natural-language query text. Embedded as-is. */
  prompt: string;
  /**
   * Scope / tenant partition. Typically `appId` for per-app indexes
   * or the literal `"shared"` for the global catalog. Passed straight
   * through to `VectorStore.query`; the scope is the tenant boundary,
   * so a query never crosses into another tenant's index.
   */
  scope: string;
  /** Override the k-NN cut-off (default 10). */
  maxCandidates?: number;
}

/** Minimum cosine similarity to be considered a retrieval candidate. */
const RETRIEVAL_MIN_SCORE = 0.15;

/** Cosine similarity above this → exact match (skip LLM). */
const HIGH_CONFIDENCE_THRESHOLD = 0.45;

/** Default top-K for the k-NN query. */
const DEFAULT_MAX_CANDIDATES = 10;

/**
 * Search the vector index for blueprints matching `prompt` within
 * `scope`. See the module docstring for the confidence-band pipeline
 * and encoding contract.
 */
export async function ragSearch(
  deps: RagSearchDeps,
  input: RagSearchInput,
): Promise<RagSearchResult> {
  const topK = input.maxCandidates ?? DEFAULT_MAX_CANDIDATES;

  // Stage 1: embed the query text
  const embedStart = Date.now();
  const queryEmbedding = await deps.embedding.embed(input.prompt);
  const embeddingLatencyMs = Date.now() - embedStart;

  // Stage 2: nearest-neighbor query
  const searchStart = Date.now();
  const results = await deps.vectors.query(input.scope, queryEmbedding, topK);
  const searchLatencyMs = Date.now() - searchStart;

  // Filter + sort: private (registered UIs) always beats shared (generated)
  // at the same score level; then descending score.
  const candidates = results
    .filter((r) => r.score >= RETRIEVAL_MIN_SCORE)
    .sort((a, b) => {
      const aPrivate = readPoolSource(a.metadata) === 'private' ? 1 : 0;
      const bPrivate = readPoolSource(b.metadata) === 'private' ? 1 : 0;
      if (aPrivate !== bPrivate) return bPrivate - aPrivate;
      return b.score - a.score;
    });

  if (candidates.length === 0) {
    return { options: [], embeddingLatencyMs, searchLatencyMs };
  }

  const seenContracts = new Set<string>();
  const options: NegotiatorOption[] = [];

  for (const match of candidates) {
    const option = buildOption(match);
    if (!option) continue;
    if (seenContracts.has(option.contractKey)) continue;
    seenContracts.add(option.contractKey);
    options.push(option.value);
  }

  return { options, embeddingLatencyMs, searchLatencyMs };
}

/**
 * Project a public {@link VectorSearchResult} hit into a
 * {@link NegotiatorOption}, together with the dedup key used to
 * collapse hits that describe the same semantic contract.
 */
function buildOption(
  match: VectorSearchResult,
): { value: NegotiatorOption; contractKey: string } | undefined {
  const isExact = match.score >= HIGH_CONFIDENCE_THRESHOLD;
  const verdict = isExact ? 'exact' : 'partial';

  const blueprintHash = match.key;
  // Registered (private) blueprints already carry a `p_` prefix in
  // their hash; generated pool entries do not — prefix them as `c_`
  // to match the legacy option ID format that downstream consumers
  // (decision prompt, cache layer) have been reading since V2.
  const blueprintId = blueprintHash.startsWith('p_')
    ? blueprintHash
    : `c_${blueprintHash}`;

  const prompt = readString(match.metadata.prompt, '');
  const intent = readString(match.metadata.intent, '');
  const category = readString(match.metadata.category, '');
  const contractHash = readString(match.metadata.contractHash, '');
  const poolSource = readPoolSource(match.metadata);
  const featured = Boolean(match.metadata.featured);
  const props = readProps(match.metadata.props);

  const contract = buildContract({ prompt, intent, category, props });

  // Dedup: prefer matching on semantic intent; fall back to prop
  // signature so two blueprints with identical intents but different
  // prop shapes don't collapse together.
  const contractKey =
    intent !== ''
      ? intent
      : JSON.stringify(Object.keys(contract.propsSpec?.properties ?? {}).sort());

  const option: NegotiatorOption = {
    id: `rag_${blueprintId.slice(-8)}`,
    type: 'blueprint',
    blueprintId,
    pattern: category,
    description: `${prompt} (similarity: ${Math.round(match.score * 100)}%, ${verdict})`,
    pros: [
      isExact
        ? 'Exact blueprint match — instant render'
        : 'Semantically matched to your request',
      ...(featured ? ['Featured blueprint — curated quality'] : []),
    ],
    cons: [
      ...(isExact ? [] : ['Partial match — may need adjustments']),
      ...(!isExact ? ['Fixed layout — limited customization'] : []),
    ],
    renderTime: 'instant',
    contract,
    ...(contractHash !== '' ? { contractHash } : {}),
    ...(poolSource !== undefined ? { poolSource } : {}),
  };

  return { value: option, contractKey };
}

/** Prop schema shape as encoded by `embeddingStorageToVectorStore`. */
interface PropSpec {
  name: string;
  type: string;
  required: boolean;
  description: string;
  example?: unknown;
}

function buildContract(args: {
  prompt: string;
  intent: string;
  category: string;
  props: PropSpec[];
}): DataContract {
  // `intent` is not a contract field. The `prompt` and `intent` fields
  // stay on the args because callers still use them for RAG keys +
  // dedup; the returned contract carries structural shape only.
  const { props } = args;
  return {
    propsSpec: {
      properties: Object.fromEntries(
        props.map((p) => [
          p.name,
          {
            description: p.description,
            schema: { type: inferJsonSchemaType(p.type) },
            required: p.required,
            ...(p.example !== undefined
              ? { example: p.example as JsonValue }
              : {}),
          },
        ]),
      ),
    },
  };
}

function readString(
  value: string | number | boolean | null | undefined,
  fallback: string,
): string {
  return typeof value === 'string' ? value : fallback;
}

function readPoolSource(
  metadata: Record<string, string | number | boolean | null>,
): 'shared' | 'private' | undefined {
  const v = metadata.poolSource;
  return v === 'shared' || v === 'private' ? v : undefined;
}

function readProps(
  value: string | number | boolean | null | undefined,
): PropSpec[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPropSpec);
  } catch {
    return [];
  }
}

function isPropSpec(value: unknown): value is PropSpec {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === 'string' &&
    typeof v.type === 'string' &&
    typeof v.required === 'boolean' &&
    typeof v.description === 'string'
  );
}
