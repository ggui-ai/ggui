/**
 * Blueprint matcher — the unified decision engine for `ggui_handshake`
 * and `ggui_render` direct-story paths.
 *
 * One function — `matchBlueprint(deps, scope, query)` — that selects
 * a lookup strategy by request shape and returns a structured decision
 * the caller can branch on. Two strategies, tried IN ORDER within one
 * call (the body below is the source of truth; this header describes
 * it, ggui#1229):
 *
 *   - **`exact-key` strategy** — agent supplied a contract.
 *     Canonical-key equality lookup against the registry. Free,
 *     deterministic, <1ms. Hit ⇒ `match-exact`, returned at once.
 *     Miss ⇒ FALL THROUGH to the semantic strategy — unless
 *     `options.disableSemantic` (the exact-only reuse policy,
 *     ggui#607), in which case the miss is reported as `no-match`
 *     without spending retrieval or the judge.
 *   - **`semantic` strategy** — agent omitted a contract, or the
 *     exact key missed. RAG (top-K cosine) + LLM rerank judge. Hit ⇒
 *     `match-semantic`. Miss buckets distinguish cosine-gate skip,
 *     no-LLM-wired skip, judge declined, low-confidence, defense.
 *     ~$0.001 + ~1.5s when LLM is wired.
 *
 * A semantic hit for a contract-bearing request is served PROACTIVELY,
 * kept safe by two properties (stated again at the branch): reuse is
 * ATOMIC (the cached blueprint's own contract + code, never the
 * request's contract under cached code), and coverage is INFORMATIONAL
 * (`coverageGap` rides every semantic hit; the decision layer surfaces
 * it as `COVERAGE_GAP` warn findings and the agent may override — the
 * cache proposes, the agent disposes).
 *
 * Caller treats `match-*` as reuse and `no-match*` as cold gen; the
 * produced blueprint is registered into the scope post-gen.
 *
 * The matcher is the single source of truth for the decision. Its
 * callers today: `decide-handshake` (the `ggui_handshake` path), the
 * cache-reuse probe and the match-precision probe. `ggui_render` does
 * NOT call it (§6): render resolves the blueprint by the identity the
 * handshake already decided.
 *
 * No I/O concerns leak to the caller — `BlueprintRegistryDeps`
 * captures the embedder + vector store, and an optional `LLMCaller`
 * enables the semantic strategy's judge. When LLM is absent
 * (placeholder mode, no BYOK, etc.) the judge is skipped and the
 * matcher returns `match-skip-no-llm`.
 */
import type { LLMCaller } from '@ggui-ai/negotiator';
import { llmRerankJudge, type RerankJudge } from '@ggui-ai/negotiator';
import { fits, type FitDeclined, type FitVerdict, type RequestFitFacts } from './fits.js';
import {
  summarizeContract,
  type DataContract,
  type BlueprintVariance,
} from '@ggui-ai/protocol';
import { blueprintKey, variantKey } from '@ggui-ai/protocol/blueprint-key';
import {
  emitCacheTraceEvent,
  newCacheTraceId,
  truncateCacheTraceIntent,
  type CacheTraceCandidate,
  type CacheTraceDecision,
  type CacheTraceStrategy,
} from './cache-trace-sink.js';
import {
  findBlueprintExact,
  findBlueprintsByEmbedding,
  recordBlueprintHit,
  type Blueprint,
  type BlueprintCandidate,
  type BlueprintKind,
  type BlueprintRegistryDeps,
} from './blueprint-registry.js';
import type { InstalledBlueprintsProvider } from './installed-blueprints-provider.js';
import { coverageGap, type CoverageGap } from './blueprint-coverage.js';

/** An all-empty coverage gap — used for exact-key hits (canonical-key
 *  equality already implies full coverage) and for contract-less requests
 *  (nothing to cover against). */
const EMPTY_GAP: CoverageGap = {
  actions: [],
  props: [],
  context: [],
  streams: [],
  gadgets: [],
};

