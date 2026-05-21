/**
 * Display helpers — keep all `toFixed`/`%`/`$`/time formatting in one place
 * so the dashboard reads cleanly and changes flow through a single seam.
 */

export function formatScore(score: number): string {
  if (score < 0 || Number.isNaN(score)) return 'n/a';
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

/** Normalize a date string for display (YYYY-MM-DD passes through). */
export function formatDate(date: string): string {
  return date;
}
