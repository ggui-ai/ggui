/**
 * Blueprint matcher — the unified decision engine for `ggui_handshake`
 * and `ggui_push` direct-story paths.
 *
 * One function — `matchBlueprint(deps, scope, query)` — that selects
 * a lookup strategy by request shape and returns a structured decision
 * the caller can branch on. Two strategies, mutually exclusive per
 * call — fuzzy matching across non-equal canonical contracts is
 * structurally unsafe, so the matcher never cascades between them:
 *
 *   - **`exact-key` strategy** — agent supplied a contract.
 *     Canonical-key equality lookup against the registry. Free,
 *     deterministic, <1ms. Hit ⇒ `match-exact`. Miss ⇒ `no-match`
 *     (cold gen against the agent's authored contract).
 *   - **`semantic` strategy** — agent omitted a contract.
 *     RAG (top-K cosine) + LLM rerank judge. Hit ⇒ `match-semantic`.
 *     Miss buckets distinguish cosine-gate skip, no-LLM-wired skip,
 *     judge declined, low-confidence, defense. ~$0.001 + ~1.5s when
 *     LLM is wired.
 *
 * Caller treats `match-*` as reuse and `no-match*` as cold gen; the
 * produced blueprint is registered into the scope post-gen.
 *
 * The matcher is the single source of truth for the decision; both
 * `ggui_handshake` and `ggui_push` route through it. Without
 * unification the two surfaces would drift, leaving "did this hit
 * via handshake or push?" as a debug pain point.
 *
 * No I/O concerns leak to the caller — `BlueprintRegistryDeps`
 * captures the embedder + vector store, and an optional `LLMCaller`
 * enables the semantic strategy's judge. When LLM is absent
 * (placeholder mode, no BYOK, etc.) the judge is skipped and the
 * matcher returns `match-skip-no-llm`.
 */
import type { LLMCaller } from '@ggui-ai/negotiator';
import { rerankCandidates } from '@ggui-ai/negotiator';
import { summarizeContract, type DataContract } from '@ggui-ai/protocol';
import { blueprintKey } from '@ggui-ai/protocol/blueprint-key';
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
  /** When strategy='semantic', the LLM judge's confidence; undefined for exact-key. */
  readonly judgeConfidence?: number;
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
}

export type BlueprintMatchResult = BlueprintMatchHit | BlueprintMatchMiss;

/** Compose deps for the matcher. */
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
   * Optional marketplace-install bridge. When set, the
   * matcher calls `ensureCached(scope)` before consulting the
   * registry — installed blueprints lazily compile + populate the
   * same vector store the matcher reads, so the next lookup sees
   * them. Idempotent per scope; subsequent calls are cheap no-ops.
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
  /** Minimum cosine on top-1 to even invoke the LLM judge. Default 0.3 — */
  /** below this the candidates are clearly unrelated; rerank cost is wasted. */
  readonly minCosineForRerank?: number;
  /** LLM judge confidence threshold for treating a semantic-strategy decision as a hit. */
  /** Default 0.6 — empirically calibrated. */
  readonly judgeThreshold?: number;
}

