'use client';

import { useEffect, useMemo, useState } from 'react';
import type { BenchmarkDataSource } from '../data-source';
import type { BenchmarkRunMeta, BenchmarkReport } from '../types';
import { formatScore } from '../format';

interface Props {
  dataSource: BenchmarkDataSource;
  /** Most recent N runs to chart. Older runs are sliced off. */
  runs: BenchmarkRunMeta[];
  maxRuns?: number;
}

interface VariantTrend {
  /** Variant id — the trend key. Two variants on the same provider stay distinct lines. */
  variantId: string;
  /** Provider — drives line color only. */
  sdkName: string;
  /**
   * Aligned to the runs slice — undefined for runs missing this
   * variant AND for the −1 "not evaluated" sentinel (an unevaluated
   * run is a gap in the line, not a zero score).
   */
  scores: Array<number | undefined>;
}

const CHART_W = 720;
const CHART_H = 160;
const PAD_L = 36;
const PAD_R = 12;
const PAD_T = 12;
const PAD_B = 28;
const PLOT_W = CHART_W - PAD_L - PAD_R;
const PLOT_H = CHART_H - PAD_T - PAD_B;

// Distinct grayscale shades — keeps the chart legible in print + matches
// the brand-kit ink scale. Reorder if the provider order in reports changes.
const PROVIDER_COLOR: Record<string, string> = {
  claude: '#292929',
  openai: '#5A5A5A',
  google: '#8C8C93',
};

const FALLBACK_COLOR = '#3D3D3D';

/**
 * Score-per-variant over time.
 *
 * Fetches recent reports (up to maxRuns) in parallel on mount, plots
 * each variant's avg score per run, renders pure SVG. No chart library.
 * Keyed by variantId so a report carrying multiple variants per
 * provider (e.g. fast/balanced/premium tiers) doesn't silently
 * overwrite points; the −1 "not evaluated" sentinel renders as a gap.
 *
 * Network: N small fetches per visit, where N = min(maxRuns, runs.length).
 * Each report is ~50KB compressed; 14 runs ≈ 700KB. Acceptable on
 * dashboard initial load.
 */
