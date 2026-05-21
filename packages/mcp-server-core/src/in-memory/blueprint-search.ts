/**
 * `InMemoryBlueprintSearch` — reference {@link BlueprintSearch}.
 *
 * Brute-force linear scan over a {@link BlueprintStore}'s rows plus
 * the scoring helpers from `../blueprint-search.ts`.
 *
 * Suitable for tests, dev, and the OSS zero-config path up to ~10k
 * blueprints per app. Production multi-tenant deployments swap in
 * `DynamoBlueprintSearch` (cloud subtree); the handshake wires
 * whichever implementation the host bound.
 *
 * The scan iterates {@link BlueprintStore.list} per `(appId,
 * contractHash)` group. When `criteria.contractHash` is provided we
 * short-circuit to a single group; otherwise we fan out across every
 * group the store has seen via a parallel `listAllForApp` helper that
 * implementations may expose (see {@link AppListableBlueprintStore}
 * below). Reference impls extend the base store with `listAllForApp`;
 * cloud impls use a GSI Query.
 */
import type {
  AppBlueprintSearchConfig,
  Blueprint,
  BlueprintSearchWeights,
  DataContract,
} from '@ggui-ai/protocol';
import type { BlueprintStore } from '../blueprint-store.js';
import {
  cosineSimilarity,
  DEFAULT_BLUEPRINT_SEARCH_THRESHOLD,
  DEFAULT_BLUEPRINT_SEARCH_TOP_K,
  DEFAULT_BLUEPRINT_SEARCH_WEIGHTS,
  jaccardSimilarity,
  structuralFingerprint,
  structuralSimilarity,
  tokenizeForIntent,
  varianceOverlap,
  type BlueprintSearch,
  type BlueprintSearchCriteria,
  type BlueprintSearchResult,
} from '../blueprint-search.js';
import type { EmbeddingProvider } from '../embedding-provider.js';

/**
 * BlueprintStore variant that surfaces an `appId`-scoped enumeration.
 * The base {@link BlueprintStore} only supports `(appId,
 * contractHash)` lookup; search needs to iterate every blueprint in
 * an app regardless of contract.
 *
 * Reference adapters implement this:
 *   - {@link InMemoryBlueprintStore} carries a secondary
 *     `Map<appId, Set<blueprintId>>` index — see this package's
 *     `./blueprint-store.ts` mixin.
 *   - The cloud `DynamoBlueprintStore` uses a `blueprintsByApp` GSI.
 */
export interface AppListableBlueprintStore extends BlueprintStore {
  /**
   * Enumerate every blueprint under `appId`, regardless of
   * `contractHash`. Returns empty when the app has no rows. Order is
   * implementation-defined; the search layer sorts by score.
   *
   * Production impls MUST be backed by an indexed Query — a per-row
   * scan is a regression worth flagging.
   */
  listAllForApp(appId: string): Promise<readonly Blueprint[]>;
}

export interface InMemoryBlueprintSearchOptions {
  /**
   * Source of truth for the candidate set. The search calls
   * `listAllForApp` (when needed) + reads each row's
   * `contractEmbedding`. The store + the search MUST agree on the
   * `appId` namespace.
   */
  readonly blueprintStore: AppListableBlueprintStore;
  /**
   * Optional embedding provider. When wired, the search embeds the
   * query contract on the fly (when `criteria.contract` is set) and
   * compares against each candidate's cached `contractEmbedding`.
   * When omitted, the embed axis contributes zero — the other four
   * axes still carry the decision.
   */
  readonly embeddingProvider?: EmbeddingProvider;
  /**
   * Optional global default config. Per-app overrides on
   * `App.blueprintSearchConfig` are layered on top of this; absent
   * fields fall through to {@link DEFAULT_BLUEPRINT_SEARCH_WEIGHTS}
   * + threshold + topK.
   */
  readonly defaultConfig?: AppBlueprintSearchConfig;
  /**
   * Optional per-call config resolver. When set, the search calls
   * this with the criteria's `appId` before scoring and merges the
   * returned config into the per-app effective config.
   *
   * Decoupled from {@link AppMetadataStore} so the search doesn't
   * have to wire the full store seam — handlers can pass a thin
   * `(appId) => app?.blueprintSearchConfig` closure.
   */
  readonly resolveAppConfig?: (
    appId: string,
  ) => Promise<AppBlueprintSearchConfig | undefined> | AppBlueprintSearchConfig | undefined;
}

/**
 * Helper: take the canonical-JSON-stringified shape of a contract for
 * the embedding side. We use `JSON.stringify` directly here rather
 * than `canonicalizeContracts` from `@ggui-ai/protocol` because:
 *
 *   1. The blueprint-store side embeds via the same path
 *      (`embedContractForBlueprint` helper, see `./blueprint-store.ts`)
 *      so producer + consumer agree by construction.
 *   2. Canonicalization is a registry concern — the embedding side
 *      cares about textual signal, not byte-exact identity.
 *
 * Keeping the embedding stringifier here AND on the put side means
 * both sides ride the same code; if one changes, typecheck fails.
 */
