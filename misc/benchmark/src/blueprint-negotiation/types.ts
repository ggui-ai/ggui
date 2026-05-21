/**
 * Blueprint-negotiation bench v0 — schema.
 *
 * Measures the **decision layer** that fires BEFORE generation:
 *   - did we retrieve the right blueprint?
 *   - did we miss cleanly?
 *   - did we choose the right registry mode?
 *   - how long did the decision take?
 *
 * Labeled-corpus style, not a performance matrix. Every case carries
 * a pre-registered expected outcome — the bench reports are right/
 * wrong counts plus timing, not LLM-graded quality scores.
 *
 * Out of scope (keep the bench pre-generation):
 *   - no ui-gen output, no component code, no compile step
 *   - no LLM grading
 *   - no A2UI / preview observables
 *   - multi-registry arbitration (not benchable in the current
 *     codepath — see `./README.md`)
 */

/**
 * Which registry shape the case drives through the negotiator.
 *
 * `hosted` — pre-populated vector store (matches hosted deployment's
 *            DDB-backed RAG layer from the caller's perspective).
 *            Used for cases that should produce a hit.
 * `oss`    — pre-populated in-memory store without the hosted
 *            SaaS shortcuts. Shape-compatible with `hosted` today;
 *            separate tag so the report surface is ready for when
 *            the two diverge (e.g., different ranking or latency
 *            profiles).
 * `empty`  — no entries indexed. First-class v0 case — a clean miss
 *            on empty is a SUCCESS, not a failure.
 */
export type RegistryMode = 'hosted' | 'oss' | 'empty';

/** What the case author labeled the expected outcome. */
export type ExpectedOutcome = 'hit' | 'miss';

/**
 * What the bench actually observed. Four mutually-exclusive values —
 * `wrong_hit` is DELIBERATELY distinct from `miss` so the report
 * can surface "retrieved the WRONG blueprint" separately from
 * "retrieved nothing." Collapsing the two would hide the most
 * dangerous false-positive regression class.
 */
export type ObservedOutcome = 'hit' | 'miss' | 'wrong_hit' | 'error';

/**
 * Error classes the bench distinguishes. Open union — only the
 * reliably-observable classes have names; everything else falls to
 * `'other'`.
 */
export type ErrorClass =
  | 'embedding_failed'
  | 'vector_query_failed'
  | 'llm_failed'
  | 'timeout'
  | 'other';

/**
 * Two timing observables per run. v0 keeps checkpoints narrow —
 * `decisionStartedAt` / `decisionCompletedAt` give total decision
 * latency; the breakdown (embedding / search / LLM) lives on
 * {@link NegotiationStageLatencies} so it doesn't clutter the
 * checkpoint schema.
 */
export interface NegotiationCheckpoints {
  readonly decisionStartedAt: number;
  readonly decisionCompletedAt: number;
}

/**
 * Per-stage latencies straight from `NegotiateResult`. The
 * negotiator exposes these first-class; the runner copies them
 * through verbatim so report consumers can drill into which stage
 * drove a regression.
 *
 * `decisionLatencyMs` is 0 on the fast-path (RAG exact match
 * skips the LLM). v0 surfaces that as-is; the reader interprets
 * zero as "fast-path fired," not "LLM was free."
 */
export interface NegotiationStageLatencies {
  readonly embeddingLatencyMs: number;
  readonly searchLatencyMs: number;
  readonly decisionLatencyMs: number;
}

export interface NegotiationRunTags {
  readonly caseId: string;
  readonly registryMode: RegistryMode;
  readonly expectedOutcome: ExpectedOutcome;
  readonly observedOutcome: ObservedOutcome;
  readonly expectedBlueprintId: string | null;
  readonly observedBlueprintId: string | null;
  /**
   * v0 NEVER observes arbitration because multi-registry isn't
   * benchable today. Schema slot reserved for v0.5 when
   * `negotiate()` supports plural sources — see README.
   */
  readonly arbitrationObserved: false;
  /**
   * v0 ALWAYS null — the negotiator doesn't surface numeric
   * confidence on its result (internal-only). When the public
   * result grows a confidence field, this becomes number | null.
   */
  readonly confidence: null;
  readonly errorClass: ErrorClass | null;
}

