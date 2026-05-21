/**
 * SLO v0 schema for `ggui_push`.
 *
 * SLO-first discipline: measure the user-facing push path end-to-end,
 * let later per-dimension benches (A2UI, blueprint negotiation, ui-gen
 * floors) earn their existence by explaining movement in this report.
 *
 * v0 scope (deliberately narrow — see ./README.md for rationale):
 *
 *   - 4 active checkpoints + 1 reserved placeholder
 *   - null preview timestamps are first-class signal ("push completed
 *     without ever rendering a preview frame"), not defensive nones
 *   - min/median/max aggregation only — corpus is too small for p95
 *
 * Schema-version field is pinned so future v0.5+ can co-exist in the
 * same reports dir without schema ambiguity.
 */

/**
 * The four clock stamps recorded per push. `startedAt` is the only
 * checkpoint guaranteed non-null; every downstream stamp may be
 * absent depending on the branch + v0 OSS-Slice-A limits documented
 * alongside the fields.
 */
export interface SloCheckpoints {
  /**
   * Monotonic clock reading at push-handler entry. Anchor for every
   * derived metric. Always present.
   */
  readonly startedAt: number;
  /**
   * Clock reading when the FIRST provisional-preview frame was
   * accepted by the transport (sourced from the
   * `ProvisionalPreviewOutcome`'s `first-frame` event).
   *
   * `null` means: the push completed without ever emitting a preview
   * frame. This is a load-bearing signal — typical causes are
   *   - no emitter wired (`oss_miss` branch)
   *   - gate skipped (MCP Apps push or disabled feature flag)
   *   - emitter errored / cancelled before first `emit()` returned
   * Callers MUST NOT coalesce this to `finalCompiledAt`; the
   * null-vs-number distinction is the whole point.
   */
  readonly firstPreviewAt: number | null;
  /**
   * Clock reading on the terminal preview outcome (`completed` /
   * `failed` / `cancelled` → `finishedAt` field). `null` when no
   * preview ran at all (same absences as `firstPreviewAt`).
   *
   * Can be non-null while `firstPreviewAt` is null — that's the
   * "ran but never landed a frame" case (emitter started and
   * finished cleanly without calling `emit`). Rare but legitimate.
   */
  readonly previewFinalizedAt: number | null;
  /**
   * Clock reading when the push handler's final compile step
   * settled.
   *
   * **Honesty flag:** the open-source build defers stack-item
   * compilation for the component-push path. For story-path pushes
   * the handler returns synchronously with `codeReady: false` and no
   * actual compile ran. We record the handler-return clock anyway —
   * it's the current user-observable "final" moment — and gate
   * interpretation on {@link SloRunTags.finalCompiledReliable}. When
   * real compile wiring lands, this field starts reflecting a
   * genuine compile-settled moment and the reliability flag flips
   * true.
   */
  readonly finalCompiledAt: number | null;
  /**
   * Reserved placeholder — v0 never populates. Slot exists so v0.5
   * can add a DOM-visible checkpoint without breaking the report
   * schema. Typed as `null` (not `number | null`) to prevent
   * accidental writes in v0 harness code.
   */
  readonly finalDomVisibleAt: null;
}

/**
 * Branch identifier. Matches the user's three-branch brief.
 *
 * **Caveat:** the open-source push handler does not branch on
 * blueprint hit/miss — stack-item generation is not wired into the
 * push path in the open-source build. The SLO harness simulates the
 * branches via emitter shape + wiring flags so the measurement
 * infrastructure is ready when the real branch logic lands. See
 * `./README.md` and `./corpus.ts`.
 */
export type SloBranchPath = 'blueprint_hit' | 'generation_miss' | 'oss_miss';

/**
 * Run-level metadata describing WHICH branch we drove the harness
 * into. Mix of raw counts + boolean classification tags so reporter
 * + summarizer can slice without re-deriving from the outcome event
 * trail.
 */
export interface SloRunTags {
  readonly path: SloBranchPath;
  /**
   * Number of preview frames the emitter landed. `0` when no emitter
   * ran OR when emitter ran but never called `emit()`.
   */
  readonly previewFrames: number;
  /**
   * Simulation flag — `true` when the case was configured to behave
   * like a blueprint hit (fast single-frame preview). When real
   * blueprint branch logic wires up, this becomes sourced from the
   * handler's blueprint-finder decision.
   */
  readonly usedBlueprint: boolean;
  /**
   * Simulation flag — `true` when the case was configured to behave
   * like a generation-miss (multi-frame preview simulating a ui-gen
   * loop).
   */
  readonly usedGeneration: boolean;
  /**
   * Whether the corpus case configured an emitter + expected
   * preview frames. Distinct from `previewObserved`: this is the
   * planned behavior, not the observed behavior.
   */
  readonly previewExpected: boolean;
  /**
   * Whether the harness actually observed `firstFrameAt` on the
   * outcome stream. `previewExpected && !previewObserved` is a
   * regression signal.
   */
  readonly previewObserved: boolean;
  /**
   * Honesty flag — `false` in the open-source build. When `false`,
   * `checkpoints.finalCompiledAt` is the handler-return moment, not
   * a real post-compile moment. Reports must surface this so "fast
   * finalCompiledAt" is not mistaken for a win.
   */
  readonly finalCompiledReliable: boolean;
}

