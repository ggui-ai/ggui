import type { BenchmarkReport, BenchmarkRunResult, VariantSummary } from '../types';
import { formatCostUsd, formatDurationMs, formatPercent, formatScore } from '../format';
import { readEvalScore } from '../eval-helpers';

interface Props {
  report: BenchmarkReport;
  selectedResultKey: string | null;
  onSelectResult: (key: string | null) => void;
}

/** Composite key uniquely identifying a single (variant, commit) cell. */
export function resultKey(result: Pick<BenchmarkRunResult, 'variant' | 'commit'>): string {
  return `${result.variant.id}::${result.commit.id}`;
}

interface DerivedCommit {
  commitId: string;
  commitName: string;
}

function deriveCommitsFromResults(results: BenchmarkRunResult[]): DerivedCommit[] {
  const seen = new Map<string, DerivedCommit>();
  for (const r of results) {
    if (!seen.has(r.commit.id)) {
      seen.set(r.commit.id, { commitId: r.commit.id, commitName: r.commit.name });
    }
  }
  return Array.from(seen.values());
}

/**
 * The headline panel — provider/model rows × prompt columns.
 * Cells show top-line score + click into detail.
 *
 * Built from `variantSummaries` (rows) + `commitSummaries` (columns) +
 * `results` (cells). All three live on the report shape; we don't
 * recompute aggregations.
 */
export function VariantGrid({ report, selectedResultKey, onSelectResult }: Props) {
  const variants = report.variantSummaries;
  // commitSummaries is populated by newer runners. Derive deterministic
  // ordering from results for older reports — preserves the order each
  // commit first appears so visual diffs across runs stay stable.
  const commits =
    report.commitSummaries.length > 0
      ? report.commitSummaries
      : deriveCommitsFromResults(report.results);

  if (variants.length === 0 || commits.length === 0) {
    return (
      <p className="text-ink-3 text-sm">
        Empty report — no variants or prompts captured.
      </p>
    );
  }

  // Index results by composite key for O(1) cell lookup.
  const resultIndex = new Map<string, BenchmarkRunResult>();
  for (const r of report.results) {
    resultIndex.set(resultKey(r), r);
  }

  return (
    <div className="overflow-x-auto rule-line pt-6">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th className="text-left py-2 pr-6 sticky left-0 bg-paper z-10 align-bottom">
              <span className="eyebrow">variant</span>
            </th>
            {commits.map((c) => (
              <th
                key={c.commitId}
                scope="col"
                className="text-left py-2 px-3 align-bottom font-normal"
              >
                <span className="eyebrow">{c.commitId}</span>
              </th>
            ))}
            <th className="text-right py-2 pl-6 align-bottom">
              <span className="eyebrow">avg</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {variants.map((v) => (
            <VariantRow
              key={v.variantId}
              variant={v}
              commits={commits}
              resultIndex={resultIndex}
              selectedResultKey={selectedResultKey}
              onSelectResult={onSelectResult}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VariantRow({
  variant,
  commits,
  resultIndex,
  selectedResultKey,
  onSelectResult,
}: {
  variant: VariantSummary;
  commits: ReadonlyArray<{ commitId: string }>;
  resultIndex: Map<string, BenchmarkRunResult>;
  selectedResultKey: string | null;
  onSelectResult: (key: string | null) => void;
}) {
  return (
    <tr className="border-t border-line-2 hover:bg-paper-2">
      <th
        scope="row"
        className="text-left py-3 pr-6 sticky left-0 bg-paper z-10 align-top"
      >
        <span className="font-mono text-ink">{variant.sdkName}</span>
        <span className="block font-mono text-xs text-ink-4 mt-0.5">
          {variant.modelId.split('/').pop()}
        </span>
      </th>
      {commits.map((c) => {
        const key = `${variant.variantId}::${c.commitId}`;
        const result = resultIndex.get(key);
        const isSelected = selectedResultKey === key;
        return (
          <td key={c.commitId} className="py-3 px-3 align-top">
            <ResultCell
              result={result}
              isSelected={isSelected}
              onClick={() => onSelectResult(isSelected ? null : key)}
            />
          </td>
        );
      })}
      <td className="py-3 pl-6 text-right align-top">
        <span className="font-mono text-ink">{formatScore(variant.avgScore)}</span>
        <span className="block font-mono text-xs text-ink-4 mt-0.5">
          {formatPercent(variant.successRate)} · {formatDurationMs(variant.avgTimeMs)} ·{' '}
          {formatCostUsd(variant.avgCostUsd)}
        </span>
      </td>
    </tr>
  );
}

function ResultCell({
  result,
  isSelected,
  onClick,
}: {
  result: BenchmarkRunResult | undefined;
  isSelected: boolean;
  onClick: () => void;
}) {
  if (!result) {
    return <span className="text-ink-4 font-mono text-xs">—</span>;
  }
  const evalScore = readEvalScore(result.evaluation);
  const failed = !!result.error;
  const generationTimeMs = result.generation?.generationTimeMs;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left w-full -mx-2 px-2 py-1 rounded transition-colors ${
        isSelected
          ? 'bg-line text-paper'
          : failed
            ? 'text-signal hover:bg-paper-2'
            : 'text-ink hover:bg-paper-2'
      }`}
      aria-pressed={isSelected}
    >
      <span className="font-mono">
        {/* No score ≠ pass — a cell without a readable score renders "—".
            The judge's threshold verdict lives in `evaluation.passed`;
            this cell shows the score itself or nothing. */}
        {failed ? 'fail' : evalScore !== null ? formatScore(evalScore) : '—'}
      </span>
      <span
        className={`block font-mono text-xs mt-0.5 ${
          isSelected ? 'text-chrome' : 'text-ink-4'
        }`}
      >
        {typeof generationTimeMs === 'number' ? formatDurationMs(generationTimeMs) : '—'} ·{' '}
        {formatCostUsd(result.estimatedCostUsd)}
      </span>
    </button>
  );
}