/** Match-found shape — everything the caller needs to commit a reuse. */
export interface BlueprintMatchHit {
  /**
   * Which strategy produced the match. `'exact-key'` ⇒ canonical-key
   * equality (free, deterministic). `'semantic'` ⇒ RAG + LLM judge.
   */
  readonly strategy: CacheTraceStrategy;
  readonly blueprint: Blueprint;
  /** Cosine similarity from RAG (exact-key: 1.0; semantic: rerank top-1 cosine). */
  readonly cosine: number;
  /** Free-text reason for trace logs / handshake reason field. */
  readonly reason: string;
  /**
   * ggui#1427 — the served candidate's fit verdict. A semantic hit fits by
   * construction (the judge ranked only fitting candidates). An exact-key
   * hit is OBSERVED, never declined: `fits: false` here is a would-miss,
   * named by kind, for the deployment to count.
   */
  readonly fit?: FitVerdict;
  /** ggui#1427 — candidates the pre-filter dropped before the judge (semantic path only). */
  readonly fitDeclined?: readonly FitDeclined[];
  /** When strategy='semantic', the LLM judge's confidence; undefined for exact-key. */
  readonly judgeConfidence?: number;
  /**
   * The surfaces the request declares that the matched blueprint does NOT
   * cover. Empty everywhere ⇒ the cached UI covers the request fully;
   * non-empty ⇒ the agent asked for a capability the cached UI lacks (the
   * decision layer surfaces these as `COVERAGE_GAP` warn findings so the
   * agent can override). `exact-key` hits + contract-less requests always
   * carry the all-empty {@link EMPTY_GAP}.
   */
  readonly coverage: CoverageGap;
}

/** No-match result — caller cold-gens. */
export interface BlueprintMatchMiss {
  readonly strategy: 'no-match';
  readonly reason: string;
  /**
   * The candidates the matcher saw, if any. Useful for the trace
   * sink: "no semantic hit because the judge declined all 5 RAG
   * neighbors." Empty array means the scope was cold (no candidates
   * at all).
   */
  readonly candidates: readonly BlueprintCandidate[];
  /**
   * When LLM rerank ran but rejected, the judge's reason — surfaced
   * up so the trace event captures "why didn't this hit." Absent
   * when LLM was unavailable or rerank short-circuited.
   */
  readonly judgeReason?: string;
  /** ggui#1427 — candidates the pre-filter dropped before the judge, named by miss kind (semantic path only). */
  readonly fitDeclined?: readonly FitDeclined[];
}

export type BlueprintMatchResult = BlueprintMatchHit | BlueprintMatchMiss;

/** Compose deps for the matcher. */
/** A judge with the confidence threshold it was measured on (ggui#1235). */
export interface RerankPair {
  readonly judge: RerankJudge;
  readonly threshold: number;
}

export interface MatchBlueprintDeps {
  readonly registry: BlueprintRegistryDeps;
  /**
   * Optional LLM caller for the semantic strategy's judge. Absent →
   * the judge is skipped and the matcher returns `match-skip-no-llm`
   * when RAG produced candidates. Production deployments should
   * always wire an LLM (a bring-your-own-key provider, or a central
   * pool credential on a hosted deployment).
   */
  readonly llm?: LLMCaller;
  /**
   * The rerank judge as a PAIR with the confidence threshold it was
   * measured on (ggui#1235). Absent → today's default, `llm` bound
   * through `llmRerankJudge` at `options.judgeThreshold` (0.5). Present
   * → this judge decides, its `threshold` is the cut, and
   * `options.judgeThreshold` does not apply to it: a threshold never
   * travels apart from the judge it was calibrated on. A judge that
   * resolves its own cut internally (a decision provider with a fallback
   * chain) passes `threshold: 0` and declines only with `matchId: null`.
   * Wins over a bare `llm` when both are given.
   */
  readonly rerank?: RerankPair;
  /**
   * Optional marketplace-install bridge. When set, the matcher STARTS
   * `ensureCached(scope)` and reads the exact key while it runs: a hit
   * the walk can never evict (not bridge-owned) is served at once; a
   * bridge-owned hit, a miss and the semantic tier all wait for it
   * (ggui#1370). Installed blueprints lazily compile + populate the same
   * vector store the matcher reads, so the next lookup sees them.
   * Idempotent per scope; subsequent calls are cheap no-ops.
   *
   * Best-effort: ensureCached failures are swallowed so a broken
   * installed-blueprint compile can't sink an otherwise-healthy
   * match. The provider itself catches per-entry issues; this guard
   * defends against a provider implementation that breaks the
   * never-throws contract.
   */
  readonly installedBlueprints?: InstalledBlueprintsProvider;
}