export interface NegotiationDerivedMetrics {
  /** `decisionCompletedAt - decisionStartedAt`. Always present. */
  readonly decisionTimeMs: number;
  /**
   * `true` iff observed === expected AND the matched blueprint is
   * the expected one. False on `miss`/`wrong_hit`/`error` or on
   * unexpected hits.
   */
  readonly outcomeCorrect: boolean;
}

export interface NegotiationRunResult {
  readonly caseId: string;
  readonly runIndex: number;
  readonly checkpoints: NegotiationCheckpoints;
  readonly stageLatencies: NegotiationStageLatencies;
  readonly tags: NegotiationRunTags;
  readonly derived: NegotiationDerivedMetrics;
  /** Runtime errors captured during the run (non-fatal per-run data). */
  readonly errors: readonly string[];
}

// ─── Summary ───────────────────────────────────────────────────────

/** Shared min/median/max shape with explicit null-count tracking. */
export interface NegotiationMinMedianMax {
  readonly count: number;
  readonly nullCount: number;
  readonly min: number | null;
  readonly median: number | null;
  readonly max: number | null;
}

/**
 * Aggregate per registry mode. Grouping by mode — not by case id —
 * matches the "empty registry is a first-class success" discipline:
 * the reader sees how the negotiator behaves under each regime,
 * not how individual cases performed.
 */
export interface NegotiationModeSummary {
  readonly registryMode: RegistryMode;
  readonly runs: number;
  /**
   * Runs where `observedOutcome === 'hit'`. Over total runs.
   * Non-obvious interpretation on `empty` mode: a non-zero hit rate
   * is a BUG (shouldn't be able to hit from an empty store).
   */
  readonly hitRate: number;
  /**
   * Runs where we expected a miss but observed any kind of hit
   * (`hit` or `wrong_hit`) — over runs where expected = 'miss'.
   * null when no miss-expected runs exist in the group.
   */
  readonly falsePositiveRate: number | null;
  /**
   * Runs where we expected a hit but observed `miss` — over runs
   * where expected = 'hit'. null when no hit-expected runs exist.
   */
  readonly falseNegativeRate: number | null;
  /**
   * On observed hits, fraction where `observedBlueprintId ===
   * expectedBlueprintId`. Distinct from hitRate: a negotiator that
   * reliably retrieves SOMETHING but the wrong blueprint scores 1.0
   * hit-rate and 0.0 exact-match-rate. null when no observed hits.
   */
  readonly exactMatchRateOnHits: number | null;
  /**
   * Specifically for `empty` mode: fraction of runs that correctly
   * observed a miss. Reported ONLY on the empty-mode row (null
   * elsewhere) so the success-on-empty invariant is explicit.
   */
  readonly emptyRegistryCleanMissRate: number | null;
  /** Fraction of runs with `observedOutcome === 'wrong_hit'`. */
  readonly wrongHitRate: number;
  /** Fraction of runs with `observedOutcome === 'error'`. */
  readonly errorRate: number;
  /**
   * Multi-registry is not benchable in v0 — this is ALWAYS 0
   * across all modes. Schema slot reserved for v0.5.
   */
  readonly arbitrationCorrectnessRate: 0;
  readonly decisionTimeMs: NegotiationMinMedianMax;
}

export interface NegotiationReport {
  readonly schemaVersion: 'blueprint-negotiation.v0';
  readonly generatedAt: string;
  readonly floorLabel: 'v0-seed';
  readonly notes: readonly string[];
  readonly results: readonly NegotiationRunResult[];
  readonly summary: readonly NegotiationModeSummary[];
}

// ─── Derivation ────────────────────────────────────────────────────

/**
 * Central metrics derivation. Shared between runner and tests so
 * interpretation of correctness + timing stays single-sourced.
 */
export function deriveNegotiationMetrics(
  cp: NegotiationCheckpoints,
  tags: NegotiationRunTags,
): NegotiationDerivedMetrics {
  const decisionTimeMs = cp.decisionCompletedAt - cp.decisionStartedAt;
  const observedCorrectly =
    (tags.expectedOutcome === 'miss' && tags.observedOutcome === 'miss') ||
    (tags.expectedOutcome === 'hit' &&
      tags.observedOutcome === 'hit' &&
      tags.observedBlueprintId !== null &&
      tags.observedBlueprintId === tags.expectedBlueprintId);
  return {
    decisionTimeMs,
    outcomeCorrect: observedCorrectly,
  };
}