const DEFAULT_TOP_K = 20;
const DEFAULT_MIN_COSINE = 0.3;
const DEFAULT_JUDGE_THRESHOLD = 0.6;

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
  query: { readonly intent: string; readonly contract?: DataContract },
  options: MatchBlueprintOptions = {},
): Promise<BlueprintMatchResult> {
  const kind: BlueprintKind = options.kind ?? 'template';
  const topK = options.topK ?? DEFAULT_TOP_K;
  const minCosine = options.minCosineForRerank ?? DEFAULT_MIN_COSINE;
  const judgeThreshold = options.judgeThreshold ?? DEFAULT_JUDGE_THRESHOLD;
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
  }): void => {
    const traceCandidates: CacheTraceCandidate[] = args.candidates.map((c) => ({
      key: c.blueprint.id,
      score: c.cosine,
      cachedIntent: c.blueprint.intent,
    }));
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
      ...(cosineNoveltyDistance !== undefined
        ? { cosineNoveltyDistance }
        : {}),
    });
  };

  if (trimmedIntent.length === 0) {
    const reason = 'empty intent — no match attempted';
    // No strategy field — matcher short-circuits before selecting one.
    emit({ decision: 'no-match-empty-intent', reason, candidates: [] });
    return { strategy: 'no-match', reason, candidates: [] };
  }

  // ─── Lazy install-to-cache bridge ─────────────────────────────────
  //
  // If an installedBlueprints provider is wired, ensure marketplace-
  // installed entries for this scope have been compiled + cached
  // before we consult the registry. Idempotent per scope; the first
  // call pays the compile, subsequent calls are cheap no-ops.
  // Best-effort: a provider error never sinks the match.
  if (deps.installedBlueprints) {
    try {
      const ensureArg =
        query.contract !== undefined
          ? { contractKey: expectedKey }
          : undefined;
      await deps.installedBlueprints.ensureCached(scope, ensureArg);
    } catch (err) {
      // eslint-disable-next-line no-console -- operator-visible signal; provider should never throw
      console.warn(
        `[blueprint-matcher] installedBlueprints.ensureCached threw — ignoring: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // ─── Strategy: exact-key (agent supplied a contract) ──────────────
  //
  // Canonical-key equality lookup. Hit ⇒ guaranteed reuse. Miss ⇒
  // cold gen against the requested contract.
  //
  // No fall-through to the semantic strategy. The
  // judge can accept candidates whose canonical wire surface differs
  // from the request's — different action keysets (subset OR superset)
  // or different schemas within matching keys. Serving such a
  // candidate's componentCode under the request's contract leaves:
  //   - cached useAction('foo') call sites with no matching ActionSpec
  //     entry registered (button renders, click does nothing)
  //   - request-declared actionSpec entries with no useAction call
  //     site in the cached code (declared button never appears in DOM)
  //   - schema mismatches inside matching action names (cached
  //     consumes payload.X, runtime dispatches payload.Y → silent
  //     payload loss)
  //
  // For contract-bearing requests, canonical-key equality is the only
  // structurally-safe match.
  if (query.contract !== undefined) {
    try {
      const exact = await findBlueprintExact(
        { vectorStore: deps.registry.vectorStore },
        scope,
        kind,
        expectedKey,
      );
      if (exact) {
        bumpHitBestEffort(deps.registry, scope, exact.id);
        const reason = `match-exact: contract-key equality (${exact.contractKey}). Same canonical contract — guaranteed reuse.`;
        emit({
          decision: 'match-exact',
          strategy: 'exact-key',
          reason,
          candidates: [],
          winningBlueprintId: exact.id,
        });
        return {
          strategy: 'exact-key',
          blueprint: exact,
          cosine: 1,
          reason,
        };
      }
    } catch (err) {
      // Backend errors fall through to no-match — never crash the
      // handshake on a registry hiccup.
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console -- operator-visible signal; exact-key lookup should never fail
      console.warn(`[blueprint-matcher] exact-key lookup failed: ${msg}`);
    }
    const reason =
      'no-match: contract supplied + canonical-key absent. ' +
      'Semantic-strategy fuzzy match across non-equal canonical contracts is ' +
      'structurally unsafe. Cold gen against the requested ' +
      'contract is the only structurally-safe option.';
    emit({
      decision: 'no-match',
      strategy: 'exact-key',
      reason,
      candidates: [],
    });
    return { strategy: 'no-match', reason, candidates: [] };
  }

  // ─── Strategy: semantic (agent omitted a contract) ────────────────
  // RAG top-K + LLM rerank judge. Hit ⇒ matched blueprint's contract
  // becomes the negotiated contract. Miss buckets distinguish
  // cosine-gate, no-LLM, judge-declined, low-confidence, defense.
  let candidates: readonly BlueprintCandidate[] = [];
  try {
    const ragArg: { intent: string } = { intent: trimmedIntent };
    candidates = await findBlueprintsByEmbedding(
      deps.registry,
      scope,
      ragArg,
      { kind, topK },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const reason = `no-match: RAG retrieval failed — ${msg}`;
    emit({
      decision: 'no-match',
      strategy: 'semantic',
      reason,
      candidates: [],
    });
    return { strategy: 'no-match', reason, candidates: [] };
  }

  if (candidates.length === 0) {
    const reason =
      'no-match: no candidates in scope — first registration of this kind';
    emit({
      decision: 'no-match',
      strategy: 'semantic',
      reason,
      candidates: [],
    });
    return { strategy: 'no-match', reason, candidates: [] };
  }

  const top = candidates[0]!;
  if (top.cosine < minCosine) {
    const reason = `match-skip-low-cosine: top cosine=${top.cosine.toFixed(2)} < minCosine=${minCosine}; judge skipped`;
    emit({
      decision: 'match-skip-low-cosine',
      strategy: 'semantic',
      reason,
      candidates,
    });
    return { strategy: 'no-match', reason, candidates };
  }

  if (!deps.llm) {
    const reason = `match-skip-no-llm: ${candidates.length} candidates available but no LLMCaller wired — falling through to cold generation`;
    emit({
      decision: 'match-skip-no-llm',
      strategy: 'semantic',
      reason,
      candidates,
    });
    return { strategy: 'no-match', reason, candidates };
  }

  // Run the LLM rerank judge.
  const decision = await rerankCandidates(
    { llm: deps.llm },
    {
      intent: trimmedIntent,
      contractSummary: summarizeContract(query.contract),
    },
    candidates.map((c) => ({
      id: c.blueprint.id,
      cachedIntent: c.blueprint.intent,
      cachedContractSummary: summarizeContract(c.blueprint.contract),
      cosine: c.cosine,
    })),
  );

  if (decision.matchId === null || decision.confidence < judgeThreshold) {
    const reason =
      decision.matchId === null
        ? `no-match: judge declined all ${candidates.length} candidates (confidence=${decision.confidence.toFixed(2)})`
        : `no-match-low-confidence: judge picked ${decision.matchId} but confidence=${decision.confidence.toFixed(2)} < threshold=${judgeThreshold}`;
    emit({
      decision:
        decision.matchId === null ? 'no-match' : 'no-match-low-confidence',
      strategy: 'semantic',
      reason,
      candidates,
      judgeConfidence: decision.confidence,
      judgeReason: decision.reason,
    });
    return {
      strategy: 'no-match',
      reason,
      candidates,
      judgeReason: decision.reason,
    };
  }

  const matched = candidates.find((c) => c.blueprint.id === decision.matchId);
  if (!matched) {
    // Defensive — rerankCandidates already guards against unknown ids
    // by collapsing to null, but a future change could re-introduce
    // the gap. Fail-loud.
    const reason = `no-match-judge-defense: judge picked id=${decision.matchId} but it's not in the candidate set — falling through`;
    emit({
      decision: 'no-match-judge-defense',
      strategy: 'semantic',
      reason,
      candidates,
      judgeConfidence: decision.confidence,
      judgeReason: decision.reason,
    });
    return {
      strategy: 'no-match',
      reason,
      candidates,
      judgeReason: decision.reason,
    };
  }

  bumpHitBestEffort(deps.registry, scope, matched.blueprint.id);
  const reason = `match-semantic: judge matched ${matched.blueprint.id} (cosine=${matched.cosine.toFixed(2)}, confidence=${decision.confidence.toFixed(2)}) — ${decision.reason}`;
  emit({
    decision: 'match-semantic',
    strategy: 'semantic',
    reason,
    candidates,
    winningBlueprintId: matched.blueprint.id,
    judgeConfidence: decision.confidence,
    judgeReason: decision.reason,
  });
  return {
    strategy: 'semantic',
    blueprint: matched.blueprint,
    cosine: matched.cosine,
    judgeConfidence: decision.confidence,
    reason,
  };
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