export interface MatchBlueprintOptions {
  /** Atomic-design level to match against. Default `'template'`. */
  readonly kind?: BlueprintKind;
  /** RAG top-K. Default 20 — balance between recall and prompt cost. */
  readonly topK?: number;
  /**
   * Minimum cosine a candidate needs to reach the LLM judge. Default: one
   * floor per query kind — 0.50 when the request carries a contract (its
   * query is composed like the stored vectors), 0.2 when it does not (its
   * query embeds the intent alone, on a lower scale); see the
   * DEFAULT_MIN_COSINE_* note. A value here overrides both. Applied PER CANDIDATE (ggui#1275): a
   * candidate under the floor is never offered to the judge, so it can
   * never become a reuse; when even top-1 is under it, the judge is skipped
   * entirely and the rerank cost is saved.
   */
  readonly minCosineForRerank?: number;
  /** LLM judge confidence threshold for treating a semantic-strategy decision as a hit. */
  /** Default 0.5 — loosened for Path-A; see the DEFAULT_JUDGE_THRESHOLD note. */
  readonly judgeThreshold?: number;
  /**
   * Disable the semantic (RAG + judge) strategy entirely — exact-key
   * canonical matches still hit; everything else returns `no-match`
   * without a retrieval or judge call. For deployments whose surfaces
   * must be presentation-stable (byte-identical requests reuse
   * deterministically; paraphrases regenerate): fuzzy matching serves
   * a SIMILAR cached surface, and "similar" is exactly what a
   * stability-sensitive caller cannot afford (ggui#607).
   */
  readonly disableSemantic?: boolean;
  /**
   * ggui#1568 — WHY `disableSemantic` is set, so the trace never names a
   * cause that did not hold. `'exact-only-policy'` (the default) is the
   * ggui#607 reuse policy. `'exclusion-unavailable'` means the deployment
   * could not say which rows are reserved from the semantic tier
   * ({@link excludeFromSemantic}), so it turned the tier off rather than
   * risk offering one. Read only when `disableSemantic` is true.
   */
  readonly disableSemanticCause?: 'exact-only-policy' | 'exclusion-unavailable';
  /**
   * ggui#1568 — rows the deployment reserves from the semantic tier, each
   * named by {@link semanticExclusionKey}. A named row is dropped straight
   * after retrieval, so it is never offered to the judge, never returned as
   * a candidate and never reused by similarity. It stays reachable by its
   * exact key: exclusion governs how a row is FOUND, never whether it can be
   * served to a request that names it. Retrieval over-fetches by the set's
   * size, so the pool the judge ranks is still `topK` deep. A vector store
   * that clamps its `topK` returns fewer rows than asked, and the pool is
   * then shallower: fewer reuses, never a reserved row.
   */
  readonly excludeFromSemantic?: ReadonlySet<string>;
}

/**
 * ggui#1568 — the key {@link MatchBlueprintOptions.excludeFromSemantic}
 * names a row by: its `(contractKey, variantKey)` pair, the same pair the
 * exact tier resolves. Unambiguous by construction (JSON array), so no two
 * different pairs share a key.
 */
export function semanticExclusionKey(contractKey: string, variantKey: string): string {
  return JSON.stringify([contractKey, variantKey]);
}

const DEFAULT_TOP_K = 20;
// The cosine gate before the judge — ONE FLOOR PER QUERY KIND, because the
// two kinds of query sit on two scales (ggui#606).
//
// Every stored vector embeds its contract summary AND its intent
// (`composeEmbeddingInput(contract, intent)`). A request that carries a
// contract composes its query the same way (below), so its cosines are on
// that SYMMETRIC scale. A request without a contract cannot compose one: its
// query embeds the intent alone and its cosines sit on the lower,
// asymmetric scale. Measured on a development deployment with the
// production embedder (ggui#1275): the same pair scored 0.29 asymmetric and
// 0.87 symmetric. One number cannot serve both.
//
// - Composed (contract-bearing) query: 0.50. ggui#606's pre-registered gate
//   (the 28-pair replay through the real matcher at gate 0, both embedders;
//   c.5849689990) picked the highest floor that keeps recall at today's
//   and wrong accepts no higher than today's: 0.50 holds recall 9/9 on both
//   embedders; Titan bounds it (0.60 cuts a true match), and the nearest
//   contract-bearing true match sits at 0.767.
// - Intent-only (contract-less) query: 0.2, unchanged. Its cosines are the
//   same asymmetric scale as before this change, so its floor stays too. It
//   is deliberately NOT `ggui_search_blueprints`' 0.3: on this scale a 0.3
//   gate turned true matches away (ggui#1275). A candidate with no authored
//   intent never reaches the judge at all (ggui#1275 (3)).
const DEFAULT_MIN_COSINE_COMPOSED = 0.5;
const DEFAULT_MIN_COSINE_INTENT_ONLY = 0.2;
// Loosened for Path-A: accept a semantic judge's pick more readily, so a
// paraphrased / similar contract is reused instead of cold-generating.
// Over-proposal is bounded by the agent decision step plus the COVERAGE_GAP
// findings on a non-covering hit (the cache proposes; the agent disposes).
// Not re-tuned by ggui#1275: separating right from wrong picks by
// confidence is a measurement for the match-precision probe, not a number
// to fit to eight samples.
const DEFAULT_JUDGE_THRESHOLD = 0.5;

