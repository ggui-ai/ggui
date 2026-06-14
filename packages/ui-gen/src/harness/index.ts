// packages/ui-gen/src/harness/index.ts
//
// Barrel — public Harness module API.
//
// The orchestrator runtime (`createHarness` / `runWorkflow` / `runCheck`
// / `runHarness`) lives alongside the type hub and the legs
// (HOW/WHAT/CHECK/Process). All types resolve through
// `./types-public.js` — the single types hub.
export {
  createHarness,
  runCheck,
  runHarness,
  runWorkflow,
} from "./types-public.js";
export type {
  RunCheckInput,
  CheckResult,
  RunHarnessInput,
  RunHarnessResult,
  RunHarnessReason,
  IterationRecord,
  RunWorkflowInput,
  WorkflowRunResult,
  PhaseRunResult,
  TaskRunner,
  DefaultTaskRunner,
} from "./types-public.js";
export { defaultApplyPatch, applyLineRanges } from "../patch.js";
export { callLLM, createAgent } from "./llm-router.js";
export type { AgentConfig, LLMResponse } from "./llm-router.js";
export {
  computeHarnessId,
  computeHarnessName,
  hashClassification,
  hashHarness,
} from "./hash.js";
export { WORKFLOWS, pickWorkflow, type WorkflowId } from "../workflows.js";
export {
  setLlmTraceSink,
  getLlmTraceSink,
  type LlmTraceEvent,
  type LlmTraceSink,
  type LlmTraceProvider,
  type LlmTraceKind,
} from "./llm-trace-sink.js";
export {
  setValidatorTraceSink,
  getValidatorTraceSink,
  type ValidatorTraceEvent,
  type ValidatorTraceSink,
} from "./validator-trace-sink.js";
export type {
  CheckLeg,
  CreateHarnessInput,
  Harness,
  HarnessConstructionContext,
  HarnessId,
  HarnessMeta,
  HarnessName,
  HarnessOverrides,
  HarnessRevision,
  HowLeg,
  LLMEvaluator,
  PatchFn,
  Phase,
  PlannerDecision,
  PlannerFn,
  ProcessLeg,
  ProcessMode,
  PromptBuilder,
  RetryPolicy,
  Task,
  TaskContext,
  TierCheck,
  WhatLeg,
  Workflow,
} from "./types-public.js";
