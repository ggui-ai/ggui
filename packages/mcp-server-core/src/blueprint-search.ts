/**
 * `BlueprintSearch` — multi-axis blueprint discovery primitive.
 *
 * Sister of {@link BlueprintStore}: where the store is byte-exact
 * `(appId, contractHash)` lookup, search is "find me the blueprint
 * that best fits THIS intent + draft contract + variance" across the
 * entire `appId` namespace.
 *
 * Load-bearing consumer: the three-step handshake. Step 2 runs search
 * and validate in parallel, then routes the three-mode matrix
 * (`origin: cache | agent | synth`) on the search top-result score.
 *
 * Why search matters beyond exact lookup
 * --------------------------------------
 *
 * The store is byte-exact: same `contractHash` ⇒ match, otherwise
 * empty. That's a load-bearing limitation:
 *
 *   - Synth often proposes a **structurally-similar-but-byte-different**
 *     contract (different field order, slightly renamed action,
 *     different `streamSpec` wrapper). The hash diverges and
 *     exact-lookup returns empty — even though a perfect semantic
 *     match sits in the store.
 *   - The handshake's step-2 review needs to know "is there an existing
 *     blueprint, anywhere in this app, that would satisfy this
 *     intent?" That's a search problem, not a key-lookup problem.
 *
 * Scoring (v1)
 * ------------
 *
 * ```
 * score = w_hash      * exactHashMatch(contractHash)            // 1.0 or 0
 *       + w_embed     * cosineSimilarity(contractEmbedding)     // [0,1]
 *       + w_struct    * structuralFingerprint(actions, streams, props, ctx)
 *       + w_variance  * varianceOverlap(persona, aesthetic, context)
 *       + w_intent    * jaccard(intentKeywords, seedPrompt+persona tokens)
 *
 * final = (weighted sum) / (sum of weights)   // normalize to [0, 1]
 * ```
 *
 * Exact `contractHash` is a short-circuit: when a match exists on the
 * hash axis the implementation returns `score: 1.0` immediately
 * without consulting the other axes. Otherwise the multi-axis sum
 * decides.
 *
 * Embedding source: reuse the existing {@link EmbeddingProvider} seam
 * — embeddings are cached on the {@link Blueprint} row at write time
 * (see `Blueprint.contractEmbedding`); the search reads from the
 * cached vector. No re-embed at search time.
 *
 * Defaults are documented on {@link DEFAULT_BLUEPRINT_SEARCH_WEIGHTS}
 * + {@link DEFAULT_BLUEPRINT_SEARCH_THRESHOLD} + {@link DEFAULT_BLUEPRINT_SEARCH_TOP_K}.
 * Per-app overrides ride through `App.blueprintSearchConfig`.
 *
 * Reference implementations:
 *   - `InMemoryBlueprintSearch` (this package's `/in-memory` entry) —
 *     OSS single-tenant default + test fixtures. Brute-force linear
 *     scan + cosine. Acceptable up to ~10k blueprints per app.
 *   - `DynamoBlueprintSearch` (cloud subtree
 *     `cloud/ggui-protocol-pod/src/adapters/dynamo-blueprint-search.ts`)
 *     — DDB Query by `appId` partition → cosine in-process. ANN /
 *     pgvector escape hatch reserved for v2 once the row count
 *     justifies it.
 */
import type {
  Blueprint,
  BlueprintSearchWeights,
  DataContract,
  JsonObject,
} from '@ggui-ai/protocol';

/**
 * Per-call inputs to {@link BlueprintSearch.search}. Every field
 * except `appId` is optional — the implementation contributes zero on
 * any axis whose input is absent.
 */