/**
 * Walk the matcher and return the decision.
 *
 * Side effect: on a match, fires `recordBlueprintHit` to bump the
 * blueprint's hitCount + lastHitAt. The bump is best-effort —
 * failure is swallowed so a metrics-write rejection can't sink an
 * otherwise-successful match.
 */
export async function matchBlueprint(
  deps: MatchBlueprintDeps,
  scope: string,
  query: {
    readonly intent: string;
    readonly contract?: DataContract;
    readonly variance?: BlueprintVariance;
    /**
     * ggui#1427 — the request's declared fit facts (canvas, aesthetic
     * preset, direction digest). Absent facts evaluate nothing; data-shape
     * runs from `contract` alone.
     */
    readonly fit?: RequestFitFacts;
  },
  options: MatchBlueprintOptions = {},
): Promise<BlueprintMatchResult> {
  const kind: BlueprintKind = options.kind ?? 'template';
  const topK = options.topK ?? DEFAULT_TOP_K;
  // One floor per query kind (see the DEFAULT_MIN_COSINE_* note); an explicit
  // option overrides either.
  const minCosine =
    options.minCosineForRerank ??
    (query.contract !== undefined ? DEFAULT_MIN_COSINE_COMPOSED : DEFAULT_MIN_COSINE_INTENT_ONLY);
  // ggui#1235 — the pair: a supplied judge carries its own cut; the default
  // is today's LLM judge at `options.judgeThreshold` (0.5).
  const rerank =
    deps.rerank ??
    (deps.llm !== undefined
      ? { judge: llmRerankJudge(deps.llm), threshold: options.judgeThreshold ?? DEFAULT_JUDGE_THRESHOLD }
      : undefined);
  const judgeThreshold = rerank?.threshold ?? options.judgeThreshold ?? DEFAULT_JUDGE_THRESHOLD;
  const trimmedIntent = query.intent.trim();
  const startedAt = Date.now();
  const expectedKey =
    query.contract !== undefined ? blueprintKey(query.contract) : '';

  // Trace emit helper — closes over per-call state so each `return`
  // gets one event at the matching decision boundary.
  const emit = (args: {
    decision: CacheTraceDecision;
    strategy?: CacheTraceStrategy;
    reason: string;
    candidates: ReadonlyArray<BlueprintCandidate>;
    winningBlueprintId?: string;
    judgeConfidence?: number;
    judgeReason?: string;
    fit?: FitVerdict;
    verdicts?: ReadonlyMap<string, FitVerdict>;
  }): void => {
    const traceCandidates: CacheTraceCandidate[] = args.candidates.map((c) => {
      const fit = args.verdicts?.get(c.blueprint.id);
      return {
        key: c.blueprint.id,
        score: c.cosine,
        cachedIntent: c.blueprint.intent,
        ...(fit !== undefined ? { fit } : {}),
      };
    });
    // Cosine distance to the nearest registered blueprint — populated
    // only when RAG retrieval produced at least one candidate.
    // `1 - top.cosine` mirrors `validateContractNovelty`'s distance
    // formula in `@ggui-ai/negotiator` so operator dashboards correlate.
    const top = args.candidates[0];
    const cosineNoveltyDistance =
      top !== undefined ? 1 - top.cosine : undefined;
    emitCacheTraceEvent({
      id: newCacheTraceId(),
      at: Date.now(),
      durationMs: Date.now() - startedAt,
      scope,
      intent: truncateCacheTraceIntent(trimmedIntent),
      expectedKey,
      threshold: judgeThreshold,
      decision: args.decision,
      ...(args.strategy !== undefined ? { strategy: args.strategy } : {}),
      candidates: traceCandidates,
      ...(args.winningBlueprintId !== undefined
        ? { winningBlueprintId: args.winningBlueprintId }
        : {}),
      reason: args.reason,
      ...(args.judgeConfidence !== undefined
        ? { judgeConfidence: args.judgeConfidence }
        : {}),
      ...(args.judgeReason !== undefined
        ? { judgeReason: args.judgeReason }
        : {}),
      ...(args.fit !== undefined ? { fit: args.fit } : {}),
      ...(cosineNoveltyDistance !== undefined
        ? { cosineNoveltyDistance }
        : {}),
    });
  };

  // ggui#1427 — the request's side of `fits()`: the draft contract for
  // data-shape plus whatever facts the caller declared. Computed once.
  const fitRequest = {
    ...(query.contract !== undefined ? { contract: query.contract } : {}),
    ...(query.fit ?? {}),
  };
  const verdictFor = (bp: Blueprint): FitVerdict =>
    fits(
      {
        contract: bp.contract,
        ...(bp.judgedCanvases !== undefined ? { judgedCanvases: bp.judgedCanvases } : {}),
        ...(bp.aestheticPreset !== undefined ? { aestheticPreset: bp.aestheticPreset } : {}),
        ...(bp.directionDigest !== undefined ? { directionDigest: bp.directionDigest } : {}),
        ...(bp.directionScope !== undefined ? { directionScope: bp.directionScope } : {}),
      },
      fitRequest,
    );

  if (trimmedIntent.length === 0) {
    const reason = 'empty intent — no match attempted';
    // No strategy field — matcher short-circuits before selecting one.
    emit({ decision: 'no-match-empty-intent', reason, candidates: [] });
    return { strategy: 'no-match', reason, candidates: [] };
  }

  // ggui#1370 — start the installed-blueprints walk, but do NOT wait for it
  // before the exact-key read. On a scope's first call per process the walk
  // enumerates the scope (a whole-index walk on a store that cannot list
  // by scope) before it can settle; an exact-key hit that the walk can never evict — a row
  // that is not bridge-owned — is served at once while the walk finishes in
  // the background (memoised per scope, errors swallowed). Everything else
  // waits: a bridge-owned hit is re-read AFTER the walk because its orphan
  // sweep may have evicted it (the G4 stale-cache guarantee); a miss is
  // re-read because the walk may have compiled + registered an install; and
  // the semantic tier never runs before the walk, since an uninstalled
  // vector is servable there. No hit-count write is issued before the walk
  // settles either — a bump racing the sweep's delete would re-create the
  // uninstalled vector.
  let ensured: Promise<void> = Promise.resolve();
  if (deps.installedBlueprints) {
    const ensureArg =
      query.contract !== undefined ? { contractKey: expectedKey } : undefined;
    let started: Promise<void>;
    try {
      started = Promise.resolve(deps.installedBlueprints.ensureCached(scope, ensureArg));
    } catch (err) {
      started = Promise.reject(err);
    }
    ensured = started.catch((err: unknown) => {
      console.warn(
        `[blueprint-matcher] installedBlueprints.ensureCached threw — ignoring: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  if (query.contract !== undefined) {
    type ExactRow = NonNullable<Awaited<ReturnType<typeof findBlueprintExact>>>;
    const lookupExact = async (): Promise<ExactRow | null> => {
      try {
        return await findBlueprintExact(
          {
            vectorStore: deps.registry.vectorStore,
            index: deps.registry.index,
          },
          scope,
          kind,
          expectedKey,
          variantKey(query.variance),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[blueprint-matcher] exact-key lookup failed: ${msg}`);
        return null;
      }
    };
    const serveExact = (exact: ExactRow): BlueprintMatchResult => {
      const reason = 'match-exact: this contract already has a saved interface — reusing it';
      // ggui#1427 — the exact tier OBSERVES `fits`, never acts on it: the
      // canonical key is the contract alone, so an exact hit can mis-fit on
      // surface or direction today. The verdict rides the result and the
      // trace as a would-miss for the deployment to count; the hit is served.
      const fit = verdictFor(exact);
      emit({
        decision: 'match-exact',
        strategy: 'exact-key',
        reason,
        candidates: [],
        winningBlueprintId: exact.id,
        fit,
      });
      return {
        strategy: 'exact-key',
        blueprint: exact,
        cosine: 1,
        reason,
        coverage: EMPTY_GAP,
        fit,
      };
    };

    // ─── Strategy: exact-key fast-path (agent supplied a contract) ─────
    const early = await lookupExact();
    if (early !== null && early.installed !== true) {
      const id = early.id;
      void ensured.then(() => bumpHitBestEffort(deps.registry, scope, id));
      return serveExact(early);
    }
    await ensured;
    const settled = await lookupExact();
    if (settled !== null) {
      bumpHitBestEffort(deps.registry, scope, settled.id);
      return serveExact(settled);
    }
  } else {
    await ensured;
  }

  if (options.disableSemantic === true) {
    // The semantic tier is switched off for this request: the exact-only
    // reuse policy (ggui#607), or a deployment that cannot say which rows
    // are reserved from it (ggui#1568). Report the miss, naming which,
    // without spending the retrieval or the judge call.
    const reason =
      options.disableSemanticCause === 'exclusion-unavailable'
        ? 'no-match: no canonical match, and similar-interface reuse is unavailable for this request — a new interface will be generated'
        : 'exact-only policy: no canonical match — a new interface will be generated';
    emit({ decision: 'no-match', strategy: 'semantic', reason, candidates: [] });
    return { strategy: 'no-match', reason, candidates: [] };
  }

  // ─── Strategy: semantic (find-similar + judge) ────────────────────
  // Reached when the agent omitted a contract OR an exact-key probe
  // missed. RAG top-K → cosine gate → LLM rerank judge. Hit ⇒ the matched
  // blueprint's contract+UI is reused atomically, with any coverage gap
  // (request surfaces the cached UI lacks) reported on `hit.coverage`.
  // Miss buckets distinguish cosine-gate, no-LLM, judge-declined,
  // low-confidence, defense.
  let candidates: readonly BlueprintCandidate[] = [];
  const excluded = options.excludeFromSemantic;
  const excludedCount = excluded?.size ?? 0;
  let droppedByExclusion = 0;
  try {
    // ggui#606: compose the query the way stored vectors are composed
    // (`composeEmbeddingInput(contract, intent)`), so a candidate is scored
    // on the scale it was stored on. A contract-less request stays
    // intent-only recall by design (and keeps its own floor above).
    const ragArg: { intent: string; contract?: DataContract } =
      query.contract !== undefined
        ? { intent: trimmedIntent, contract: query.contract }
        : { intent: trimmedIntent };
    const retrieved = await findBlueprintsByEmbedding(
      deps.registry,
      scope,
      ragArg,
      { kind, topK: topK + excludedCount },
    );
    // ggui#1568 — a reserved row leaves here, before the cosine gate, the
    // judge, the trace and the result: nothing downstream ever sees it.
    const kept =
      excluded === undefined || excludedCount === 0
        ? retrieved
        : retrieved.filter(
            (c) => !excluded.has(semanticExclusionKey(c.blueprint.contractKey, c.blueprint.variantKey)),
          );
    droppedByExclusion = retrieved.length - kept.length;
    candidates = kept.slice(0, topK);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const reason =
      'no-match: retrieval unavailable — a new interface will be generated';
    emit({
      decision: 'no-match',
      strategy: 'semantic',
      reason: `no-match: RAG retrieval failed — ${msg}`,
      candidates: [],
    });
    return { strategy: 'no-match', reason, candidates: [] };
  }

  if (candidates.length === 0) {
    // ggui#1568 — "first registration" is false when rows were retrieved and
    // every one was reserved; the reason says which it was.
    const reason =
      droppedByExclusion > 0
        ? 'no-match: no saved interface is available for reuse — a new one will be generated'
        : 'no-match: no candidates in scope — first registration of this kind';
    const traceReason =
      droppedByExclusion > 0
        ? `no-match: ${droppedByExclusion} candidates retrieved, every one reserved from the semantic tier by the deployment`
        : reason;
    emit({
      decision: 'no-match',
      strategy: 'semantic',
      reason: traceReason,
      candidates: [],
    });
    return { strategy: 'no-match', reason, candidates: [] };
  }

  const top = candidates[0]!;
  if (top.cosine < minCosine) {
    const reason =
      'match-skip-low-cosine: no saved interface is close enough — a new one will be generated';
    const traceReason = `match-skip-low-cosine: top cosine=${top.cosine.toFixed(2)} < minCosine=${minCosine}; judge skipped`;
    emit({
      decision: 'match-skip-low-cosine',
      strategy: 'semantic',
      reason: traceReason,
      candidates,
    });
    return { strategy: 'no-match', reason, candidates };
  }

  if (rerank === undefined) {
    const reason =
      'match-skip-no-llm: semantic matching unavailable — a new interface will be generated';
    const traceReason = `match-skip-no-llm: ${candidates.length} candidates available but no judge wired (neither a rerank pair nor an LLMCaller) — falling through to cold generation`;
    emit({
      decision: 'match-skip-no-llm',
      strategy: 'semantic',
      reason: traceReason,
      candidates,
    });
    return { strategy: 'no-match', reason, candidates };
  }

  // ggui#1275 — who the judge may see. (1) The floor is per candidate: top-1
  // clearing it used to hand ALL top-K to the judge, which could pick any of
  // them (observed: a reuse at cosine 0.19 under the then-0.2 floor because
  // top-1 was 0.27). (2) A row whose intent is a stand-in
  // (`intentSource: 'fallback'` — a placeholder, an id, a title, a persona)
  // is never offered: semantic reuse is intent similarity, and with no
  // intent the judge compares contract summaries and guesses (observed: both
  // wrong reuses of the 2026-09 read picked one placeholder-intent row).
  // Such a row stays reachable by exact key above. The trace still carries
  // the full top-K.
  const aboveFloor = candidates.filter((c) => c.cosine >= minCosine);
  const eligible = aboveFloor.filter((c) => c.blueprint.intentSource !== 'fallback');
  const floorNote =
    eligible.length < candidates.length
      ? ` (${eligible.length} of ${candidates.length} candidates at or above minCosine=${minCosine} with an authored intent)`
      : '';

  // ggui#1427 — (3) `fits()` as a pre-filter on the judge's top-K: the three
  // code checks (data-shape, surface, direction) are typed comparisons that
  // cost nothing, so the judge only ever ranks candidates that fit. A dropped
  // candidate is recorded with its first miss; the pool declines only when
  // no candidate is left, or the judge then says no-match. Verdicts are
  // computed for the whole top-K so the trace carries every candidate's.
  const verdicts = new Map<string, FitVerdict>(
    candidates.map((c) => [c.blueprint.id, verdictFor(c.blueprint)] as const),
  );
  const fitting = eligible.filter((c) => verdicts.get(c.blueprint.id)?.fits === true);
  const fitDeclined: FitDeclined[] = eligible.flatMap((c) => {
    const v = verdicts.get(c.blueprint.id);
    if (v === undefined || v.fits || v.miss === undefined) return [];
    return [
      {
        id: c.blueprint.id,
        miss: v.miss,
        ...(v.miss === 'direction' && v.directionScope !== undefined ? { directionScope: v.directionScope } : {}),
      },
    ];
  });

  if (eligible.length === 0) {
    // Top-1 cleared the floor, but every candidate that did carries a
    // stand-in intent — nothing the judge could honestly compare.
    const reason =
      'no-match: no saved interface close enough has a stated intent — a new one will be generated';
    const traceReason = `no-match: ${aboveFloor.length} candidates at or above minCosine=${minCosine}, none with an authored intent; judge skipped`;
    emit({
      decision: 'no-match',
      strategy: 'semantic',
      reason: traceReason,
      candidates,
    });
    return { strategy: 'no-match', reason, candidates };
  }

  if (fitting.length === 0) {
    // Every candidate with a stated intent misses a declared fact — nothing
    // the judge may rank. Named by kind so declined-by-miss is countable.
    const kinds = [...new Set(fitDeclined.map((d) => d.miss))].join(', ');
    const reason =
      'no-match: no saved interface close enough fits this request — a new one will be generated';
    const traceReason = `no-match: ${eligible.length} candidates at or above minCosine=${minCosine} with an authored intent, none fits the request's declared facts (miss: ${kinds}); judge skipped`;
    emit({
      decision: 'no-match',
      strategy: 'semantic',
      reason: traceReason,
      candidates,
      verdicts,
    });
    return { strategy: 'no-match', reason, candidates, fitDeclined };
  }

  // Run the LLM rerank judge — over the fitting candidates only.
  const decision = await rerank.judge(
    {
      intent: trimmedIntent,
      contractSummary: summarizeContract(query.contract),
    },
    fitting.map((c) => ({
      id: c.blueprint.id,
      cachedIntent: c.blueprint.intent,
      cachedContractSummary: summarizeContract(c.blueprint.contract),
      cosine: c.cosine,
    })),
  );

  if (decision.matchId === null || decision.confidence < judgeThreshold) {
    const reason =
      decision.matchId === null
        ? 'no-match: judge declined all candidates — a new interface will be generated'
        : 'no-match-low-confidence: the closest saved interface is not a confident match — a new one will be generated';
    const traceReason =
      decision.matchId === null
        ? `no-match: judge declined all ${fitting.length} candidates (confidence=${decision.confidence.toFixed(2)})${floorNote}`
        : `no-match-low-confidence: judge picked ${decision.matchId} but confidence=${decision.confidence.toFixed(2)} < threshold=${judgeThreshold}`;
    emit({
      decision:
        decision.matchId === null ? 'no-match' : 'no-match-low-confidence',
      strategy: 'semantic',
      reason: traceReason,
      candidates,
      judgeConfidence: decision.confidence,
      judgeReason: decision.reason,
      verdicts,
    });
    return {
      strategy: 'no-match',
      reason,
      candidates,
      judgeReason: decision.reason,
      fitDeclined,
    };
  }

  const matched = fitting.find((c) => c.blueprint.id === decision.matchId);
  if (!matched) {
    // Defensive — rerankCandidates already guards against unknown ids
    // by collapsing to null, but a future change could re-introduce
    // the gap. Fail-loud.
    const reason =
      'no-match-judge-defense: the match could not be verified — a new interface will be generated';
    const traceReason = `no-match-judge-defense: judge picked id=${decision.matchId} but it's not in the candidate set — falling through`;
    emit({
      decision: 'no-match-judge-defense',
      strategy: 'semantic',
      reason: traceReason,
      candidates,
      judgeConfidence: decision.confidence,
      judgeReason: decision.reason,
      verdicts,
    });
    return {
      strategy: 'no-match',
      reason,
      candidates,
      judgeReason: decision.reason,
      fitDeclined,
    };
  }

  bumpHitBestEffort(deps.registry, scope, matched.blueprint.id);
  // Compute the coverage gap vs the request's declared surface. Empty when
  // contract-less (nothing to cover) or fully covering. A non-empty gap is
  // reported (not dropped): the cache proposes the similar blueprint and
  // the agent override is the safety valve.
  const coverage =
    query.contract !== undefined
      ? coverageGap(matched.blueprint.contract, query.contract)
      : EMPTY_GAP;
  const gapNote = coverageGapNote(coverage);
  const reason = `match-semantic: a saved interface matches this intent — reusing it${gapNote}`;
  const traceReason = `match-semantic: judge matched ${matched.blueprint.id} (cosine=${matched.cosine.toFixed(2)}, confidence=${decision.confidence.toFixed(2)}) — ${decision.reason}${gapNote}`;
  emit({
    decision: 'match-semantic',
    strategy: 'semantic',
    reason: traceReason,
    candidates,
    winningBlueprintId: matched.blueprint.id,
    judgeConfidence: decision.confidence,
    judgeReason: decision.reason,
    verdicts,
    ...(verdicts.get(matched.blueprint.id) !== undefined ? { fit: verdicts.get(matched.blueprint.id) } : {}),
  });
  const matchedFit = verdicts.get(matched.blueprint.id);
  return {
    strategy: 'semantic',
    blueprint: matched.blueprint,
    cosine: matched.cosine,
    judgeConfidence: decision.confidence,
    reason,
    coverage,
    ...(matchedFit !== undefined ? { fit: matchedFit } : {}),
    fitDeclined,
  };
}