/**
 * Derived durations computed from {@link SloCheckpoints}. Kept
 * alongside raw stamps so summarizers + report consumers never have
 * to re-derive. Null propagates: if any input stamp is null, the
 * derived metric is null.
 */
export interface SloDerivedMetrics {
  /** `firstPreviewAt - startedAt`. Null iff `firstPreviewAt` null. */
  readonly timeToFirstPreview: number | null;
  /** `previewFinalizedAt - startedAt`. Null iff `previewFinalizedAt` null. */
  readonly timeToPreviewFinalize: number | null;
  /** `finalCompiledAt - startedAt`. Null iff `finalCompiledAt` null. */
  readonly timeToFinalCompiled: number | null;
  /** Reserved for v0.5. Always null in v0. */
  readonly timeToFinalVisible: null;
}

/**
 * One row of the SLO report — one push invocation, one case, one
 * run-index.
 */
export interface SloRunResult {
  /** Corpus case id (stable identifier across runs). */
  readonly caseId: string;
  /** Zero-based run index within this case for this report. */
  readonly runIndex: number;
  readonly checkpoints: SloCheckpoints;
  readonly tags: SloRunTags;
  readonly derived: SloDerivedMetrics;
  /**
   * Any outcome failures, handler throws, or invariant violations
   * observed during the run. Non-fatal runs still appear in the
   * report (so null-propagation math stays honest); fatal runs that
   * never reached `startedAt` do not produce a result at all.
   */
  readonly errors: readonly string[];
}

/**
 * Per-metric min/median/max bucket. `nullCount` tracks how many runs
 * contributed no value — load-bearing signal on the null-as-data
 * convention, not a defensive counter.
 */
export interface SloMinMedianMax {
  /** Number of non-null samples that went into min/median/max. */
  readonly count: number;
  /** Number of runs where this metric was null. */
  readonly nullCount: number;
  readonly min: number | null;
  readonly median: number | null;
  readonly max: number | null;
}

/**
 * Aggregate per branch path. Summarizer groups runs by
 * {@link SloRunTags.path} then reduces each metric column.
 */
export interface SloPathSummary {
  readonly path: SloBranchPath;
  readonly runs: number;
  readonly timeToFirstPreview: SloMinMedianMax;
  readonly timeToPreviewFinalize: SloMinMedianMax;
  readonly timeToFinalCompiled: SloMinMedianMax;
  /** `count` is included so reports show emitted-frame distribution. */
  readonly previewFrames: SloMinMedianMax;
  /** Runs where `tags.previewObserved === true`. */
  readonly previewObservedCount: number;
  /** Runs where `tags.previewExpected && !tags.previewObserved`. */
  readonly previewExpectedButMissingCount: number;
}

/**
 * Top-level report document persisted under
 * `core/src/benchmarks/slo/reports/slo-<iso>.json`.
 */
export interface SloReport {
  /** Pinned so later v0.5+ schemas can co-exist in the reports dir. */
  readonly schemaVersion: 'slo.v0';
  /** ISO timestamp of report generation. */
  readonly generatedAt: string;
  /**
   * Floor label. v0 is explicitly a floor harness — min/median/max
   * are NOT p50/p95. Display-side formatters must keep this visible
   * so readers don't overinterpret a 3×n sample.
   */
  readonly floorLabel: 'v0-seed';
  /**
   * Honesty notes that apply to the WHOLE report. Examples:
   *   - "finalCompiledAt reflects handler-return (compile deferred in the open-source build)"
   *   - "blueprint_hit / generation_miss are emitter-simulated; real branch wiring lands later"
   *   - "preview timestamps null means no frame landed — load-bearing"
   * Kept on the report (not in README only) so any single JSON file
   * is self-describing.
   */
  readonly notes: readonly string[];
  readonly results: readonly SloRunResult[];
  readonly summary: readonly SloPathSummary[];
}

/**
 * Compute {@link SloDerivedMetrics} from {@link SloCheckpoints} with
 * strict null propagation. Centralized so the runner, tests, and any
 * future re-aggregator can't disagree on the derivation.
 */
export function deriveMetrics(cp: SloCheckpoints): SloDerivedMetrics {
  return {
    timeToFirstPreview:
      cp.firstPreviewAt === null ? null : cp.firstPreviewAt - cp.startedAt,
    timeToPreviewFinalize:
      cp.previewFinalizedAt === null
        ? null
        : cp.previewFinalizedAt - cp.startedAt,
    timeToFinalCompiled:
      cp.finalCompiledAt === null ? null : cp.finalCompiledAt - cp.startedAt,
    timeToFinalVisible: null,
  };
}
