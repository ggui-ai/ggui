// packages/ui-gen/src/run-check.ts
//
// Post-workflow evaluation stage. Runs every check registered on a harness's
// CheckLeg against produced source and returns a flat issue list.
//
// Pure orchestration — iterates the harness's CheckLeg and runs each
// check. Check BODIES (axis-check registry entries, tier-0 checks, LLM
// evaluator, runtime-render adapter) are injected at harness
// construction.
//
// Scope:
// - Runs axisChecks (already-filtered at createHarness time).
// - Runs tierChecks (deterministic, no LLM).
// - Delegates LLM evaluation to harness.check.llmEvaluator when present.
// - Delegates runtime-render to harness.check.runtimeRender when present.

import type { DataContract, JsonObject } from "@ggui-ai/protocol";
import type { EvalIssue, AxisCheckInput } from "./evaluation/types-public.js";
import type { CheckLeg, Harness } from "./harness/types-public.js";
import {
  emitValidatorTraceEvent,
  newValidatorTraceId,
  truncateSourceForTrace,
} from "./harness/validator-trace-sink.js";

export interface RunCheckInput {
  readonly sourceCode: string;
  readonly compiledCode: string | null;
  readonly contract?: DataContract;
  readonly prompt: string;
  readonly harness: Harness;
  /**
   * Optional fixture props (e.g., from a benchmark commit's `props` field).
   * Forwarded to runtimeRender for schema-first mockup synthesis.
   */
  readonly fixtureProps?: JsonObject;
  /**
   * When true, skip the runtime-render probe even if the harness has one.
   * Used by the eval-round runner to keep the probe (~500ms-2s) off the
   * per-turn hot path; the runner runs the probe ONCE at exit-decision
   * time via `harness.check.runtimeRender.run` directly.
   */
  readonly skipRuntimeRender?: boolean;
}

export interface CheckResult {
  readonly issues: readonly EvalIssue[];
  readonly axisIssueCount: number;
  readonly tierIssueCount: number;
  readonly llmIssueCount: number;
  readonly runtimeRenderIssueCount: number;
  readonly firedCheckIds: readonly string[];
}

/**
 * Run every check on a CheckLeg against produced source. Returns all issues
 * with per-source counts for telemetry.
 *
 * Pre-filtering invariant: `check.axisChecks` already only contains checks
 * whose `matches()` gate passed at createHarness time, so this function
 * does no re-matching — it just iterates and runs.
 */