export interface BlueprintSearchCriteria {
  /**
   * Tenancy scope. The search MUST NOT return blueprints whose
   * `appId !== this`. Cross-app leakage is a security boundary
   * violation; the conformance suite asserts isolation.
   */
  readonly appId: string;
  /**
   * Caller's draft contract. Drives both the embed axis (search
   * embeds this on the fly when the implementation wires an
   * {@link EmbeddingProvider}) and the structural-fingerprint axis.
   */
  readonly contract?: DataContract;
  /**
   * Caller's already-canonicalized contract hash. When provided AND
   * any blueprint in the candidate set matches it, the implementation
   * short-circuits to a single result with `score: 1.0`.
   */
  readonly contractHash?: string;
  /**
   * Free-form intent tokens. Compared via Jaccard against the union
   * of every blueprint's `variance.seedPrompt + variance.persona`
   * lowercased tokens. The caller is responsible for tokenization
   * (split on whitespace, lowercase, deduplicate).
   */
  readonly intentKeywords?: readonly string[];
  /**
   * Variance overlap signals. Each sub-field is compared to the
   * candidate's `variance` field of the same name.
   */
  readonly variance?: {
    readonly persona?: string;
    readonly aesthetic?: string;
    readonly context?: JsonObject;
  };
  /**
   * Filter on the {@link Blueprint.generator} slug. When set, the
   * implementation MUST exclude blueprints whose `generator !==
   * this` before scoring. Useful for ops paths that want to compare
   * within a single generator's variants only.
   */
  readonly generator?: string;
  /**
   * Maximum results to return. Defaults to
   * {@link DEFAULT_BLUEPRINT_SEARCH_TOP_K} when absent or non-positive.
   */
  readonly topK?: number;
}

/**
 * One row in the response from {@link BlueprintSearch.search}. Always
 * carries a normalized score in `[0, 1]` + a witness on which axes
 * contributed non-zero score so consumers can render a confidence
 * rationale.
 */
export interface BlueprintSearchResult {
  /** The matching blueprint row. Echoes through the store's read shape. */
  readonly blueprint: Blueprint;
  /**
   * Normalized score in `[0, 1]`. Computed as
   * `(weighted sum of axis scores) / (sum of weights)` so the score
   * is comparable across operator weight tunings.
   */
  readonly score: number;
  /**
   * Which axes contributed non-zero score. Order-insensitive set.
   * Possible values: `'contract-hash'`, `'contract-embed'`,
   * `'contract-shape'`, `'persona'`, `'aesthetic'`, `'context'`,
   * `'intent'`. The handshake handler echoes this on its telemetry
   * + the suggestion's `rationale` field.
   */
  readonly matchedOn: readonly string[];
}

/**
 * The discovery seam. Implementations MAY pre-filter by `generator`
 * before scoring; MUST scope to `appId`; MUST return at most `topK`
 * rows ordered by `score` descending.
 */
export interface BlueprintSearch {
  /**
   * Run a multi-axis search against the implementation's backing
   * blueprint catalog. Returns an empty array when the catalog has
   * no rows under the criteria's `appId` or every row scores `0`.
   *
   * Determinism: the implementation MUST be deterministic for
   * identical inputs (same store contents + same criteria ⇒ same
   * output). Ordering ties resolve via `createdAt desc` then
   * `blueprintId asc` — mirrors the BlueprintSelector ladder so
   * search + selector agree on which blueprint "wins" when scores
   * are equal.
   */
  search(criteria: BlueprintSearchCriteria): Promise<readonly BlueprintSearchResult[]>;
}

/**
 * Default per-axis weights when an operator hasn't tuned
 * `App.blueprintSearchConfig.weights`.
 *
 * Rationale:
 *   - `hash: 1.0` is the short-circuit lever — any non-zero weight
 *     triggers the `score: 1.0` exit when the hash axis hits.
 *   - `embed: 0.4` + `struct: 0.3` dominate because semantic +
 *     structural match is the strongest non-exact signal.
 *   - `variance: 0.2` keeps persona/aesthetic relevant without
 *     letting tag-stuffing dominate.
 *   - `intent: 0.1` is the lightest because intent keywords are
 *     noisy and the caller's tokenization quality varies.
 *
 * Sum of weights = 2.0; the normalization divisor keeps the final
 * `score` in `[0, 1]` regardless.
 */
