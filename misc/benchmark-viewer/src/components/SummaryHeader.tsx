import type { BenchmarkReport } from '../types';
import { formatDurationMs, formatPercent } from '../format';

interface Props {
  report: BenchmarkReport;
  date: string;
}

/**
 * Top strip of a single run — date eyebrow, headline counts, success rate.
 * Pure presentation; no fetch, no state.
 */
export function SummaryHeader({ report, date }: Props) {
  const { meta } = report;
  return (
    <header className="border-b border-line-2 pb-6 mb-8">
      <p className="eyebrow mb-2">run · {date}</p>
      <h2 className="text-2xl font-semibold tracking-tightest mb-3">
        {meta.totalVariants} variant{meta.totalVariants === 1 ? '' : 's'} ×{' '}
        {meta.totalCommits} prompt{meta.totalCommits === 1 ? '' : 's'} ={' '}
        {meta.totalRuns} run{meta.totalRuns === 1 ? '' : 's'}
      </h2>
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-8 gap-y-2 text-sm">
        <div>
          <dt className="eyebrow">success</dt>
          <dd className="font-mono text-base">{formatPercent(meta.successRate)}</dd>
        </div>
        <div>
          {/* successCount = generation produced output without erroring —
              NOT a quality-threshold pass count. Label accordingly. */}
          <dt className="eyebrow">generated</dt>
          <dd className="font-mono text-base">
            {meta.successCount}/{meta.totalRuns}
          </dd>
        </div>
        <div>
          <dt className="eyebrow">duration</dt>
          <dd className="font-mono text-base">{formatDurationMs(meta.durationMs)}</dd>
        </div>
        <div>
          <dt className="eyebrow">timestamp</dt>
          <dd className="font-mono text-base text-ink-3">
            {new Date(meta.timestamp).toISOString().slice(11, 19)} UTC
          </dd>
        </div>
      </dl>
      {meta.judge && (
        <p className="font-mono text-xs text-ink-4 mt-3">
          scores judged by {meta.judge.model} ({meta.judge.promptVersion})
        </p>
      )}
    </header>
  );
}