export async function runCheck(input: RunCheckInput): Promise<CheckResult> {
  const { harness, sourceCode, compiledCode, contract, prompt } = input;
  const check: CheckLeg = harness.check;
  const startedAt = Date.now();

  if (compiledCode === null) {
    const result: CheckResult = {
      issues: [],
      axisIssueCount: 0,
      tierIssueCount: 0,
      llmIssueCount: 0,
      runtimeRenderIssueCount: 0,
      firedCheckIds: [],
    };
    // Emit a trace event even for the no-compile short-circuit so the
    // devtools UI sees the call ran (and can show "compile failed →
    // checks skipped").
    const endedAt = Date.now();
    emitValidatorTraceEvent({
      id: newValidatorTraceId(),
      at: startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      harnessId: harness.id,
      classification: harness.classification,
      workflowId: harness.process.workflow.id,
      hadCompiledCode: false,
      skippedRuntimeRender: input.skipRuntimeRender ?? false,
      summary: {
        totalIssues: 0,
        axisIssues: 0,
        tierIssues: 0,
        llmIssues: 0,
        runtimeRenderIssues: 0,
        firedCheckIds: [],
      },
      issues: [],
      sourceCode: truncateSourceForTrace(sourceCode),
      prompt,
    });
    return result;
  }

  const issues: EvalIssue[] = [];
  const firedIds: string[] = [];

  // ── Axis checks (deterministic, pre-gated on harness) ─────────────────
  const axisInput: AxisCheckInput = {
    sourceCode,
    compiledCode,
    contract: contract,
    originalPrompt: prompt,
    classification: harness.classification,
  };
  let axisIssueCount = 0;
  const seenAxisIds = new Set<string>();
  for (const axisCheck of check.axisChecks) {
    if (seenAxisIds.has(axisCheck.id)) continue;
    seenAxisIds.add(axisCheck.id);
    firedIds.push(axisCheck.id);
    const axisIssues = axisCheck.run(axisInput);
    issues.push(...axisIssues);
    axisIssueCount += axisIssues.length;
  }

  // ── Tier checks (deterministic, harness-owned) ────────────────────────
  let tierIssueCount = 0;
  for (const tierCheck of check.tierChecks) {
    firedIds.push(tierCheck.id);
    const tierIssues = await tierCheck.run({ sourceCode, compiledCode });
    issues.push(...tierIssues);
    tierIssueCount += tierIssues.length;
  }

  // ── Runtime render check (deterministic, ~50-1000ms warm/cold) ────────
  // 2026-04-27: probe runs ONLY when prior cheap checks (axis + tier)
  // produced no tier-0 failures. Rationale: probe is the "does this
  // actually work at runtime" gate — wasting ~50-1000ms probing a
  // component the deterministic checks already rejected adds latency
  // with no signal (the LLM is going to fix self-check first anyway,
  // and probe issues on broken-self-check code are noise, not
  // actionable feedback).
  //
  // When axis/tier are clean and probe finds wiring bugs (action not
  // wired, useStream subscribed but never read, prop never rendered),
  // those issues feed back through the same `issues` channel as
  // self-check failures — coding agent gets one more turn with the
  // probe diagnostic. Goal: 0 probe failures on success path.
  let runtimeRenderIssueCount = 0;
  if (check.runtimeRender && !input.skipRuntimeRender) {
    const cheapTier0Failures = issues.filter(
      i => i.result === "fail" && (i.tier === 0 || i.tier === undefined),
    ).length;
    if (cheapTier0Failures === 0) {
      firedIds.push(check.runtimeRender.id);
      const runtimeIssues = await check.runtimeRender.run({
        sourceCode,
        compiledCode,
        contract,
        fixtureProps: input.fixtureProps,
      });
      issues.push(...runtimeIssues);
      runtimeRenderIssueCount = runtimeIssues.length;
    }
  }

  // ── LLM evaluator (optional, async) ───────────────────────────────────
  let llmIssueCount = 0;
  if (check.llmEvaluator && contract) {
    firedIds.push(check.llmEvaluator.id);
    const llmIssues = await check.llmEvaluator.run({
      sourceCode,
      compiledCode,
      contract,
      prompt,
    });
    issues.push(...llmIssues);
    llmIssueCount = llmIssues.length;
  }

  const result: CheckResult = {
    issues,
    axisIssueCount,
    tierIssueCount,
    llmIssueCount,
    runtimeRenderIssueCount,
    firedCheckIds: firedIds,
  };

  // Emit one validator-trace event capturing the full per-tier
  // breakdown. Devtools-only — no-op when no sink registered (see
  // validator-trace-sink.ts).
  const endedAt = Date.now();
  emitValidatorTraceEvent({
    id: newValidatorTraceId(),
    at: startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    harnessId: harness.id,
    classification: harness.classification,
    workflowId: harness.process.workflow.id,
    hadCompiledCode: true,
    skippedRuntimeRender: input.skipRuntimeRender ?? false,
    summary: {
      totalIssues: issues.length,
      axisIssues: axisIssueCount,
      tierIssues: tierIssueCount,
      llmIssues: llmIssueCount,
      runtimeRenderIssues: runtimeRenderIssueCount,
      firedCheckIds: firedIds,
    },
    issues,
    sourceCode: truncateSourceForTrace(sourceCode),
    prompt,
  });

  return result;
}
