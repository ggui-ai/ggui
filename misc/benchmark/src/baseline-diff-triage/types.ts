/**
 * Baseline-diff triage — schema.
 *
 * Classifies each item in a `BenchBaselineDiff` into one of four
 * severity buckets so downstream consumers (CI wiring, dashboards)
 * can act on the signal without re-deriving policy.
 *
 * Discipline:
 *   - `baseline-diff` is NEUTRAL — no policy, no thresholds, no gating.
 *     All policy lives here in triage.
 *   - No composite cross-bench score. Each item keeps its bench of
 *     origin and its own units.
 *   - Thresholds are centralized in `./policy.ts` and tagged with the
 *     calibration anchor that justifies each one.
 *   - `alert` is the gate: any alert → exit 1. Everything else is
 *     reportable but non-blocking.
 */

import type { BenchName, BenchStatus } from '../baseline/manifest.js';
import type { StatusChange } from '../baseline-diff/types.js';

/**
 * Four severity buckets. Ordered high → low:
 *
 *   `alert`         — CI-worthy. Always surface. Drives exit 1.
 *   `notice`        — surface but do not block. Meaningful drift
 *                     below the alert threshold.
 *   `suppressed`    — below the noise floor. Count only; don't show
 *                     in compact reports.
 *   `informational` — schema drift or structural nulls. Not signal,
 *                     just context. Count only.
 */
export type Severity = 'alert' | 'notice' | 'suppressed' | 'informational';

/**
 * Which calibration class the rule that produced an item is
 * anchored to. Makes provenance visible in triage output — a reader
 * knows whether "alert" is calibrated against a real regression
 * bundle or is a best-guess threshold waiting for more data.
 */
export type CalibrationAnchor =
  | 'N1-N4' // noise-floor samples
  | 'F1' // silent internal failure calibration
  | 'F2' // process-level failure calibration
  | 'R1' // deliberate narrow regression
  | 'provisional'; // no real calibration anchor; threshold is a guess

/**
 * One classified item in a triage report.
 */
export interface TriageItem {
  readonly benchName: BenchName;
  /**
   * Dotted-path location within the diff entry. The multi-sdk row key
   * is the generator slug. Examples:
   *   - `slo.status` — status-level rule
   *   - `slo.blueprint_hit.timeToFirstPreview` — stat field
   *   - `a2ui.form.totalParseFailures` — scalar field
   *   - `multi-sdk.ui-gen-default-haiku-4-5.avgScore` — scalar field
   *   - `multi-sdk.ui-gen-advanced-opus-4-7.presence` — row-presence rule
   */
  readonly location: string;
  readonly severity: Severity;
  /** Human-readable rule id, e.g. `'a2ui-parsefail-nonzero'`. */
  readonly rule: string;
  /** Which calibration class this rule is anchored to. */
  readonly anchor: CalibrationAnchor;
  /** One-line human-readable summary of the finding. */
  readonly message: string;
  /**
   * Structured context for downstream formatters / CI dashboards.
   * Every field optional — rules populate only what's relevant.
   */
  readonly context: TriageItemContext;
}

export interface TriageItemContext {
  readonly statusChange?: StatusChange;
  readonly beforeStatus?: BenchStatus | null;
  readonly afterStatus?: BenchStatus | null;
  readonly before?: number | null;
  readonly after?: number | null;
  readonly delta?: number | null;
  readonly relativeDelta?: number | null;
  /** Relevant note from the diff (e.g., schema-drift explanation). */
  readonly note?: string;
  /** Relevant errorExcerpt for failed benches — first ~200 chars. */
  readonly errorExcerpt?: string;
}

/** Per-severity counts for quick report summary. */
export interface SeverityCounts {
  readonly alert: number;
  readonly notice: number;
  readonly suppressed: number;
  readonly informational: number;
}

/**
 * Final decision: `pass` when zero alerts, `fail` otherwise.
 * Process exit code follows this: pass=0, fail=1.
 */
export type TriageDecision = 'pass' | 'fail';

/**
 * Top-level triage report. Mirrors the `BenchBaselineDiff` source
 * metadata so the triage JSON is self-describing.
 */
export interface TriageReport {
  readonly schemaVersion: 'bench-baseline-diff-triage.v0';
  readonly generatedAt: string;
  readonly source: TriageSource;
  readonly counts: SeverityCounts;
  readonly decision: TriageDecision;
  readonly items: readonly TriageItem[];
  /**
   * Top-level triage notes — mirror the diff's notes plus any
   * triage-level observations (e.g., "policy version v0 — thresholds
   * in known-provisional state on multi-sdk score").
   */
  readonly notes: readonly string[];
}

export interface TriageSource {
  readonly diffSchemaVersion: string;
  readonly beforeBaselineId: string;
  readonly afterBaselineId: string;
  readonly beforeTimestamp: string;
  readonly afterTimestamp: string;
  readonly beforeGitSha: string | null;
  readonly afterGitSha: string | null;
}