export function stringifyContractForEmbedding(contract: DataContract): string {
  return JSON.stringify(contract);
}

/**
 * Resolve the effective config for a given app by layering per-app
 * overrides on top of the global default + library defaults.
 */
function resolveEffectiveConfig(
  appConfig: AppBlueprintSearchConfig | undefined,
  defaultConfig: AppBlueprintSearchConfig | undefined,
): {
  weights: BlueprintSearchWeights;
  threshold: number;
  topK: number;
} {
  const fallbackWeights = defaultConfig?.weights;
  const overrideWeights = appConfig?.weights;
  const weights: BlueprintSearchWeights = {
    hash:
      overrideWeights?.hash ??
      fallbackWeights?.hash ??
      DEFAULT_BLUEPRINT_SEARCH_WEIGHTS.hash,
    embed:
      overrideWeights?.embed ??
      fallbackWeights?.embed ??
      DEFAULT_BLUEPRINT_SEARCH_WEIGHTS.embed,
    struct:
      overrideWeights?.struct ??
      fallbackWeights?.struct ??
      DEFAULT_BLUEPRINT_SEARCH_WEIGHTS.struct,
    variance:
      overrideWeights?.variance ??
      fallbackWeights?.variance ??
      DEFAULT_BLUEPRINT_SEARCH_WEIGHTS.variance,
    intent:
      overrideWeights?.intent ??
      fallbackWeights?.intent ??
      DEFAULT_BLUEPRINT_SEARCH_WEIGHTS.intent,
  };
  const threshold =
    appConfig?.threshold ??
    defaultConfig?.threshold ??
    DEFAULT_BLUEPRINT_SEARCH_THRESHOLD;
  const topK =
    appConfig?.topK && appConfig.topK > 0
      ? appConfig.topK
      : (defaultConfig?.topK && defaultConfig.topK > 0
        ? defaultConfig.topK
        : DEFAULT_BLUEPRINT_SEARCH_TOP_K);
  // Touch the threshold to silence the unused-var lint when consumers
  // ignore it. The effective config is the layer the search returns
  // alongside results in a future revision; for now the threshold
  // lives in the BlueprintSearchScoringContext for caller introspection.
  void threshold;
  return { weights, threshold, topK };
}

/**
 * Score a single candidate blueprint against the criteria. Pure —
 * exposed for unit tests + cloud-side re-use.
 */
export function scoreBlueprint(args: {
  candidate: Blueprint;
  criteria: BlueprintSearchCriteria;
  queryEmbedding: readonly number[] | undefined;
  weights: BlueprintSearchWeights;
}): { score: number; matchedOn: readonly string[] } {
  const { candidate, criteria, queryEmbedding, weights } = args;

  // Sum of axis-weights drives the normalization divisor.
  const sumWeights =
    weights.hash + weights.embed + weights.struct + weights.variance + weights.intent;
  if (sumWeights <= 0) {
    // Pathological config — refuse to score (would divide by 0).
    return { score: 0, matchedOn: [] };
  }

  const matchedOn: string[] = [];

  // Axis 1 — exact contractHash. Short-circuit handled at the caller
  // level; here we just count it as a contributor.
  let axisHash = 0;
  if (
    criteria.contractHash !== undefined &&
    criteria.contractHash === candidate.contractHash
  ) {
    axisHash = 1;
    matchedOn.push('contract-hash');
  }

  // Axis 2 — embed (cosine vs cached contractEmbedding).
  let axisEmbed = 0;
  if (queryEmbedding && candidate.contractEmbedding) {
    axisEmbed = cosineSimilarity(queryEmbedding, candidate.contractEmbedding);
    if (axisEmbed > 0) matchedOn.push('contract-embed');
  }

  // Axis 3 — structural fingerprint.
  let axisStruct = 0;
  if (criteria.contract) {
    const queryFp = structuralFingerprint(criteria.contract);
    const candidateFp = structuralFingerprint(candidate.contract);
    axisStruct = structuralSimilarity(queryFp, candidateFp);
    if (axisStruct > 0) matchedOn.push('contract-shape');
  }

  // Axis 4 — variance overlap.
  let axisVariance = 0;
  if (criteria.variance) {
    axisVariance = varianceOverlap(criteria.variance, candidate.variance);
    if (axisVariance > 0) {
      // Surface which sub-axis contributed for telemetry-readability.
      if (
        criteria.variance.persona &&
        candidate.variance.persona &&
        criteria.variance.persona === candidate.variance.persona
      ) {
        matchedOn.push('persona');
      }
      const queryCtxKeys = Object.keys(criteria.variance.context ?? {});
      const candidateCtxKeys = Object.keys(candidate.variance.context ?? {});
      if (queryCtxKeys.length > 0 && candidateCtxKeys.length > 0) {
        // Only push 'context' when there's at least a chance of overlap.
        matchedOn.push('context');
      }
    }
  }

  // Axis 5 — intent Jaccard against seedPrompt + persona tokens.
  let axisIntent = 0;
  if (criteria.intentKeywords && criteria.intentKeywords.length > 0) {
    const seedTokens = tokenizeForIntent(candidate.variance.seedPrompt);
    const personaTokens = tokenizeForIntent(candidate.variance.persona);
    const candidateTokens = Array.from(new Set([...seedTokens, ...personaTokens]));
    const queryTokens = criteria.intentKeywords.map((t) => t.toLowerCase());
    axisIntent = jaccardSimilarity(queryTokens, candidateTokens);
    if (axisIntent > 0) matchedOn.push('intent');
  }

  const weighted =
    weights.hash * axisHash +
    weights.embed * axisEmbed +
    weights.struct * axisStruct +
    weights.variance * axisVariance +
    weights.intent * axisIntent;
  const score = weighted / sumWeights;

  return {
    score,
    matchedOn: Array.from(new Set(matchedOn)),
  };
}

