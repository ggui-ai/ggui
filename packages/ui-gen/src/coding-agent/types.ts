// packages/ui-gen/src/coding-agent/types.ts
//
// All type definitions for the virtual-git coding agent.

import type { JsonObject } from '@ggui-ai/protocol';

// =============================================================================
// Plan & Contract Types
// =============================================================================

/** Plan produced by the planning agent. Structure TBD in planning agent spec. */
export interface Plan {
  /** Natural language design spec */
  spec: string;
  /** Which design system primitives to use */
  primitivesSelected?: string[];
  /** State management approach */
  stateStrategy?: string;
}

/** Data contract from negotiation / commitInput */
export interface CommitInput {
  /** Maps to DataContract.props */
  propsSpec: JsonObject;
  /** Maps to DataContract.streamSpec */
  streamSpec?: JsonObject;
  /** Maps to DataContract.actionSpec */
  actionSpec?: JsonObject;
  /** CSS variable overrides */
  theme?: JsonObject;
}

// =============================================================================
// Criteria Types
// =============================================================================

/** Criteria for the coding agent */
export interface CodingCriteria {
  selfCheck: SelfCheckRule[];
  evaluation: EvalCriterion[];
  userRequest: string;
}

export interface SelfCheckRule {
  id: string;
  type: 'hard_block' | 'soft_warning';
  check: (code: string, build?: BuildResult, contract?: CommitInput) => boolean;
}

export interface EvalCriterion {
  id: string;
  description: string;
}

// =============================================================================
// Build & Check Results
// =============================================================================

export interface BuildResult {
  success: boolean;
  compiledCode?: string;
  errors?: string[];
}

export interface CommitMetadata {
  build: BuildResult;
  selfCheck: { passed: boolean; violations: string[] };
}

export interface CommitSummary {
  oid: string;
  message: string;
  selfCheckPassed: boolean;
  buildPassed: boolean;
  violations: string[];
}

// =============================================================================
// Tool Execution Types
// =============================================================================

export interface ToolCall {
  tool: string;
  input: JsonObject;
}

export interface ToolResult {
  /** Text shown to LLM */
  result: string;
  /** Commit passed self-check — generation complete */
  done?: boolean;
  /** Tool execution failed */
  error?: boolean;
  /** Compiled code (only set when done) */
  compiledCode?: string;
}

export interface BatchResult {
  results: ToolResult[];
  done: boolean;
  compiledCode?: string;
}

export interface ApplyResult {
  success: boolean;
  error?: string;
}

export interface ToolSchema {
  description: string;
  input: {
    type: 'object';
    properties: JsonObject;
    required?: string[];
  };
}

// =============================================================================
// LLM Caller
// =============================================================================

/**
 * Provider-agnostic LLM caller.
 * The coding agent uses LLMAgent.callStructured() directly for structured
 * tool call output. This type alias is kept for backward compatibility
 * with tests that inject mock callers.
 */
export type LLMCaller = (
  messages: Array<{ role: string; content: string }>,
  options: {
    model: string;
    tools: Record<string, ToolSchema>;
    toolChoice: 'required' | 'auto';
  },
) => Promise<{
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
}>;

// =============================================================================
// Progress Events
// =============================================================================

export type CodingProgressEvent =
  | { type: 'turn_start'; turn: number }
  | { type: 'tool_executed'; tool: string; result: string }
  | { type: 'commit_result'; passed: boolean; violations?: string[] };

// =============================================================================
// Trace Types (Investigation & Telemetry)
// =============================================================================

export interface GenerationTrace {
  /** Unique trace ID (matches session/generation ID) */
  traceId: string;
  /** Model used */
  model: string;
  /** Total wall-clock time */
  totalTimeMs: number;
  /** Phase 1 vs Phase 2 breakdown */
  phases: {
    initial: PhaseTrace;
    fixLoop: PhaseTrace[];
  };
  /** Aggregate token breakdown */
  tokenBreakdown: {
    total: { input: number; output: number };
    phase1: { input: number; output: number };
    phase2: { input: number; output: number };
    perTurn: Array<{ turn: number; input: number; output: number }>;
  };
  /** Aggregate time breakdown */
  timeBreakdown: {
    llmCallsMs: number;
    toolExecutionMs: number;
    diffProcessingMs: number;
    buildMs: number;
    selfCheckMs: number;
    contextBuildMs: number;
  };
  /** Git commit log with metadata */
  commitLog: CommitTraceEntry[];
  /** Final outcome */
  outcome: 'success' | 'max_turns_fallback' | 'max_turns_failed';
}

export interface PhaseTrace {
  turn: number;
  phase: 'initial' | 'fix';
  /** What the LLM received */
  prompt: {
    systemPrompt: string;
    userContext: string;
    promptTokens: number;
  };
  /** What the LLM returned */
  llmResponse: {
    toolCalls: ToolCall[];
    tokens: { input: number; output: number };
    latencyMs: number;
  };
  /** Each tool execution in the batch */
  toolExecutions: ToolExecution[];
  /** Total turn wall-clock time */
  turnTimeMs: number;
}

export interface ToolExecution {
  tool: string;
  input: JsonObject;
  /** Tool-specific details */
  details: JsonObject;
  result: string;
  success: boolean;
  /** Execution time for this tool */
  durationMs: number;
}

export interface CommitTraceEntry {
  oid: string;
  message: string;
  turn: number;
  buildPassed: boolean;
  selfCheckPassed: boolean;
  violations: string[];
  /** Source code at this commit */
  sourceSnapshot: string;
}

// =============================================================================
// Public API Types
// =============================================================================

export interface CodingAgentInput {
  /** From planning agent (or direct invocation) */
  plan: Plan;
  commitInput: CommitInput;

  /** Reference context */
  designSystem: string;
  criteria: CodingCriteria;

  /** From evaluation agent (on re-run after evaluation feedback) */
  evaluationFeedback?: string;

  /** Execution config — provide either llmAgent (preferred) or llmCaller (for tests) */
  llmAgent?: import('../harness/llm-router').LLMAgent;
  llmCaller?: LLMCaller;
  model: string;
  maxTurns?: number;

  /** Progress callback for agent thinking indicator / UI updates */
  onProgress?: (event: CodingProgressEvent) => void;

  /** Pre-generated boilerplate to start from */
  boilerplate?: string;
  /** Custom system prompt */
  systemPrompt?: string;
}

export interface CodingAgentOutput {
  /** Raw ui.tsx source */
  sourceCode: string;
  /** Compiled esbuild bundle */
  compiledCode: string;
  /** Git commit history summary */
  commitHistory: CommitSummary[];
  /** Generation metrics */
  metrics: {
    turns: number;
    tokens: { input: number; output: number; total: number };
    generationTimeMs: number;
    commitAttempts: number;
    selfCheckViolations: string[];
    maxTurnsExceeded?: boolean;
  };
  /** Full generation trace for investigation */
  trace: GenerationTrace;
}
