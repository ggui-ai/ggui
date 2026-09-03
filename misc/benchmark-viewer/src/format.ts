/**
 * Display helpers — keep all `toFixed`/`%`/`$`/time formatting in one place
 * so the dashboard reads cleanly and changes flow through a single seam.
 */

export function formatScore(score: number | null | undefined): string {
  if (score == null || score < 0 || Number.isNaN(score)) return 'n/a';
  return score.toFixed(1);
}

export function formatCostUsd(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

export function formatPercent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/**
 * Coverage percents FLOOR instead of round: the runner's degraded flags
 * use a strict `< 0.8`, so 0.798 must never print as "80%" next to a badge
 * that says "under 80%".
 */
function formatCoveragePercent(rate: number): string {
  return `${Math.floor(rate * 100)}%`;
}

/** Normalize a date string for display (YYYY-MM-DD passes through). */
export function formatDate(date: string): string {
  return date;
}

/**
 * One judge's disclosure with the sampling the router ACTUALLY applied
 * (#713): the panel requests temperature 0 for reproducibility, but the
 * router strips sampling params for model families that reject them
 * (Opus 4.7+/5) and reports what it did. We print the effective value —
 * never the requested one — so a future 5-family judge shows
 * "provider-default sampling" by construction. Reports that predate the
 * field show the bare model: unknown, not assumed.
 */
export function formatJudge(j: {
  model: string;
  promptVersion?: string;
  sampling?: { temperature: number | 'provider-default'; strippedReason?: string };
}): string {
  if (j.sampling === undefined) return j.model;
  return j.sampling.temperature === 'provider-default'
    ? `${j.model} (provider-default sampling)`
    : `${j.model} (temperature ${j.sampling.temperature})`;
}

/**
 * Judge-coverage disclosure line (#565): how many generated cells actually
 * carry a panel score, and whether the runner flagged the run degraded
 * (coverage under its floor — aggregate scores not representative).
 * Returns null for reports published before the field existed (2026-08-20);
 * those runs' coverage is unknown, not 100%, so we say nothing rather than
 * guess.
 */
export function judgeCoverageLine(meta: {
  evaluatedCount?: number;
  judgeCoverage?: number;
  judgeCoverageDegraded?: true;
  successCount: number;
}): { text: string; degraded: boolean } | null {
  if (meta.evaluatedCount === undefined || meta.judgeCoverage === undefined) return null;
  return {
    text: `scores from ${meta.evaluatedCount}/${meta.successCount} generated cells (${formatCoveragePercent(meta.judgeCoverage)})`,
    degraded: meta.judgeCoverageDegraded === true,
  };
}

/**
 * Mirror of the runner's `CRITERIA_COVERAGE_FLOOR` (reporter.ts) — the
 * viewer cannot import the runner, and the floor is also stated as "80%"
 * in the methodology text. Change all three together.
 */
const CRITERIA_COVERAGE_FLOOR = 0.8;

/**
 * In-loop evaluator criterion-coverage disclosure (#591 class): how many
 * criteria produced a verdict on every tier-evaluated cell, and — on a
 * degraded run — which criteria fell under the floor, as
 * "name ran/total (pct)". A criterion that never ran fail-opens into
 * `pass` inside the evaluator, so an undisclosed shortfall would publish
 * non-evidence as evidence. Returns null for reports without the
 * instrument (no cell carried it) — unknown coverage, never 100%. A run
 * where every cell was bypassed by design (same-image low-risk) is NOT
 * that case: the instrument was present and found nothing applicable —
 * said in words, never as "0/0 cells".
 */
export function criteriaCoverageLine(meta: {
  criteriaCoverage?: Array<{
    criterion: string;
    tier: 1 | 2;
    ran: number;
    skipped: number;
    unknown: number;
    /** Absent on reports published before 2026-09-03 — read as 0. */
    notApplicable?: number;
  }>;
  criteriaCoverageDegraded?: true;
}): { text: string; degraded: boolean; short: string[] } | null {
  const rows = meta.criteriaCoverage;
  if (rows === undefined || rows.length === 0) return null;
  const [first] = rows;
  // Every row's counts are over the same cell set, so any row yields the
  // denominator (cells the criterion applied to) and the bypass count.
  const cells = first.ran + first.skipped + first.unknown;
  const bypassed = first.notApplicable ?? 0;
  const degraded = meta.criteriaCoverageDegraded === true;
  if (cells === 0) {
    return {
      text: `eval criteria: no cell required the in-loop evaluator (${bypassed} bypassed by design)`,
      degraded,
      short: [],
    };
  }
  const share = (ran: number) => ran / cells;
  const full = rows.filter((r) => r.ran === cells).length;
  const short = rows
    .filter((r) => share(r.ran) < CRITERIA_COVERAGE_FLOOR)
    .map((r) => `${r.criterion} ${r.ran}/${cells} (${formatCoveragePercent(share(r.ran))})`);
  const bypassNote = bypassed > 0 ? ` (${bypassed} bypassed by design)` : '';
  return {
    text: `eval criteria: ${full}/${rows.length} ran on all ${cells} evaluated cells${bypassNote}`,
    degraded,
    short,
  };
}