export const DEFAULT_BLUEPRINT_SEARCH_WEIGHTS: BlueprintSearchWeights = Object.freeze({
  hash: 1.0,
  embed: 0.4,
  struct: 0.3,
  variance: 0.2,
  intent: 0.1,
});

/**
 * Default `origin: 'cache'` routing threshold for the three-step
 * handshake. Scores at or above this are "use the cached blueprint";
 * below this fall through to the validation gate.
 */
export const DEFAULT_BLUEPRINT_SEARCH_THRESHOLD = 0.85;

/** Default page size when criteria.topK is absent. */
export const DEFAULT_BLUEPRINT_SEARCH_TOP_K = 5;

/**
 * Structural fingerprint of a contract shape — the axis-aligned key
 * set comparison the {@link BlueprintSearch} struct axis uses.
 *
 * Exposed as a public type so cloud adapters can re-use the
 * fingerprint helper without duplicating the algorithm.
 */
export interface StructuralFingerprint {
  /** Sorted `actionSpec` keys. */
  readonly actionNames: readonly string[];
  /** Sorted `streamSpec` keys (channel names). */
  readonly streamChannels: readonly string[];
  /** Sorted `propsSpec.properties` keys. */
  readonly propsKeys: readonly string[];
  /** Sorted `contextSpec` keys (slot names). */
  readonly contextKeys: readonly string[];
  /** True iff the contract declares at least one agent capability. */
  readonly hasAgentCapabilities: boolean;
  /** True iff the contract declares at least one client capability library. */
  readonly hasClientCapabilities: boolean;
}

/**
 * Compute the structural fingerprint of a contract. Pure — no IO,
 * deterministic. Exposed so cloud adapters can call it on rows fetched
 * from DDB without round-tripping through `BlueprintSearch.search`.
 */
export function structuralFingerprint(
  contract: DataContract | undefined,
): StructuralFingerprint {
  if (!contract) {
    return Object.freeze({
      actionNames: Object.freeze([]),
      streamChannels: Object.freeze([]),
      propsKeys: Object.freeze([]),
      contextKeys: Object.freeze([]),
      hasAgentCapabilities: false,
      hasClientCapabilities: false,
    });
  }
  const propsProps = contract.propsSpec?.properties;
  const agentTools = contract.agentCapabilities?.tools;
  const gadgets = contract.clientCapabilities?.gadgets;
  return Object.freeze({
    actionNames: Object.freeze(Object.keys(contract.actionSpec ?? {}).sort()),
    streamChannels: Object.freeze(Object.keys(contract.streamSpec ?? {}).sort()),
    propsKeys: Object.freeze(Object.keys(propsProps ?? {}).sort()),
    contextKeys: Object.freeze(Object.keys(contract.contextSpec ?? {}).sort()),
    hasAgentCapabilities: !!agentTools && Object.keys(agentTools).length > 0,
    hasClientCapabilities: !!gadgets && Object.keys(gadgets).length > 0,
  });
}

/**
 * Jaccard similarity on two sorted (or any-order) string arrays.
 * Returns 0 when both are empty (no signal in either direction)
 * rather than NaN. Exposed for cross-adapter re-use.
 */
