// packages/ui-gen/src/run-workflow.ts
//
// Workflow executor. Runs phases sequentially; within a phase, tasks run in
// parallel (Promise.all). Each task produces a named output that downstream
// tasks can read from context.priorResults.
//
// Generic DAG executor — zero LLM coupling, zero environment/profile
// gating. Re-exported via `@ggui-ai/ui-gen/harness` alongside the
// Harness type vocabulary.
//
// Scope:
// - Generic execution machinery — drives the DAG, doesn't know how to
//   run individual tasks. Task handlers are pluggable via the taskRunners
//   parameter, keyed by task.id (or a fallback).
// - Single-pass / staged / staged-concurrent all work under one executor.
// - No LLM coupling here — that belongs to the specific task runners the
//   caller registers.
//
// Failure semantics:
// - If any task in a phase throws, the phase is aborted and the error
//   propagates out of runWorkflow. The caller owns the retry policy.
// - If any task returns { error }, the phase completes but the workflow
//   result carries the error; the caller decides whether to continue.

import type { DataContract, JsonValue } from "@ggui-ai/protocol";
import type { Harness, Task, TaskContext, Workflow } from "./harness/types-public.js";

/** Called by the executor to run a single task. One of these per task.id. */
export type TaskRunner = (task: Task, ctx: TaskContext) => Promise<JsonValue>;

/** Fallback runner used when no task-specific runner is registered. */
export type DefaultTaskRunner = (task: Task, ctx: TaskContext) => Promise<JsonValue>;

export interface RunWorkflowInput {
  readonly harness: Harness;
  readonly prompt: string;
  readonly contract: DataContract;
  /** Task runners by task.id. Fallback to defaultRunner for unregistered ids. */
  readonly taskRunners?: Readonly<Record<string, TaskRunner>>;
  /** Runner invoked when no task.id-specific runner is registered. */
  readonly defaultRunner?: DefaultTaskRunner;
  /** Initial context (rarely used — mostly for resume/recovery). */
  readonly initialResults?: Readonly<Record<string, JsonValue>>;
}

export interface PhaseRunResult {
  readonly phaseId: string;
  readonly taskResults: ReadonlyArray<{
    readonly taskId: string;
    readonly outputName: string;
    readonly output: JsonValue;
    readonly durationMs: number;
  }>;
  readonly durationMs: number;
}

export interface WorkflowRunResult {
  readonly workflowId: string;
  readonly phases: readonly PhaseRunResult[];
  /** Final merged results map — task outputs keyed by outputName. */
  readonly results: Readonly<Record<string, JsonValue>>;
  readonly durationMs: number;
}

/** No-op default runner — returns the task id as its output. Tests can swap. */
const noopDefaultRunner: DefaultTaskRunner = async (task) => task.id;

/**
 * Execute a workflow. Phases run sequentially; tasks within a phase run in
 * parallel via Promise.all. Task outputs accumulate into priorResults and
 * are passed to subsequent phases via the TaskContext.
 */
export async function runWorkflow(input: RunWorkflowInput): Promise<WorkflowRunResult> {
  const { harness, prompt, contract, taskRunners, defaultRunner, initialResults } = input;
  const workflow: Workflow = harness.process.workflow;

  const startTotal = Date.now();
  const priorResults: Record<string, JsonValue> = { ...(initialResults ?? {}) };
  const phaseResults: PhaseRunResult[] = [];
  const runners = taskRunners ?? {};
  const fallback = defaultRunner ?? noopDefaultRunner;

  for (const phase of workflow.phases) {
    const phaseStart = Date.now();

    const ctx: TaskContext = {
      harness,
      priorResults: { ...priorResults },
      classification: harness.classification,
      prompt,
      contract,
    };

    const taskPromises = phase.tasks.map(async (task) => {
      const taskStart = Date.now();
      const runner = runners[task.id] ?? fallback;
      const output = await runner(task, ctx);
      return {
        taskId: task.id,
        outputName: task.outputName,
        output,
        durationMs: Date.now() - taskStart,
      };
    });

    const taskResults = await Promise.all(taskPromises);

    // Merge outputs into priorResults for the next phase.
    for (const tr of taskResults) {
      priorResults[tr.outputName] = tr.output;
    }

    phaseResults.push({
      phaseId: phase.id,
      taskResults,
      durationMs: Date.now() - phaseStart,
    });
  }

  return {
    workflowId: workflow.id,
    phases: phaseResults,
    results: { ...priorResults },
    durationMs: Date.now() - startTotal,
  };
}
