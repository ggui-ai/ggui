import type { BenchmarkRunResult } from '../types';
import { formatCostUsd, formatDurationMs, formatScore } from '../format';
import { readEvalScore, readDimensions } from '../eval-helpers';
import { DimensionScores } from './DimensionScores';

interface Props {
  result: BenchmarkRunResult;
  onClose: () => void;
}

/**
 * Inline detail panel for a selected (variant, commit) cell.
 *
 * Shows: prompt, top-line metrics, dimension scores, live preview iframe,
 * source code, compiled code. Robust to schema drift between bench
 * runner versions — falls back gracefully when fields are absent.
 */
export function ResultDetail({ result, onClose }: Props) {
  const evalScore = readEvalScore(result.evaluation);
  const dimensions = readDimensions(result.evaluation);
  const tokens = result.generation?.tokens;
  const modelLabel = result.variant.modelId?.split('/').pop() ?? result.variant.tier;
  const generationTimeMs = result.generation?.generationTimeMs;

  return (
    <section className="rule-line pt-6 mt-8">
      <div className="flex items-start justify-between mb-4 gap-4">
        <div>
          <p className="eyebrow mb-2">
            {result.variant.sdkName} · {modelLabel} · {result.commit.id}
          </p>
          <h3 className="text-xl font-semibold tracking-tightest">
            {result.commit.name}
          </h3>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-ink-3 hover:text-ink font-mono text-xs underline-offset-2 hover:underline mt-1"
        >
          close
        </button>
      </div>

      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-8 gap-y-2 text-sm mb-6">
        <Stat label="score" value={evalScore !== null ? formatScore(evalScore) : 'n/a'} />
        <Stat
          label="time"
          value={
            typeof generationTimeMs === 'number'
              ? formatDurationMs(generationTimeMs)
              : '—'
          }
        />
        <Stat label="cost" value={formatCostUsd(result.estimatedCostUsd)} />
        <Stat label="turns" value={String(result.generation?.turnsUsed ?? '—')} />
        {tokens && (
          <>
            <Stat label="input tokens" value={tokens.input.toLocaleString()} />
            <Stat label="output tokens" value={tokens.output.toLocaleString()} />
            <Stat label="total tokens" value={tokens.total.toLocaleString()} />
          </>
        )}
      </dl>

      {dimensions && <DimensionScores scores={dimensions} />}

      {result.error && (
        <div className="border border-signal bg-paper-2 px-4 py-3 mb-6">
          <p className="eyebrow text-signal mb-1">error</p>
          <pre className="text-ink text-sm whitespace-pre-wrap">{result.error}</pre>
        </div>
      )}

      {result.compiledCodeS3Key && !result.error && (
        <details className="mb-4">
          <summary className="eyebrow cursor-pointer mb-2">compiled artifact</summary>
          <p className="font-mono text-xs text-ink-3 break-all">
            {result.compiledCodeS3Key}
          </p>
          {/* TODO: live preview via separate fetch from S3 (compiledCodeS3Key resolves under
              the bucket's components/ prefix). Inline compiled/source code isn't carried in
              the published JSON schema — runner uploads each compiled.js as its own object. */}
        </details>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd className="font-mono text-base">{value}</dd>
    </div>
  );
}

