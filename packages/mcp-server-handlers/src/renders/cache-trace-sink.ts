/**
 * Live blueprint-cache trace sink — devtools introspection of every
 * blueprint-cache lookup the generation pipeline performs.
 *
 * **Distinct from {@link LlmTraceSink}, {@link TelemetrySink}, and
 * {@link AuditSink}.**
 *   - **LLM trace** (`@ggui-ai/ui-gen/harness/llm-trace-sink`) =
 *     devtools full-payload of LLM calls.
 *   - **Telemetry** = ops signals (lossy, scalar attrs).
 *   - **Audit** = compliance log of privileged mutations.
 *   - **Cache trace** (this) = devtools-only ring buffer of every
 *     `matchBlueprint` decision: query intent, threshold,
 *     top-k candidate scores, decision (hit / miss with reason),
 *     winning blueprint id. Lossy by default. A hosted runtime may
 *     swap in a durable sink; the standalone server ships an
 *     in-memory sink the `/devtools/cache` page reads.
 *
 * **Why this lives in `mcp-server-handlers`, not `ui-gen`.** The
 * blueprint-cache matcher lives here ({@link matchBlueprint} in
 * `blueprint-matcher.ts`) — it composes
 * {@link EmbeddingProvider} + {@link VectorStore} primitives from
 * `@ggui-ai/mcp-server-core`. The sink belongs in the package that
 * does the matching, mirroring how `LlmTraceSink` lives next to the
 * Anthropic adapter that emits.
 *
 * **Why module-level registry instead of constructor injection.** The
 * matcher is invoked from inside `ggui_render`'s safely-wrapped lookup
 * helper + the cache-backed handshake negotiator. Threading a sink
 * through both call paths (handler factories, deps records) for a
 * devtools-only surface isn't worth the churn. The hosted runtime isolates
 * per request via process-pool, so a global per-pool is also safe.
 *
 * **Default = no sink.** When unset, the matcher emits nothing and
 * spends no CPU on the top-k probe. Passing `null` removes a
 * previously registered sink.
 */

/**
 * Outcome class for a blueprint-cache lookup. Two vocabularies coexist:
 *
 * **Strategy-aware (matcher — `blueprint-matcher.ts`)** — the matcher
 * BRANCHES by request shape rather than cascading through tiers. The
 * chosen strategy is recorded in `CacheTraceEvent.strategy`; the
 * decision below records the outcome.
 *
 *   - `match-exact` — exact-key strategy hit. Agent supplied a
 *     contract; canonical key matched a registered blueprint. Free,
 *     deterministic, <1ms.
 *   - `match-semantic` — semantic strategy hit. Agent omitted a
 *     contract; RAG + LLM judge accepted a candidate.
 *   - `match-skip-low-cosine` — semantic strategy: top-1 cosine below
 *     `minCosineForRerank`; judge skipped to save the LLM call.
 *   - `match-skip-no-llm` — semantic strategy: RAG returned candidates
 *     but no LLMCaller is wired (no provider key, or placeholder
 *     mode).
 *   - `no-match` — generic miss. Covers three sub-cases: empty scope
 *     (cold); judge declined every candidate (semantic); contract
 *     supplied + canonical-key absent. The exact-key strategy never
 *     falls over to semantic matching — that is a deliberate
 *     structural-safety gate.
 *   - `no-match-low-confidence` — semantic strategy: judge picked one
 *     but confidence below `judgeThreshold`. Stricter than no-match.
 *   - `no-match-judge-defense` — semantic strategy: judge returned an
 *     id not in the candidate set (defensive guard against a future
 *     rerank refactor regression).
 *   - `no-match-empty-intent` — intent was empty after trim; matcher
 *     short-circuited before strategy selection.
 *
 *   - `synth-ok` / `synth-fail` — synthesizer events. Fire on the
 *     cold path AFTER the matcher's `no-match*` event so the
 *     trace stream reads as: matcher's miss → synth's outcome.
 *     Operators correlate synth-ok's `outputContractKey` with later
 *     `match-exact` events to measure synth-output reuse rate.
 *
 *   - `push-classify` — paired-push classification event. Fires on
 *     every `ggui_render` consume. The `agentClassification` field
 *     carries `'confirm'` (decision.kind === 'accept' — agent reused
 *     the suggestion's provisional blueprintId) or `'override'`
 *     (decision.kind === 'override' — agent minted fresh against a
 *     new draft). Operators read confirm-vs-override rate to measure
 *     how often agents accept the negotiator's suggestion vs author
 *     their own. Decoupled from matcher events because the
 *     classification happens at push-time, not at handshake-time.
 *
 * **Legacy (cache-backed-negotiator fallback — `generation-cache.ts`)** —
 * intent-keyed matcher kept around for the LLM-less fallback path.
 * These codes will be removed when `cache-backed-negotiator.ts` is
 * deleted in the post-16h cleanup slice.
 *
 *   - `hit` — legacy intent-key hit.
 *   - `miss-empty-intent` / `miss-empty-scope` / `miss-below-threshold`
 *     / `miss-key-mismatch` / `miss-empty-code` — legacy miss buckets.
 */
