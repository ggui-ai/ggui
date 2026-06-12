import type { DimensionScoresShape } from '../eval-helpers';

interface Props {
  scores: DimensionScoresShape;
}

const DIMENSIONS: ReadonlyArray<{ key: keyof DimensionScoresShape; label: string }> = [
  { key: 'layout', label: 'layout' },
  { key: 'designTokens', label: 'design tokens' },
  { key: 'hierarchy', label: 'hierarchy' },
  { key: 'polish', label: 'polish' },
  { key: 'dataPresentation', label: 'data presentation' },
];

/**
 * 5-axis quality breakdown. Each row is a horizontal bar — width = score%,
 * number on the right. No external chart lib; semantic <meter> would be
 * the platform-correct primitive but it lacks the typography control we
 * need, so we render a styled div bar.
 */
export function DimensionScores({ scores }: Props) {
  return (
    <section className="mb-6">
      <p className="eyebrow mb-3">dimension scores</p>
      <ul className="space-y-2 max-w-md">
        {DIMENSIONS.map(({ key, label }) => {
          const score = scores[key];
          return (
            <li key={key} className="flex items-center gap-3 text-sm">
              <span className="text-ink-3 w-32 shrink-0">{label}</span>
              <div className="flex-1 h-1.5 bg-paper-2 relative">
                <div
                  className="absolute inset-y-0 left-0 bg-line"
                  style={{ width: `${Math.max(0, Math.min(100, score))}%` }}
                  role="progressbar"
                  aria-valuenow={score}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={label}
                />
              </div>
              <span className="font-mono text-ink w-10 text-right">
                {score.toFixed(0)}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
