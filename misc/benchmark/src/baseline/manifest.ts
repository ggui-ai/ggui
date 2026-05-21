/**
 * Cross-bench baseline manifest — schema + pure helpers.
 *
 * The baseline is a **snapshot bundle**, not a new scoring layer.
 * One command runs all four v0 benches and writes a small manifest
 * tying them together with honest per-bench success/failure reporting.
 *
 * Discipline:
 *   - No cross-bench composite scores. Individual benches remain
 *     authoritative for their own metrics.
 *   - Partial failure is recorded, not papered over. If one bench
 *     fails, the manifest captures its exit code + stderr, and the
 *     other benches still run.
 *   - Summary extraction is top-line only. Readers drill into each
 *     bench's copied JSON for detail.
 */

/** Which bench produced this entry. Closed union — add new benches
 * deliberately. */
export type BenchName =
  | 'slo'
  | 'multi-sdk'
  | 'a2ui'
  | 'blueprint-negotiation';

export type BenchStatus = 'success' | 'failed';

/**
 * Per-bench top-line summary. Shape is deliberately small: just
 * enough to see "something ran and produced numbers" without
 * loading the full report. v0 prefers sparse fields over rich
 * ones — readers drill into the copied JSON for detail.
 *
 * Each bench populates the subset that makes sense for it; others
 * stay `undefined`. No coalescing, no fake zeros.
 */
export interface BenchTopLineSummary {
  /** Total runs captured in the bench's report. */
  readonly totalRuns?: number;
  /**
   * Short free-form text summarizing the bench output — one line
   * per dimension the bench groups on. Example (a2ui):
   *   `form: 4/4 frames, 100% parse; list: 4/4 frames, 100%; minimal: 4/4 frames, 100%`
   */
  readonly headline?: string;
}

/**
 * Manifest entry per bench. `status` is mandatory; all other
 * nullable fields reflect what we honestly captured.
 */
export interface BenchManifestEntry {
  readonly benchName: BenchName;
  readonly status: BenchStatus;
  /**
   * The exact shell command that ran. Captured verbatim so baselines
   * are reproducible without re-deriving args.
   */
  readonly command: string;
  /**
   * Absolute path to the bench's original report. `null` when the
   * bench failed before emitting a report OR the orchestrator
   * couldn't parse the path from stdout.
   */
  readonly outputPath: string | null;
  /**
   * Path of the report copy inside the baseline bundle. `null` on
   * failure or when the source report was unreadable.
   */
  readonly bundlePath: string | null;
  /** Process exit code. `null` if the bench never spawned. */
  readonly exitCode: number | null;
  /** Top-line summary (see {@link BenchTopLineSummary}). `null` on failure. */
  readonly summary: BenchTopLineSummary | null;
  /**
   * First ~500 chars of stderr on failure — enough to diagnose
   * without turning the manifest into a full log archive. Full
   * stdout/stderr are persisted to `stdout/<bench>.log` alongside
   * the manifest.
   */
  readonly errorExcerpt: string | null;
}

export interface BenchBaselineManifest {
  readonly schemaVersion: 'bench-baseline.v0';
  /**
   * Human-readable baseline id — ISO stamp with colons replaced,
   * matching the bundle directory name. Reusable as a foreign key
   * across tools that reference baselines.
   */
  readonly baselineId: string;
  readonly timestamp: string;
  /** Git SHA at bundle creation time, or `null` if resolution failed. */
  readonly gitSha: string | null;
  /** Absolute path to the bundle directory. */
  readonly bundleDir: string;
  /**
   * Honesty notes embedded on every manifest — same discipline as
   * the individual benches. Self-describing without reading README.
   */
  readonly notes: readonly string[];
  /** One entry per bench the orchestrator attempted. */
  readonly results: readonly BenchManifestEntry[];
}

/**
 * Pure builder. Takes the orchestrator's collected entries + the
 * run's metadata and returns the manifest document. Kept pure so
 * tests can exercise edge cases (all-success, all-fail, mixed)
 * without spinning up child processes.
 */
export function buildBaselineManifest(params: {
  readonly baselineId: string;
  readonly timestamp: string;
  readonly gitSha: string | null;
  readonly bundleDir: string;
  readonly results: readonly BenchManifestEntry[];
}): BenchBaselineManifest {
  return {
    schemaVersion: 'bench-baseline.v0',
    baselineId: params.baselineId,
    timestamp: params.timestamp,
    gitSha: params.gitSha,
    bundleDir: params.bundleDir,
    notes: V0_BASELINE_NOTES,
    results: params.results,
  };
}

const V0_BASELINE_NOTES: readonly string[] = [
  'This is a SNAPSHOT BUNDLE, not a new scoring layer. Individual benches remain authoritative.',
  'No cross-bench composite scores. Each entry carries its own bench-local summary.',
  'Partial failure is first-class — a failed bench records exitCode + errorExcerpt; successful benches still run.',
  'Bundle contents are self-contained: reports are COPIED into the bundle dir alongside this manifest.',
];