export type CacheTraceDecision =
  | 'match-exact'
  | 'match-semantic'
  | 'match-skip-low-cosine'
  | 'match-skip-no-llm'
  | 'no-match'
  | 'no-match-low-confidence'
  | 'no-match-judge-defense'
  | 'no-match-empty-intent'
  | 'synth-ok'
  | 'synth-fail'
  | 'push-classify'
  | 'hit'
  | 'miss-empty-intent'
  | 'miss-empty-scope'
  | 'miss-below-threshold'
  | 'miss-key-mismatch'
  | 'miss-empty-code';

/**
 * Which lookup strategy the matcher selected before producing its
 * decision. Set by inspecting the request:
 *   - `'exact-key'` — agent supplied a contract; matcher does
 *     canonical-key equality lookup.
 *   - `'semantic'` — agent omitted a contract; matcher does
 *     RAG + LLM-judge fuzzy match.
 *
 * The two strategies are MUTUALLY EXCLUSIVE per request. The matcher
 * does NOT cascade from one to the other — fuzzy matching across
 * non-equal canonical contracts is structurally unsafe. Use this
 * field to filter the trace UI by which path ran.
 *
 * Absent on empty-intent short-circuits (matcher never branched) and
 * on legacy generation-cache emits.
 */
export type CacheTraceStrategy = 'exact-key' | 'semantic';

/**
 * One candidate returned by the vector store on a lookup. Carries the
 * key, cosine similarity score, and the cached intent text when
 * present in metadata. When the matcher runs without a sink only the
 * top-1 candidate is fetched; with a sink we probe top-k (default 5)
 * to give the operator UI nearby alternatives the matcher considered.
 */
export interface CacheTraceCandidate {
  readonly key: string;
  readonly score: number;
  readonly cachedIntent?: string;
}

/**
 * One blueprint-cache lookup decision. Emitted **after** the lookup
 * resolves (hit or any miss bucket) — single event, not start/end split.
 * The `at` field carries the call start; consumers can subtract
 * `durationMs` for the start time if they want.
 */
