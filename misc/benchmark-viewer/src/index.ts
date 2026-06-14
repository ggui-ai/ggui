/**
 * @ggui-ai/benchmark-viewer
 *
 * React component package for rendering @ggui-ai/benchmark daily reports.
 * Source-agnostic: pass any `BenchmarkDataSource` and the dashboard renders.
 */

export { BenchmarksDashboard } from './components/BenchmarksDashboard';
export { DateSelector } from './components/DateSelector';
export { SummaryHeader } from './components/SummaryHeader';
export { VariantGrid, resultKey } from './components/VariantGrid';
export { ResultDetail } from './components/ResultDetail';
export { DimensionScores } from './components/DimensionScores';
export { TrendChart } from './components/TrendChart';
export { MethodologySection } from './components/MethodologySection';

export { httpJsonSource } from './data-source';
export type { BenchmarkDataSource } from './data-source';

export {
  readEvalScore,
  readDimensions,
  readJudges,
  readCritique,
  readSpread,
  readJudgePanel,
} from './eval-helpers';
export type {
  DimensionScoresShape,
  JudgeShape,
  PanelJudgeShape,
} from './eval-helpers';

export type {
  BenchmarkIndex,
  BenchmarkRunMeta,
  BenchSummaryRef,
  BenchmarkReport,
  VariantSummary,
  CommitSummary,
  BenchmarkRunResult,
  BenchmarkVariant,
  BenchmarkCommit,
  ProviderName,
} from './types';

export {
  formatScore,
  formatCostUsd,
  formatDurationMs,
  formatPercent,
  formatDate,
} from './format';
