'use client';

import { useEffect, useState } from 'react';
import type { BenchmarkDataSource } from '../data-source';
import type { BenchmarkIndex, BenchmarkReport, BenchmarkRunResult } from '../types';
import { DateSelector } from './DateSelector';
import { SummaryHeader } from './SummaryHeader';
import { VariantGrid, resultKey } from './VariantGrid';
import { ResultDetail } from './ResultDetail';
import { TrendChart } from './TrendChart';

interface Props {
  dataSource: BenchmarkDataSource;
}

type AsyncState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; data: T };

/**
 * Top-level benchmark viewer. Fetches the index on mount, lets the user
 * pick a date, fetches and renders that run's report.
 *
 * Source-agnostic: takes any `BenchmarkDataSource`. Production passes
 * `httpJsonSource('https://bench.ggui.ai/data/')`; local dev passes
 * `httpJsonSource('http://localhost:8080/')`.
 */
export function BenchmarksDashboard({ dataSource }: Props) {
  const [index, setIndex] = useState<AsyncState<BenchmarkIndex>>({ status: 'idle' });
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [report, setReport] = useState<AsyncState<BenchmarkReport>>({ status: 'idle' });
  const [selectedResultKey, setSelectedResultKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIndex({ status: 'loading' });
    dataSource
      .getIndex()
      .then((data) => {
        if (cancelled) return;
        setIndex({ status: 'ready', data });
        // Default to most recent run on first load.
        if (data.runs.length > 0 && data.runs[0]) {
          setSelectedDate(data.runs[0].date);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setIndex({
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [dataSource]);

  useEffect(() => {
    if (index.status !== 'ready' || selectedDate === null) return;
    const run = index.data.runs.find((r) => r.date === selectedDate);
    if (!run || !run.multiSdk) {
      setReport({ status: 'idle' });
      return;
    }
    let cancelled = false;
    setReport({ status: 'loading' });
    setSelectedResultKey(null);
    dataSource
      .getMultiSdkReport(run)
      .then((data) => {
        if (cancelled) return;
        setReport({ status: 'ready', data });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setReport({
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [dataSource, index, selectedDate]);

  if (index.status === 'idle' || index.status === 'loading') {
    return <p className="text-ink-3 text-sm">Loading benchmarks…</p>;
  }
  if (index.status === 'error') {
    return (
      <div className="border border-signal bg-paper-2 px-4 py-3">
        <p className="eyebrow text-signal mb-1">index unavailable</p>
        <p className="text-ink text-sm font-mono">{index.error}</p>
      </div>
    );
  }

  const selectedResult: BenchmarkRunResult | null =
    report.status === 'ready' && selectedResultKey
      ? report.data.results.find((r) => resultKey(r) === selectedResultKey) ?? null
      : null;

  return (
    <div>
      <TrendChart dataSource={dataSource} runs={index.data.runs} />

      <DateSelector
        runs={index.data.runs}
        selectedDate={selectedDate}
        onSelect={setSelectedDate}
      />

      {report.status === 'loading' && (
        <p className="text-ink-3 text-sm">Loading run…</p>
      )}
      {report.status === 'error' && (
        <div className="border border-signal bg-paper-2 px-4 py-3">
          <p className="eyebrow text-signal mb-1">run unavailable</p>
          <p className="text-ink text-sm font-mono">{report.error}</p>
        </div>
      )}
      {report.status === 'ready' && selectedDate && (
        <>
          <SummaryHeader report={report.data} date={selectedDate} />
          <VariantGrid
            report={report.data}
            selectedResultKey={selectedResultKey}
            onSelectResult={setSelectedResultKey}
          />
          {selectedResult && (
            <ResultDetail
              result={selectedResult}
              onClose={() => setSelectedResultKey(null)}
            />
          )}
        </>
      )}
    </div>
  );
}