export interface CacheTraceEvent {
  /** Random per-event ID — for client-side dedupe across REST + SSE. */
  readonly id: string;
  /** Epoch ms when the lookup completed. */
  readonly at: number;
  /** Total wall-clock ms — embed + query + (optional top-k probe). */
  readonly durationMs: number;
  /** Tenant scope the matcher queried — typically `appId`. */
  readonly scope: string;
  /**
   * Trimmed intent the matcher used as input. May be truncated to
   * 4 KB by emitters to keep the ring buffer bounded; full text is
   * not the load-bearing field for the operator UI.
   */
  readonly intent: string;
  /**
   * `generationCacheKey(intent)` (legacy) or `blueprintKey(contract)`
   * (matcher) — the deterministic key a matching entry would use.
   * Empty string when no contract was supplied (semantic strategy
   * has no canonical key) or on the empty-intent short-circuit
   * (no key could be computed before strategy selection).
   */
  readonly expectedKey: string;
  /** Cosine similarity threshold that drove the hit/miss decision. */
  readonly threshold: number;
  /** Decision class — exactly one applies per event. */
  readonly decision: CacheTraceDecision;
  /**
   * Which lookup strategy the matcher selected — see
   * {@link CacheTraceStrategy}. Absent on `no-match-empty-intent`
   * (matcher never branched) and legacy generation-cache emits.
   */
  readonly strategy?: CacheTraceStrategy;
  /**
   * LLM judge confidence on a semantic-strategy match (or
   * low-confidence miss). Absent on exact-key strategy, on
   * judge-skipped sub-cases (low-cosine, no-llm), and on legacy emits.
   */
  readonly judgeConfidence?: number;
  /**
   * LLM judge's free-text reason. Surfaced on semantic-strategy misses
   * so the operator can see "why didn't this hit." Absent when no LLM
   * call was made.
   */
  readonly judgeReason?: string;
  /**
   * Sorted candidates (highest score first) the matcher considered.
   * Length 0 on `miss-empty-intent` (no query was issued) or
   * `miss-empty-scope` (no rows in scope). Otherwise length is at most
   * the configured probe size (default 5).
   */
  readonly candidates: ReadonlyArray<CacheTraceCandidate>;
  /** Set when `decision === 'hit'`. The cache key of the winning entry. */
  readonly winningBlueprintId?: string;
  /**
   * Synthesis details when the negotiator's cold path invoked the
   * contract synthesizer. Absent on:
   *   - reuse decisions (`match-exact` / `match-semantic` — synth not invoked)
   *   - LLM-less environments (synth gated on resolveLlm)
   *   - agent-authored contracts (synth not invoked when input.contract is present)
   *
   * Operators use this to track cold-path synth hit rate, latency,
   * and whether the synthesized contract later flows to a `match-exact`
   * event (the hit rate is the load-bearing metric — if synth output
   * never gets reused, the cache is fragmenting).
   */
  readonly synth?: CacheTraceSynth;
  /**
   * Findings from the contract structural validator
   * (`validateContractStructure`) — flags over-specified contracts
   * (e.g., empty-payload action whose name parses as a mutator of an
   * existing context slot, the counter-bug class). Empty array means
   * the validator ran clean; absent means the validator did NOT run
   * for this event (e.g., matcher emit sites where no contract was
   * produced). Populated on `synth-ok` and `synth-fail` events whose
   * synth path produced a contract that ran through the validator.
   *
   * Operators read finding counts as a "synth quality" signal —
   * elevated `redundant-action` rates point to a synthesizer prompt
   * regression. Each finding's `severity` distinguishes warnings
   * (heuristic, may false-positive) from errors (unambiguous).
   */
  readonly validatorFindings?: ReadonlyArray<CacheTraceValidatorFinding>;
  /**
   * Cosine distance from the nearest registered blueprint when the
   * matcher's RAG retrieval populated it (semantic-strategy hit/miss
   * with at least one candidate). Computed as `1 - top.cosine`. High
   * distance signals a novel contract the registry hasn't seen before
   * — useful for tracking whether synth output keeps producing
   * one-off shapes (registry fragmentation) or paraphrase-resilient
   * shapes (reuse rate climbs).
   *
   * Absent on:
   *   - exact-key strategy events (no RAG retrieval ran)
   *   - empty-intent / empty-scope short-circuits (no candidates)
   *   - synth events (synthesizer doesn't query the registry; the
   *     subsequent matcher event for the same intent carries it)
   */
  readonly cosineNoveltyDistance?: number;
  /**
   * Set on `push-classify` events: did the agent's `decision.kind`
   * accept the handshake suggestion (`'confirm'`) or override with a
   * fresh draft (`'override'`)? The field exists for telemetry only.
   * Absent on matcher / synth events.
   */
  readonly agentClassification?: 'confirm' | 'override';
  /**
   * Human-readable explanation. Mirrors the `reason` strings the
   * cache-backed handshake negotiator surfaces, so operators see one
   * consistent vocabulary across `/devtools/cache` and
   * `/console/sessions`.
   */
  readonly reason: string;
}

/**
 * One entry from a contract structural-validator run. Mirrors
 * `negotiator/contract-validators#ContractValidationFinding` but lives
 * here so the cache-trace transport stays pure over `@ggui-ai/protocol`
 * + this package — devtools consumers (REST snapshot, SSE stream, the
 * console SPA) don't need a hard dep on the negotiator package to read
 * findings off events.
 *
 * `kind` is open-ended (`string`) so future detectors expand the
 * vocabulary without breaking the transport.
 */
export interface CacheTraceValidatorFinding {
  readonly kind: string;
  readonly severity: 'warn' | 'error';
  readonly hint: string;
}

/** Synthesizer trace details — populated by the registry-backed
 *  negotiator when it invokes `synthesizeContract` on a cold path
 *  with no agent-authored contract. */
export interface CacheTraceSynth {
  /** Did synthesis run at all? `false` only when gated out (no LLM
   *  available). When the gate passed, fired is `true` regardless
   *  of whether the LLM succeeded — the `success` field below
   *  reports the outcome. */
  readonly fired: boolean;
  /** Did synthesis produce a usable contract? `false` when the LLM
   *  threw, the parse failed, or the safeParse gate rejected. */
  readonly success: boolean;
  /** Wall-clock ms for the synth call. */
  readonly latencyMs: number;
  /** Reason string from `SynthesizeContractResult.reason` —
   *  `synthesize-ok: <llm-reason>` on success or
   *  `synthesize-skip: …` / `synthesize-fail: …` on failure paths. */
  readonly reason: string;
  /** Canonical contract key of the synthesized contract, when
   *  successful. Lets operators cross-reference against later
   *  `tier1-hit` events to confirm the synth output got reused
   *  (vs fragmenting the registry with one-off contracts). */
  readonly outputContractKey?: string;
}

