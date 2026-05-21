import type { BenchmarkRunMeta } from '../types';
import { formatPercent } from '../format';

interface Props {
  runs: BenchmarkRunMeta[];
  selectedDate: string | null;
  onSelect: (date: string) => void;
}

/**
 * Top-row date strip — ordered newest-first.
 * Each chip surfaces the multi-sdk success rate so trends are visible
 * at a glance without diving into a run.
 */
export function DateSelector({ runs, selectedDate, onSelect }: Props) {
  if (runs.length === 0) {
    return <p className="text-ink-3 text-sm">No runs available yet.</p>;
  }
  return (
    <nav aria-label="benchmark runs by date" className="mb-8">
      <p className="eyebrow mb-3">runs</p>
      <ol className="flex flex-wrap gap-2">
        {runs.map((run) => (
          <li key={run.date}>
            <button
              type="button"
              onClick={() => onSelect(run.date)}
              className={`px-3 py-1.5 border font-mono text-xs transition-colors ${
                run.date === selectedDate
                  ? 'border-line bg-line text-paper'
                  : 'border-line-2 text-ink hover:border-line'
              }`}
              aria-pressed={run.date === selectedDate}
            >
              <span>{run.date}</span>
              {run.multiSdk && (
                <span
                  className={`ml-2 ${
                    run.date === selectedDate ? 'text-chrome' : 'text-ink-4'
                  }`}
                >
                  {formatPercent(run.multiSdk.successRate)}
                </span>
              )}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
