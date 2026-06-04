/**
 * A2UI bench v0 schema.
 *
 * Exercises the provisional-preview path end-to-end:
 * `kickoffProvisionalPreview` → deterministic emitter → A2UI frames
 * over the `_ggui:preview` channel → terminal outcome. On each
 * intercepted frame we run `parseServerMessage` so parse
 * pass/fail accounting is real, not synthetic.
 *
 * Scope narrower than the render SLO (`../slo/`):
 *   - no final-compile checkpoint (that's SLO's job)
 *   - no DOM-visible checkpoint (reserved for v0.5 renderer harness)
 *   - no LLM — the deterministic emitter is the only producer today
 *
 * Null handling mirrors SLO: `firstFrameAt`/`previewFinalizedAt`
 * stay null when no preview ran. Reports surface the null count as
 * first-class signal.
 *
 * Stats: min/median/max. p50/p95 is corpus-size fraud at n≤5/case;
 * promoted later when the seed expands.
 */

/**
 * The four A2UI checkpoints + one reserved slot. v0 populates the
 * first two (startedAt, firstFrameAt); previewFinalizedAt fires on
 * the terminal outcome; handoffGapMs is reserved and ALWAYS null
 * until the hosted post-compile path calls
 * `finalizeProvisionalPreview`. Typing `handoffGapMs` as `null` (not
 * `number | null`) prevents accidental writes in v0.
 */
export interface A2uiCheckpoints {
  /** Clock reading at runner entry. Always present. */
  readonly startedAt: number;
  /**
   * Clock reading when the FIRST A2UI frame was accepted by the
   * intercepting `sendEnvelope`. `null` when:
   *   - case configured no emitter (minimal/legitimately-absent path)
   *   - emitter ran but signal aborted before first emit
   *   - emitter errored before first emit
   * This stays a load-bearing null across the whole bench.
   */
  readonly firstFrameAt: number | null;
  /**
   * Clock reading on the terminal outcome (`completed` / `failed` /
   * `cancelled` — `finishedAt` field). Null only when no preview
   * ran at all. Can be non-null while `firstFrameAt` is null (the
   * "emitter ran but never landed a frame" edge).
   */
  readonly previewFinalizedAt: number | null;
  /**
   * Reserved for v0.5. Always null in v0. Observable only when the
   * hosted post-compile handler calls `finalizeProvisionalPreview`
   * AND we can also observe the matching "final UI code ready"
   * moment from the render path — neither exists on OSS today. The
   * schema slot is pre-allocated so v0.5 doesn't require a report
   * migration.
   */
  readonly handoffGapMs: null;
}

/**
 * Per-frame accounting. Populated by the runner's wrapped
 * `sendEnvelope`: every intercepted payload runs through
 * `parseServerMessage` and lands in either `parsePassCount` or
 * `parseFailCount`. `frameCount === parsePassCount + parseFailCount`
 * is the invariant the summarizer relies on.
 */
export interface A2uiFrameAccounting {
  /** Total frames the emitter produced (accepted by transport). */
  readonly frameCount: number;
  /** Frames whose payload passed `parseServerMessage`. */
  readonly parsePassCount: number;
  /**
   * Frames whose payload FAILED `parseServerMessage`. Non-zero is
   * the primary regression signal the bench exists to surface. If
   * this number ever moves up without an intentional emitter change,
   * something is wrong with either the emitter OR the parser.
   */
  readonly parseFailCount: number;
}

/**
 * Corpus-driven shape of the intent the emitter sees. The
 * deterministic emitter's `pickShell` heuristic routes each intent
 * into one of three outcomes (form / list / minimal). We tag the
 * case shape here so the summarizer can group meaningfully:
 *
 *   - `form`     — intent matched the form-like regex, emitter
 *                  returns a form shell + inputs
 *   - `list`     — intent matched the list-like regex, emitter
 *                  returns a list shell + rows
 *   - `minimal`  — intent matched NEITHER regex, emitter returns
 *                  only the heading/body skeleton (still 4 frames,
 *                  but fewer components per frame).
 */
export type A2uiIntentShape = 'form' | 'list' | 'minimal';