// ─── Summary extractors (pure) ─────────────────────────────────────
//
// One per bench. All take the raw report JSON as `unknown` + return
// a BenchTopLineSummary. Kept defensive: if the report shape drifts
// (e.g., a bench bumps its schemaVersion), the extractor degrades to
// `{}` rather than crashing — the manifest entry's status is still
// 'success' because the bench ran and wrote a parseable file.
//
// These are intentionally thin. For richer views, read the report.

export function extractSloSummary(report: unknown): BenchTopLineSummary {
  const r = isRecord(report) ? report : null;
  if (!r) return {};
  const results = Array.isArray(r.results) ? r.results : undefined;
  const summary = Array.isArray(r.summary) ? r.summary : undefined;
  const headline = summary
    ? summary
        .filter(isRecord)
        .map((s) => {
          const path = typeof s.path === 'string' ? s.path : '?';
          const runs = typeof s.runs === 'number' ? s.runs : 0;
          const observed =
            typeof s.previewObservedCount === 'number'
              ? s.previewObservedCount
              : 0;
          const regress =
            typeof s.previewExpectedButMissingCount === 'number'
              ? s.previewExpectedButMissingCount
              : 0;
          return `${path}: ${runs}r, prev ${observed}/${regress}`;
        })
        .join(' | ')
    : undefined;
  return {
    totalRuns: results?.length,
    headline,
  };
}

export function extractA2uiSummary(report: unknown): BenchTopLineSummary {
  const r = isRecord(report) ? report : null;
  if (!r) return {};
  const results = Array.isArray(r.results) ? r.results : undefined;
  const summary = Array.isArray(r.summary) ? r.summary : undefined;
  const headline = summary
    ? summary
        .filter(isRecord)
        .map((s) => {
          const shape = typeof s.intentShape === 'string' ? s.intentShape : '?';
          const runs = typeof s.runs === 'number' ? s.runs : 0;
          const parseFails =
            typeof s.totalParseFailures === 'number' ? s.totalParseFailures : 0;
          return `${shape}: ${runs}r, parseFails=${parseFails}`;
        })
        .join(' | ')
    : undefined;
  return {
    totalRuns: results?.length,
    headline,
  };
}

export function extractNegotiationSummary(report: unknown): BenchTopLineSummary {
  const r = isRecord(report) ? report : null;
  if (!r) return {};
  const results = Array.isArray(r.results) ? r.results : undefined;
  const summary = Array.isArray(r.summary) ? r.summary : undefined;
  const headline = summary
    ? summary
        .filter(isRecord)
        .map((s) => {
          const mode = typeof s.registryMode === 'string' ? s.registryMode : '?';
          const runs = typeof s.runs === 'number' ? s.runs : 0;
          const hit = typeof s.hitRate === 'number' ? Math.round(s.hitRate * 100) : 0;
          const wrong =
            typeof s.wrongHitRate === 'number'
              ? Math.round(s.wrongHitRate * 100)
              : 0;
          return `${mode}: ${runs}r hit=${hit}% wrong=${wrong}%`;
        })
        .join(' | ')
    : undefined;
  return {
    totalRuns: results?.length,
    headline,
  };
}

/**
 * The multi-sdk report is different shape — it groups by
 * `floorSummaries` (added in the floor split), plus variantSummaries.
 * Baseline top-line focuses on the floor view since that's the
 * new post-OSS-split signal.
 */
export function extractMultiSdkSummary(report: unknown): BenchTopLineSummary {
  const r = isRecord(report) ? report : null;
  if (!r) return {};
  const meta = isRecord(r.meta) ? r.meta : undefined;
  const floorSummaries = Array.isArray(r.floorSummaries)
    ? r.floorSummaries
    : undefined;
  const totalRuns =
    typeof meta?.totalRuns === 'number' ? meta.totalRuns : undefined;
  const headline = floorSummaries
    ? floorSummaries
        .filter(isRecord)
        .map((s) => {
          const floor = typeof s.floor === 'string' ? s.floor : '?';
          const runs = typeof s.runs === 'number' ? s.runs : 0;
          const t =
            typeof s.avgTimeMs === 'number'
              ? `${(s.avgTimeMs / 1000).toFixed(1)}s`
              : 'n/a';
          const score =
            typeof s.avgScore === 'number' && s.avgScore >= 0
              ? s.avgScore.toFixed(1)
              : 'n/a';
          const tool =
            typeof s.predefinedToolCallRate === 'number'
              ? `${Math.round(s.predefinedToolCallRate * 100)}%`
              : 'n/a';
          return `${floor}: ${runs}r t=${t} s=${score} tool=${tool}`;
        })
        .join(' | ')
    : undefined;
  return {
    totalRuns,
    headline,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