export function TrendChart({ dataSource, runs, maxRuns = 14 }: Props) {
  const visibleRuns = useMemo(
    () => runs.filter((r) => r.multiSdk).slice(0, maxRuns).reverse(),
    [runs, maxRuns],
  );

  const [reports, setReports] = useState<Map<string, BenchmarkReport>>(new Map());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (visibleRuns.length === 0) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    Promise.allSettled(visibleRuns.map((r) => dataSource.getMultiSdkReport(r))).then(
      (results) => {
        if (cancelled) return;
        const map = new Map<string, BenchmarkReport>();
        results.forEach((res, i) => {
          if (res.status === 'fulfilled') {
            const date = visibleRuns[i]?.date;
            if (date) map.set(date, res.value);
          }
        });
        setReports(map);
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [dataSource, visibleRuns]);

  const trends: VariantTrend[] = useMemo(() => {
    const byVariant = new Map<string, VariantTrend>();
    for (const run of visibleRuns) {
      const report = reports.get(run.date);
      if (!report) continue;
      for (const v of report.variantSummaries) {
        let trend = byVariant.get(v.variantId);
        if (!trend) {
          trend = {
            variantId: v.variantId,
            sdkName: v.sdkName,
            scores: visibleRuns.map(() => undefined),
          };
          byVariant.set(v.variantId, trend);
        }
        const idx = visibleRuns.findIndex((r) => r.date === run.date);
        // avgScore < 0 is the "not evaluated" sentinel — leave the
        // point undefined so the line breaks instead of plotting 0.
        if (idx !== -1 && v.avgScore >= 0) trend.scores[idx] = v.avgScore;
      }
    }
    return Array.from(byVariant.values()).sort((a, b) =>
      a.variantId.localeCompare(b.variantId),
    );
  }, [reports, visibleRuns]);

  if (visibleRuns.length === 0) {
    return null;
  }

  return (
    <section className="mb-10">
      <div className="flex items-baseline justify-between mb-3">
        <p className="eyebrow">trend · score by variant</p>
        {loading && <span className="text-ink-4 font-mono text-xs">loading…</span>}
      </div>

      <div className="rule-line pt-4 overflow-x-auto">
        <svg
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          className="w-full"
          style={{ minWidth: '480px', maxWidth: `${CHART_W}px` }}
          role="img"
          aria-label="Score trend per variant over recent runs"
        >
          {/* Y-axis grid + labels (0, 50, 100) */}
          {[0, 50, 100].map((y) => {
            const cy = scoreToY(y);
            return (
              <g key={y}>
                <line
                  x1={PAD_L}
                  x2={CHART_W - PAD_R}
                  y1={cy}
                  y2={cy}
                  stroke="#D6D4CB"
                  strokeWidth={1}
                />
                <text
                  x={PAD_L - 6}
                  y={cy + 3}
                  textAnchor="end"
                  fontSize="10"
                  fontFamily="var(--font-geist-mono, ui-monospace, monospace)"
                  fill="#8C8C93"
                >
                  {y}
                </text>
              </g>
            );
          })}

          {/* X-axis date labels — only show first/middle/last to avoid crowding */}
          {[0, Math.floor(visibleRuns.length / 2), visibleRuns.length - 1]
            .filter((i, idx, arr) => arr.indexOf(i) === idx && i >= 0)
            .map((i) => {
              const run = visibleRuns[i];
              if (!run) return null;
              return (
                <text
                  key={run.date}
                  x={runIndexToX(i, visibleRuns.length)}
                  y={CHART_H - PAD_B + 14}
                  textAnchor="middle"
                  fontSize="10"
                  fontFamily="var(--font-geist-mono, ui-monospace, monospace)"
                  fill="#8C8C93"
                >
                  {run.date.slice(5)}
                </text>
              );
            })}

          {/* Variant lines + dots. A gap (missing run or the −1
              "not evaluated" sentinel) breaks the line into separate
              segments instead of bridging across it. */}
          {trends.map((trend) => {
            const color = PROVIDER_COLOR[trend.sdkName] ?? FALLBACK_COLOR;
            const segments = toSegments(trend.scores, visibleRuns.length);
            return (
              <g key={trend.variantId}>
                {segments.map((points, segIdx) => (
                  <polyline
                    key={segIdx}
                    points={points}
                    fill="none"
                    stroke={color}
                    strokeWidth={1.5}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                ))}
                {trend.scores.map((s, i) =>
                  s === undefined ? null : (
                    <circle
                      key={i}
                      cx={runIndexToX(i, visibleRuns.length)}
                      cy={scoreToY(s)}
                      r={3}
                      fill={color}
                    >
                      <title>{`${trend.variantId} · ${visibleRuns[i]?.date} · ${formatScore(s)}`}</title>
                    </circle>
                  ),
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {/* Legend — variant id + most recent score */}
      <ul className="flex flex-wrap gap-x-6 gap-y-1 mt-3 text-sm">
        {trends.map((trend) => {
          const lastScore = [...trend.scores].reverse().find((s) => s !== undefined);
          const color = PROVIDER_COLOR[trend.sdkName] ?? FALLBACK_COLOR;
          return (
            <li key={trend.variantId} className="flex items-center gap-2">
              <span
                aria-hidden
                className="inline-block w-3 h-0.5"
                style={{ backgroundColor: color }}
              />
              <span className="font-mono text-ink">{trend.variantId}</span>
              {lastScore !== undefined && (
                <span className="font-mono text-ink-3 text-xs">{formatScore(lastScore)}</span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Split a score series into contiguous polyline point strings.
 * `undefined` entries (missing run / not-evaluated sentinel) terminate
 * the current segment — the chart shows a gap rather than a bridge.
 */
function toSegments(
  scores: Array<number | undefined>,
  total: number,
): string[] {
  const segments: string[] = [];
  let current: string[] = [];
  scores.forEach((s, i) => {
    if (s === undefined) {
      if (current.length > 0) segments.push(current.join(' '));
      current = [];
      return;
    }
    current.push(`${runIndexToX(i, total)},${scoreToY(s)}`);
  });
  if (current.length > 0) segments.push(current.join(' '));
  return segments;
}

function scoreToY(score: number): number {
  const clamped = Math.max(0, Math.min(100, score));
  return PAD_T + PLOT_H * (1 - clamped / 100);
}

function runIndexToX(idx: number, total: number): number {
  if (total <= 1) return PAD_L + PLOT_W / 2;
  return PAD_L + (idx / (total - 1)) * PLOT_W;
}