/**
 * When the chosen blueprint does not cover every surface the request
 * declares, build a human-readable note appended to the match reason — the
 * request declares surfaces the cached UI lacks; the agent override is the
 * safety valve. Empty gap ⇒ empty string.
 */
function coverageGapNote(gap: CoverageGap): string {
  const parts: string[] = [];
  if (gap.actions.length > 0) parts.push(`actions: ${gap.actions.join(', ')}`);
  if (gap.props.length > 0) parts.push(`props: ${gap.props.join(', ')}`);
  if (gap.context.length > 0) parts.push(`context: ${gap.context.join(', ')}`);
  if (gap.streams.length > 0) parts.push(`streams: ${gap.streams.join(', ')}`);
  if (gap.gadgets.length > 0) parts.push(`gadgets: ${gap.gadgets.join(', ')}`);
  if (parts.length === 0) return '';
  return ` [coverage gap — the request declares surfaces this cached UI lacks (${parts.join('; ')}); agent override is the safety valve]`;
}

function bumpHitBestEffort(
  deps: BlueprintRegistryDeps,
  scope: string,
  id: string,
): void {
  // Fire-and-forget. Hit-counter is a diagnostic, not load-bearing —
  // dropping the bump on transient store errors is preferable to
  // failing the handshake response.
  recordBlueprintHit(deps, scope, id).catch(() => {
    // Intentional: silent drop on metric write failure.
  });
}