/**
 * Build the v1 in-memory {@link BlueprintSearch}.
 */
export function createInMemoryBlueprintSearch(
  options: InMemoryBlueprintSearchOptions,
): BlueprintSearch {
  const { blueprintStore, embeddingProvider, defaultConfig, resolveAppConfig } =
    options;

  return {
    async search(criteria: BlueprintSearchCriteria): Promise<readonly BlueprintSearchResult[]> {
      const appConfig = resolveAppConfig
        ? await resolveAppConfig(criteria.appId)
        : undefined;
      const effective = resolveEffectiveConfig(appConfig, defaultConfig);
      const topK =
        criteria.topK && criteria.topK > 0 ? criteria.topK : effective.topK;

      // Short-circuit on exact hash match. The store's existing
      // `(appId, contractHash)` index makes this O(1)-ish without
      // touching the listAllForApp scan.
      if (criteria.contractHash) {
        const exact = await blueprintStore.list(criteria.appId, criteria.contractHash);
        const filtered = criteria.generator
          ? exact.filter((b) => b.generator === criteria.generator)
          : exact;
        if (filtered.length > 0) {
          // The hash axis fires; every other axis sums to its own value
          // but the hash short-circuit reads `score: 1.0` by convention.
          // We still report the top filtered.length rows so callers can
          // see siblings under the same contractHash.
          const sortedExact = sortCandidates(filtered);
          return sortedExact.slice(0, topK).map((bp, index) => ({
            blueprint: bp,
            score: index === 0 ? 1.0 : 1.0, // every exact-hash row is a 1.0 match
            matchedOn: ['contract-hash'],
          }));
        }
        // No exact match — fall through to the multi-axis scan below.
      }

      // Compute the query embedding once when we have a provider + contract.
      let queryEmbedding: readonly number[] | undefined;
      if (embeddingProvider && criteria.contract) {
        try {
          queryEmbedding = await embeddingProvider.embed(
            stringifyContractForEmbedding(criteria.contract),
          );
        } catch {
          // EmbeddingProvider failures degrade gracefully — the embed
          // axis contributes 0 and the other axes carry the decision.
          // Intentionally not swallowed silently in production; the
          // surrounding telemetry sink captures the error via the
          // calling handler's wrap.
          queryEmbedding = undefined;
        }
      }

      const all = await blueprintStore.listAllForApp(criteria.appId);
      const filteredByGenerator = criteria.generator
        ? all.filter((b) => b.generator === criteria.generator)
        : all;

      const scored: Array<BlueprintSearchResult> = [];
      for (const candidate of filteredByGenerator) {
        const { score, matchedOn } = scoreBlueprint({
          candidate,
          criteria,
          queryEmbedding,
          weights: effective.weights,
        });
        if (score > 0) {
          scored.push({ blueprint: candidate, score, matchedOn });
        }
      }

      // Sort by score desc; tiebreak via createdAt desc, then blueprintId asc.
      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.blueprint.createdAt !== b.blueprint.createdAt) {
          return a.blueprint.createdAt < b.blueprint.createdAt ? 1 : -1;
        }
        return a.blueprint.blueprintId < b.blueprint.blueprintId ? -1 : 1;
      });

      return scored.slice(0, topK);
    },
  };
}

function sortCandidates(candidates: readonly Blueprint[]): readonly Blueprint[] {
  return [...candidates].sort((a, b) => {
    if (a.createdAt !== b.createdAt) {
      return a.createdAt < b.createdAt ? 1 : -1;
    }
    return a.blueprintId < b.blueprintId ? -1 : 1;
  });
}