export function jaccardSimilarity(
  a: readonly string[],
  b: readonly string[],
): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const x of setA) {
    if (setB.has(x)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

/**
 * Pairwise key-set similarity. Same as {@link jaccardSimilarity} but
 * empty-vs-empty reads as `1` ("agreement on absence") rather than
 * `0` ("no signal"). Used inside {@link structuralSimilarity} so two
 * identical fingerprints — including identically-empty ones —
 * always score `1`, while standalone {@link jaccardSimilarity}
 * preserves its "no signal" semantics for the intent-axis read.
 */
function keySetSimilarity(
  a: readonly string[],
  b: readonly string[],
): number {
  if (a.length === 0 && b.length === 0) return 1;
  return jaccardSimilarity(a, b);
}

/**
 * Pairwise structural fingerprint similarity. Averages key-set
 * similarity across the four sorted-key axes + exact-match on the
 * two boolean flags. Range `[0, 1]`. Two identical fingerprints —
 * including two empty ones — score `1` because empty-vs-empty on a
 * structural axis is "agreement on shape", not "no signal".
 */
export function structuralSimilarity(
  a: StructuralFingerprint,
  b: StructuralFingerprint,
): number {
  const subs = [
    keySetSimilarity(a.actionNames, b.actionNames),
    keySetSimilarity(a.streamChannels, b.streamChannels),
    keySetSimilarity(a.propsKeys, b.propsKeys),
    keySetSimilarity(a.contextKeys, b.contextKeys),
    a.hasAgentCapabilities === b.hasAgentCapabilities ? 1 : 0,
    a.hasClientCapabilities === b.hasClientCapabilities ? 1 : 0,
  ];
  let sum = 0;
  for (const s of subs) sum += s;
  return sum / subs.length;
}

/**
 * Cosine similarity on two equal-length vectors. Returns 0 when the
 * vectors differ in length (dimension mismatch ⇒ different basis;
 * comparing across providers is a category error). Returns 0 when
 * either side has zero magnitude. Output clamped to `[0, 1]` —
 * negative cosine reads as 0 since blueprints aren't "anti-similar"
 * in the search-axis sense.
 */
export function cosineSimilarity(
  a: readonly number[] | undefined,
  b: readonly number[] | undefined,
): number {
  if (!a || !b) return 0;
  if (a.length !== b.length) return 0;
  if (a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    magA += ai * ai;
    magB += bi * bi;
  }
  if (magA === 0 || magB === 0) return 0;
  const sim = dot / (Math.sqrt(magA) * Math.sqrt(magB));
  if (!Number.isFinite(sim)) return 0;
  if (sim < 0) return 0;
  if (sim > 1) return 1;
  return sim;
}

/**
 * Variance overlap — averages persona equality, aesthetic equality,
 * and context-key Jaccard. Each sub-score is `0` when either side is
 * absent on that field. Output in `[0, 1]`.
 *
 * Note: `aesthetic` is NOT a {@link BlueprintVariance} field today,
 * so the candidate side is always `undefined` and the aesthetic axis
 * always reads `0`. The implementation tolerates this asymmetry —
 * operators can pre-tag variants via `variance.context.aesthetic` and
 * read it back via the context-key Jaccard.
 */
export function varianceOverlap(
  query: BlueprintSearchCriteria['variance'] | undefined,
  candidate: Blueprint['variance'],
): number {
  const personaScore =
    query?.persona && candidate.persona && query.persona === candidate.persona
      ? 1
      : 0;
  // `aesthetic` isn't a first-class candidate field yet — see docstring.
  // The candidate side is always undefined, so this axis always reads 0.
  const aestheticScore = 0;
  const queryCtxKeys = Object.keys(query?.context ?? {}).sort();
  const candidateCtxKeys = Object.keys(candidate.context ?? {}).sort();
  const contextScore = jaccardSimilarity(queryCtxKeys, candidateCtxKeys);
  return (personaScore + aestheticScore + contextScore) / 3;
}

/**
 * Tokenize a free-form string into lowercase Jaccard tokens. Splits
 * on non-alphanumeric runs; deduplicates. Returns an empty array on
 * `undefined`/empty input.
 */
export function tokenizeForIntent(input: string | undefined): readonly string[] {
  if (!input) return [];
  const seen = new Set<string>();
  for (const tok of input.toLowerCase().split(/[^a-z0-9]+/)) {
    if (tok) seen.add(tok);
  }
  return Array.from(seen);
}
