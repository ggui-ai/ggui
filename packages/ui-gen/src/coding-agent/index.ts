// packages/ui-gen/src/coding-agent/index.ts
//
// Public API for the virtual-git coding agent.

// Main entry point
export { runCodingAgent } from './agent';

// Types
export type {
  Plan,
  CommitInput,
  CodingCriteria,
  SelfCheckRule,
  EvalCriterion,
  CommitSummary,
  CommitMetadata,
  BuildResult,
  ToolCall,
  ToolResult,
  BatchResult,
  ToolSchema,
  LLMCaller,
  CodingAgentInput,
  CodingAgentOutput,
  CodingProgressEvent,
  GenerationTrace,
  PhaseTrace,
  ToolExecution,
  CommitTraceEntry,
} from './types';

// Workspace (for testing / advanced use)
export { AgentWorkspace } from './workspace';

// Trace (for investigation)
export { TraceCollector, TurnRecorder } from './trace';

// Tool schemas (for reference / extending)
export { fullToolSchemas } from './tools';

// Planner
export { runPlanner } from './planner';
export type { PlannerOutput, FileTask } from './planner';

// File agent
export { runFileAgent } from './file-agent';
export type { FileAgentInput, FileAgentOutput } from './file-agent';
