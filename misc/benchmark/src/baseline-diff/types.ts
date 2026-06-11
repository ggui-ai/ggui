/**
 * Baseline-diff schema — compares two `BenchBaselineManifest`
 * bundles and surfaces per-bench deltas without inventing a
 * cross-bench composite score.
 *
 * Discipline:
 *   - Tolerant of schema drift. A field missing on either side
 *     produces `null`, never a crash.
 *   - No normalization across benches. Each bench's summary is
 *     diffed against itself; rows match by the bench's own
 *     key field (`path`, `generator`, `intentShape`, `registryMode`).
 *   - Exit code reflects invocation validity, NOT whether the
 *     after-bundle shows regressions. Regressions live in the
 *     JSON output.
 */

import type { BenchName, BenchStatus } from '../baseline/manifest.js';

/**
 * Pair-wise status transition between before and after. Six
 * explicit values — no "unknown" catch-all, because missing entries
 * on one side are either `added` or `removed` and nothing else.
 */
export type StatusChange =
  | 'same-success'
  | 'same-failed'
  | 'regressed' // success → failed
  | 'recovered' // failed → success
  | 'added' // not in before
  | 'removed'; // not in after

/**
 * One-field delta. `kind: 'scalar'` for plain numbers; `kind: 'stat'`
 * for nested `{min, median, max, count, nullCount}` objects the
 * four benches use for latency bands.
 *
 * `before`/`after` stay null when the side was missing or its field
 * was structurally incompatible (e.g., the bench's schema grew a
 * field since the before-bundle was written). Consumers read the
 * null as "no comparable data" — they should not coalesce to zero.
 */
export type FieldDelta =
  | {
      readonly kind: 'scalar';
      readonly before: number | null;
      readonly after: number | null;
      readonly delta: number | null;
    }
  | {
      readonly kind: 'stat';
      readonly before: StatBand | null;
      readonly after: StatBand | null;
      /** `after.median - before.median`. Null when either side absent. */
      readonly deltaMedian: number | null;
      /** `after.min - before.min`. Null when either side absent. */
      readonly deltaMin: number | null;
      /** `after.max - before.max`. Null when either side absent. */
      readonly deltaMax: number | null;
    }
  | {
      readonly kind: 'missing';
      /** The field was absent from both sides — or one side had a
       *  structurally weird value (e.g., a string where a number was
       *  expected). Never propagates silently; always shows up on
       *  the row's notes array.
       */
      readonly reason: string;
    };

/** Pass-through of `SloMinMedianMax` / `A2uiMinMedianMax` — same
 *  shape across all benches. */
export interface StatBand {
  readonly count: number;
  readonly nullCount: number;
  readonly min: number | null;
  readonly median: number | null;
  readonly max: number | null;
}

/**
 * One group row's diff. `key` is whatever value occupied the group's
 * key field — for slo, e.g. `'blueprint_hit'`; for multi-sdk, a
 * generator slug like `'ui-gen-default-haiku-4-5'`.
 *
 * `presence` is row-level: the row may exist on both sides, only the
 * after side (`'added'` — a new group surfaced), or only the before
 * side (`'removed'`).
 */
export interface RowDiff {
  readonly key: string;
  readonly presence: 'both' | 'added' | 'removed';
  /**
   * Keyed by field name (e.g., `'runs'`, `'hitRate'`,
   * `'timeToFirstFrame'`). Only includes fields the bench's diff
   * spec surfaces; irrelevant fields in the raw report are not
   * propagated here — keeps the diff compact.
   */
  readonly fields: Readonly<Record<string, FieldDelta>>;
}

/**
 * Per-bench summary diff. `kind: 'grouped'` is the only shape v0
 * supports because all four benches share the "grouped-by-key" shape.
 * The union leaves room for a `'flat'` variant later without
 * breaking current consumers.
 */
export type SummaryDiff = {
  readonly kind: 'grouped';
  /** Bench-specific key field name (`path`/`generator`/etc.). */
  readonly keyField: string;
  readonly rows: readonly RowDiff[];
};

/**
 * Per-bench diff entry. Mirrors the manifest's entry shape but
 * doubles every side-specific field.
 */
export interface BenchDiffEntry {
  readonly benchName: BenchName;
  readonly beforeStatus: BenchStatus | null;
  readonly afterStatus: BenchStatus | null;
  readonly statusChange: StatusChange;
  /**
   * Present only when both sides succeeded AND both sides had a
   * diffable summary. `null` otherwise — including on `same-success`
   * when one side's summary was unreadable (e.g., schema drift).
   */
  readonly summaryDiff: SummaryDiff | null;
  /**
   * Free-form notes: schema-version mismatch warnings, missing
   * summary fields, bundle-read failures. Always populated
   * alongside any `null` result so the reader understands WHY it's
   * null.
   */
  readonly notes: readonly string[];
}

export interface BenchBaselineDiff {
  readonly schemaVersion: 'bench-baseline-diff.v0';
  readonly beforeBaselineId: string;
  readonly afterBaselineId: string;
  readonly beforeTimestamp: string;
  readonly afterTimestamp: string;
  readonly beforeGitSha: string | null;
  readonly afterGitSha: string | null;
  /**
   * Honesty notes on the diff as a whole. Examples:
   *   - "baselines differ in schemaVersion — some fields may not map"
   *   - "before-bundle is missing reports for 2 benches"
   * Self-describing so a single diff JSON can be read without
   * context.
   */
  readonly notes: readonly string[];
  readonly benchDiffs: readonly BenchDiffEntry[];
}
