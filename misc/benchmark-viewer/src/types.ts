/**
 * Public types for the benchmark viewer.
 *
 * Run-level types (`BenchmarkReport`, `VariantSummary`, etc.) are
 * re-exported from `@ggui-ai/shared`'s **Display** schema — that's
 * the serialization-safe shape the runner emits to JSON. Importing
 * from the runner's internal types caused field-name drift (the
 * runner renames `successRate→passRate`, `totalDurationMs→durationMs`
 * during `toDisplayReport`, see `packages/benchmark/src/multi-sdk/
 * reporter.ts:430+`); the viewer has to read what's on disk.
 *
 * Index-level types (`BenchmarkIndex`, `BenchmarkRunMeta`) are owned
 * here — they describe the file-layout convention the data source
 * expects on disk, not the runner's emitted shape.
 */

import type {
  BenchmarkReportDisplay,
  BenchmarkRunResultDisplay,
  VariantSummaryDisplay,
  CommitSummaryDisplay,
  VariantInfo,
  CommitInfo,
} from '@ggui-ai/shared';

export type BenchmarkReport = BenchmarkReportDisplay;
export type BenchmarkRunResult = BenchmarkRunResultDisplay;
export type VariantSummary = VariantSummaryDisplay;
export type CommitSummary = CommitSummaryDisplay;
export type BenchmarkVariant = VariantInfo;
export type BenchmarkCommit = CommitInfo;

/** Provider name (claude/openai/google) — string union from the runner. */
export type ProviderName = 'claude' | 'openai' | 'google';

/**
 * The `index.json` file at the root of any benchmark data source.
 * Lists all runs available for the dashboard to render.
 *
 * Path convention served by the data source:
 *   /index.json
 *   /<date>/multi-sdk.json
 *   /latest/multi-sdk.json   (optional — copy of most recent date)
 */
export interface BenchmarkIndex {
  /** ISO timestamp of the most recent run included in this index. */
  generatedAt: string;
  /** Schema version — bumps on breaking shape changes. */
  schemaVersion: 'benchmark-index.v0';
  /** Available runs, newest first. */
  runs: BenchmarkRunMeta[];
}

export interface BenchmarkRunMeta {
  /** YYYY-MM-DD date of the run. */
  date: string;
  /** Multi-sdk bench summary — the per-provider/per-model panel. */
  multiSdk?: BenchSummaryRef;
  /** A2UI bench summary — frame timing panel. */
  a2ui?: BenchSummaryRef;
  /** SLO bench summary — latency floor panel. */
  slo?: BenchSummaryRef;
}

export interface BenchSummaryRef {
  /** Path relative to the data source root, e.g. `2026-05-06/multi-sdk.json`. */
  reportPath: string;
  /** Top-line success rate, surfaced on the index card without fetching the full report. */
  successRate: number;
  /** Total per-cell runs in this report. */
  totalRuns: number;
  /** Optional headline string the runner emits — short summary line. */
  headline?: string;
}
