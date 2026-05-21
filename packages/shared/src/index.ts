/**
 * @ggui-ai/shared — Shared types used across public ggui SDK packages.
 *
 * Contains types that are shared between @ggui-ai/react, @ggui-ai/react-native,
 * and other public packages but aren't wire protocol types.
 */

// Self-repair types (error boundary, component repair)
export type {
  ComponentErrorReport,
  ComponentRepairResult,
  SelfRepairConfig,
  SelfRepairEventType,
  SelfRepairEvents,
  RepairHistoryEntry,
} from './types/self-repair';

// Agent listing types (marketplace)
export type {
  AgentListingItem,
  AgentListingVisibility,
  AgentListingStatus,
} from './types/agent-listing';

// Benchmark display types
export type {
  BenchmarkReportDisplay,
  BenchmarkMeta,
  VariantInfo,
  CommitInfo,
  GenerationResultDisplay,
  EvaluationResultDisplay,
  TierEvaluationDisplay,
  PostGenerationDisplay,
  BenchmarkRunResultDisplay,
  VariantSummaryDisplay,
  CommitSummaryDisplay,
  FloorSummaryDisplay,
  SdkComparisonEntry,
} from './types/benchmark';