/**
 * Sink that receives one event per cache lookup. Implementations MUST
 * be sync + non-throwing — the matcher fires events on the hot path
 * and cannot tolerate backpressure or rejected promises. Buffer + drop
 * or fan out to a queue inside the implementation.
 */
export interface CacheTraceSink {
  emit(event: CacheTraceEvent): void;
}

let activeSink: CacheTraceSink | null = null;

/**
 * Register the active sink. Pass `null` to remove. Subsequent
 * {@link emitCacheTraceEvent} calls dispatch to this sink.
 */
export function setCacheTraceSink(sink: CacheTraceSink | null): void {
  activeSink = sink;
}

/** Read the active sink. Mostly for tests. */
export function getCacheTraceSink(): CacheTraceSink | null {
  return activeSink;
}

/**
 * Internal — used by {@link matchBlueprint}. No-op when no sink
 * is registered. Swallows sink-thrown errors (a broken devtools sink
 * must not break generation).
 */
export function emitCacheTraceEvent(event: CacheTraceEvent): void {
  const sink = activeSink;
  if (!sink) return;
  try {
    sink.emit(event);
  } catch {
    // Devtools sink is allowed to be buggy — generation must not die.
  }
}

/**
 * A sink that writes each event as a single-line JSON record to
 * `console.error`, prefixed `[ggui:cache-trace] `. Intended as an
 * env-gated diagnostic so the matcher's decision (and the reason it
 * landed there) is visible in a server's captured stderr — e.g. a
 * container run that needs to see WHY a semantic match missed.
 *
 * Only the decision-relevant fields are projected (decision, strategy,
 * reason, cosine novelty distance, judge confidence + reason, winning
 * blueprint id, scope, intent). Fields absent on the event are omitted
 * from the JSON rather than emitted as `undefined`, so each line stays
 * compact + greppable.
 *
 * Sync + non-throwing, per the {@link CacheTraceSink} contract — a
 * stringify or write failure must never sink generation, so it is
 * swallowed.
 */
export function createStderrCacheTraceSink(): CacheTraceSink {
  return {
    emit(event: CacheTraceEvent): void {
      try {
        const record: Record<string, unknown> = {
          decision: event.decision,
          reason: event.reason,
          scope: event.scope,
          intent: event.intent,
        };
        if (event.strategy !== undefined) record['strategy'] = event.strategy;
        if (event.cosineNoveltyDistance !== undefined) {
          record['cosineNoveltyDistance'] = event.cosineNoveltyDistance;
        }
        if (event.judgeConfidence !== undefined) {
          record['judgeConfidence'] = event.judgeConfidence;
        }
        if (event.judgeReason !== undefined) {
          record['judgeReason'] = event.judgeReason;
        }
        if (event.winningBlueprintId !== undefined) {
          record['winningBlueprintId'] = event.winningBlueprintId;
        }
        // eslint-disable-next-line no-console -- env-gated diagnostic stderr sink.
        console.error(`[ggui:cache-trace] ${JSON.stringify(record)}`);
      } catch {
        // A diagnostic sink must never break generation — swallow.
      }
    },
  };
}

/**
 * Crockford-style random ID. Mirrors `newLlmTraceId` so both devtools
 * surfaces share the same dedupe-by-id contract on the client.
 */
export function newCacheTraceId(): string {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10)
  );
}

/** Probe size used when a sink is registered — top-K candidates fetched for diagnostic. */
export const CACHE_TRACE_PROBE_SIZE = 5;

/**
 * Cap on `intent` payload size in trace events. 4 KB is well above
 * typical "hello" / "render a weather card" prompts and well below the
 * point where ring-buffer memory becomes a concern (200 events × 4 KB
 * = 800 KB peak). Long blob prompts (paste-the-spec patterns) get
 * truncated with a trailing marker so the operator sees the cap was hit.
 */
export const CACHE_TRACE_INTENT_MAX_BYTES = 4096;

/**
 * Truncate `intent` to {@link CACHE_TRACE_INTENT_MAX_BYTES} for a trace
 * event. The trailing `…[truncated]` marker is human-readable in the
 * console UI without further parsing.
 */
export function truncateCacheTraceIntent(intent: string): string {
  if (intent.length <= CACHE_TRACE_INTENT_MAX_BYTES) return intent;
  return `${intent.slice(0, CACHE_TRACE_INTENT_MAX_BYTES)}…[truncated]`;
}