export interface A2uiRunTags {
  readonly caseId: string;
  readonly intentShape: A2uiIntentShape;
  /**
   * Whether the case configured an emitter + expected preview
   * frames. Distinct from {@link previewObserved}: this is the
   * corpus's intent, not the run's observation.
   */
  readonly previewExpected: boolean;
  /**
   * Whether the harness observed at least one frame (i.e.,
   * `firstFrameAt !== null`). A run with `previewExpected` true but
   * `previewObserved` false is the regression signal.
   */
  readonly previewObserved: boolean;
  /**
   * Whether the runner saw a terminal outcome
   * (`completed`/`failed`/`cancelled`). On the happy path this is
   * always true; if the emitter hangs, we'd see this false and
   * `previewFinalizedAt === null`.
   */
  readonly finalizeObserved: boolean;
}

/** Durations derived from {@link A2uiCheckpoints} with strict null propagation. */
export interface A2uiDerivedMetrics {
  readonly timeToFirstFrame: number | null;
  readonly timeToPreviewFinalize: number | null;
  /**
   * `parsePassCount / frameCount`, or `null` when `frameCount === 0`
   * (no frames means no ratio — don't fabricate 1.0 from 0/0).
   */
  readonly parsePassRate: number | null;
  /**
   * `frameCount` when `previewFinalizedAt !== null`, else null.
   * Answers "how many frames landed before the emitter finalized"
   * as a scalar without requiring the reader to cross-reference
   * tag + accounting.
   */
  readonly framesBeforeFinalize: number | null;
}

export interface A2uiRunResult {
  readonly caseId: string;
  readonly runIndex: number;
  readonly checkpoints: A2uiCheckpoints;
  readonly frames: A2uiFrameAccounting;
  readonly tags: A2uiRunTags;
  readonly derived: A2uiDerivedMetrics;
  /**
   * Parse-fail issue snippets, up to 3 per run. Useful for quick
   * triage when `parseFailCount > 0` — the operator shouldn't need
   * to re-run with verbose logging to see WHAT failed.
   */
  readonly parseIssueSamples: readonly string[];
  /** Runtime errors (handler throws, outcome failures). */
  readonly errors: readonly string[];
}

/** Per-metric min/median/max + null count. Same shape as SLO's, duplicated
 * intentionally — later extraction to `@ggui-ai/benchmarks` moves both. */
export interface A2uiMinMedianMax {
  readonly count: number;
  readonly nullCount: number;
  readonly min: number | null;
  readonly median: number | null;
  readonly max: number | null;
}

/**
 * Aggregate per intent-shape. v0 groups by `intentShape` rather
 * than `caseId` so a future corpus with multiple form cases
 * aggregates without schema churn.
 */
export interface A2uiShapeSummary {
  readonly intentShape: A2uiIntentShape;
  readonly runs: number;
  readonly timeToFirstFrame: A2uiMinMedianMax;
  readonly timeToPreviewFinalize: A2uiMinMedianMax;
  readonly frameCount: A2uiMinMedianMax;
  readonly parsePassRate: A2uiMinMedianMax;
  /**
   * Runs where `previewExpected && !previewObserved` — the bench's
   * primary regression signal. Zero on a healthy run.
   */
  readonly previewExpectedButMissingCount: number;
  /**
   * Runs where `parseFailCount > 0`. Surfaces which shape is
   * driving parse regressions when they appear.
   */
  readonly runsWithParseFailures: number;
  /** Total parse failures across runs in this shape. */
  readonly totalParseFailures: number;
}

export interface A2uiReport {
  readonly schemaVersion: 'a2ui.v0';
  readonly generatedAt: string;
  /** v0-seed label — display-side formatters should keep this visible. */
  readonly floorLabel: 'v0-seed';
  /**
   * Honesty notes embedded on every report so single JSON files
   * are self-describing. See `./README.md` for the long form.
   */
  readonly notes: readonly string[];
  readonly results: readonly A2uiRunResult[];
  readonly summary: readonly A2uiShapeSummary[];
}

/**
 * Central derivation — runner, tests, and any future re-aggregator
 * share this so null propagation can't diverge.
 */
export function deriveA2uiMetrics(
  cp: A2uiCheckpoints,
  frames: A2uiFrameAccounting,
): A2uiDerivedMetrics {
  return {
    timeToFirstFrame:
      cp.firstFrameAt === null ? null : cp.firstFrameAt - cp.startedAt,
    timeToPreviewFinalize:
      cp.previewFinalizedAt === null
        ? null
        : cp.previewFinalizedAt - cp.startedAt,
    parsePassRate:
      frames.frameCount === 0 ? null : frames.parsePassCount / frames.frameCount,
    framesBeforeFinalize:
      cp.previewFinalizedAt === null ? null : frames.frameCount,
  };
}
