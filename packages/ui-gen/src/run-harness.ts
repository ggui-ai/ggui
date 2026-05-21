// packages/ui-gen/src/run-harness.ts
//
// End-to-end orchestration: run a harness's workflow to produce source,
// then run the check leg on the result. Owns retry policy (derive new
// harness + re-run on failure, up to harness.process.retry.maxIterations).
//
// Combines runWorkflow + runCheck + the derive loop — the top of the
// orchestration spine. Re-exported via `@ggui-ai/ui-gen/harness`
// alongside runWorkflow + runCheck.
//
// Shape:
//   for iteration in 1..maxIterations:
//     workflowResult = await runWorkflow(harness, ctx, taskRunners)
//     source = workflowResult.results.source
//     if !source: return { ok: false, reason: "no source produced" }
//     checkResult = await runCheck(harness, source)
//     if passingThreshold(checkResult): return { ok: true, source, ... }
//     harness = harness.derive(decideRevision(harness, checkResult))

import type { DataContract } from "@ggui-ai/protocol";
import type { Harness } from "./harness/types-public.js";
import { runWorkflow, type TaskRunner, type WorkflowRunResult } from "./run-workflow.js";
import { runCheck, type CheckResult } from "./run-check.js";

export interface RunHarnessInput {
  readonly harness: Harness;
  readonly prompt: string;
  readonly contract: DataContract;
  readonly taskRunners: Readonly<Record<string, TaskRunner>>;
  readonly compile?: (source: string) => Promise<string | null>;
  readonly passes?: (result: CheckResult) => boolean;
  readonly maxIterations?: number;
  /**
   * Skip runCheck() entirely — for callers that have already evaluated
   * the source themselves and don't want the duplicate work. When true,
   * the iteration record's checkResult is empty and `passes` is not
   * consulted; the iteration is treated as passed unconditionally.
   *
   * Used by dispatchGeneration during the runHarness migration: the
   * closure-based generate runner does its own multi-round eval inside
   * the workflow, so re-running runCheck here would re-fire LLM + visual
   * eval needlessly (~5s wasted per generation).
   */
  readonly skipCheck?: boolean;
}

export type RunHarnessReason =
  | "passed"
  | "no-source"
  | "compile-failed"
  | "max-iterations";

export interface IterationRecord {
  readonly iteration: number;
  readonly harnessId: string;
  readonly workflowId: string;
  readonly source: string | null;
  readonly compiled: string | null;
  readonly workflowDurationMs: number;
  readonly checkDurationMs: number;
  readonly issueCount: number;
  readonly firedCheckIds: readonly string[];
}

export interface RunHarnessResult {
  readonly ok: boolean;
  readonly reason: RunHarnessReason;
  readonly finalHarness: Harness;
  readonly finalSource: string | null;
  readonly finalCompiled: string | null;
  readonly finalCheck: CheckResult | null;
  readonly iterations: readonly IterationRecord[];
  readonly durationMs: number;
}

const defaultPasses = (r: CheckResult): boolean =>
  r.issues.every((i) => i.result !== "fail");

/**
 * Run harness end-to-end: workflow → compile → check → derive-on-fail.
 *
 * Caller must supply taskRunners — at minimum, a runner for each task in
 * the workflow's phases. The `generate` task (single_pass) should return
 * the produced source as a string.
 */
export async function runHarness(input: RunHarnessInput): Promise<RunHarnessResult> {
  const {
    harness: initialHarness,
    prompt,
    contract,
    taskRunners,
    compile,
    passes = defaultPasses,
    maxIterations: explicitMax,
    skipCheck = false,
  } = input;

  const maxIterations = explicitMax ?? initialHarness.process.retry.maxIterations;
  const start = Date.now();
  const iterations: IterationRecord[] = [];

  let harness = initialHarness;
  let lastSource: string | null = null;
  let lastCompiled: string | null = null;
  let lastCheck: CheckResult | null = null;

  for (let i = 1; i <= maxIterations; i++) {
    const workflowResult: WorkflowRunResult = await runWorkflow({
      harness,
      prompt,
      contract,
      taskRunners,
    });

    const source = (workflowResult.results.source ?? null) as string | null;
    let compiled: string | null = null;
    if (source && compile) {
      compiled = await compile(source);
    } else if (source && !compile) {
      compiled = source;
    }

    // Compile failure is a hard fail. We must NOT fall through to runCheck()
    // — its compile-null branch returns an empty issue set, which the default
    // pass predicate would happily accept as "no failures = passed". Bail out
    // explicitly so the iteration record reflects the actual failure mode.
    const compileFailed = source !== null && compile !== undefined && compiled === null;

    const checkStart = Date.now();
    const checkResult = source && !compileFailed && !skipCheck
      ? await runCheck({ harness, sourceCode: source, compiledCode: compiled, contract, prompt })
      : { issues: [], axisIssueCount: 0, tierIssueCount: 0, llmIssueCount: 0, runtimeRenderIssueCount: 0, firedCheckIds: [] };
    const checkDurationMs = Date.now() - checkStart;

    iterations.push({
      iteration: i,
      harnessId: harness.id,
      workflowId: harness.process.workflow.id,
      source,
      compiled,
      workflowDurationMs: workflowResult.durationMs,
      checkDurationMs,
      issueCount: checkResult.issues.length,
      firedCheckIds: checkResult.firedCheckIds,
    });

    lastSource = source;
    lastCompiled = compiled;
    lastCheck = checkResult;

    if (!source) {
      return buildResult({
        ok: false,
        reason: "no-source",
        finalHarness: harness,
        finalSource: null,
        finalCompiled: null,
        finalCheck: checkResult,
        iterations,
        start,
      });
    }

    if (compileFailed) {
      // Don't keep iterating on a compile failure unless the harness has a
      // derive policy that would change codegen — for now, treat it as a
      // terminal signal, the same way no-source is terminal. A future PR can
      // make this iteration-aware once derive policies exist that target it.
      return buildResult({
        ok: false,
        reason: "compile-failed",
        finalHarness: harness,
        finalSource: source,
        finalCompiled: null,
        finalCheck: checkResult,
        iterations,
        start,
      });
    }

    if (passes(checkResult)) {
      return buildResult({
        ok: true,
        reason: "passed",
        finalHarness: harness,
        finalSource: source,
        finalCompiled: compiled,
        finalCheck: checkResult,
        iterations,
        start,
      });
    }

    if (i < maxIterations) {
      // Default revision: re-run same harness. Real deriders (planner,
      // runtime fallback, classification swap) plug in via harness.process.retry
      // or an explicit revision function (future API).
      harness = harness.derive({});
    }
  }

  return buildResult({
    ok: false,
    reason: "max-iterations",
    finalHarness: harness,
    finalSource: lastSource,
    finalCompiled: lastCompiled,
    finalCheck: lastCheck,
    iterations,
    start,
  });
}

function buildResult(args: {
  ok: boolean;
  reason: RunHarnessReason;
  finalHarness: Harness;
  finalSource: string | null;
  finalCompiled: string | null;
  finalCheck: CheckResult | null;
  iterations: IterationRecord[];
  start: number;
}): RunHarnessResult {
  return {
    ok: args.ok,
    reason: args.reason,
    finalHarness: args.finalHarness,
    finalSource: args.finalSource,
    finalCompiled: args.finalCompiled,
    finalCheck: args.finalCheck,
    iterations: args.iterations,
    durationMs: Date.now() - args.start,
  };
}
