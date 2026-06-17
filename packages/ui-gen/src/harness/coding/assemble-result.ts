// Convert a finished CodingSession + GenerateTelemetry into the
// GenerationResult shape callers expect at the dispatchGeneration
// boundary.

import { getActionableIssues } from "../../evaluation/types-public.js";
import type { GenerationResult } from "../result-types.js";
import type { CodingSession } from "./init-session.js";
import type { GenerateTelemetry } from "./generate-task-runner.js";

export interface AssembleResultInput {
  readonly session: CodingSession;
  readonly telemetry: GenerateTelemetry;
  /** Final source — the closure returns this; pass it through here. */
  readonly source: string;
}

/**
 * Build the GenerationResult, log the final timing + SUMMARY lines, and
 * cleanup the coding agent. Mirrors the tail of runSimpleHarness exactly.
 *
 * Caller must invoke this AFTER the generate runner has finished and
 * BEFORE returning to its own caller — agent cleanup is non-optional.
 */
export async function assembleGenerationResult(
  input: AssembleResultInput,
): Promise<GenerationResult> {
  const { session, telemetry, source } = input;
  const a1Mode = session.harness.process.mode === "staged";

  // ── auto-improve: signal background work if warns remain after pass ──
  let needsBackgroundImprovement = false;
  if (
    session.qualityMode === "auto-improve" &&
    telemetry.evalResult &&
    session.tiersMod
  ) {
    const remaining = getActionableIssues(
      telemetry.evalResult,
      "high-quality",
    );
    if (remaining.length > 0) {
      needsBackgroundImprovement = true;
      console.log(
        `[simple] auto-improve: ${remaining.length} remaining issues → background improvement needed`,
      );
    }
  }

  // ── Timing ──
  // `telemetry.codingMs` captures the FULL inner loop (coding turns + eval
  // rounds + eval-fix turns). Coding-only time is computed by subtracting
  // accumulated eval wall. `setupMs` catches everything outside the loop
  // (session init, pre-warm, agent cleanup is after this block so it's not
  // included but typically < 100ms). Invariant: codingOnlyMs + evalWallMs
  // + setupMs ≈ totalMs (within a few ms of measurement slop).
  const totalMs = Date.now() - session.startedAtMs;
  const evalWallMs = telemetry.cumulativeEvalWallMs;
  const codingOnlyMs = Math.max(0, telemetry.codingMs - evalWallMs);
  const setupMs = Math.max(0, totalMs - telemetry.codingMs);
  const timing: Record<string, number> = {
    codingMs: codingOnlyMs,
    evalMs: evalWallMs,
    setupMs,
    totalMs,
  };

  await session.codingAgent.cleanup();

  console.log(
    `[simple] timing: coding=${codingOnlyMs}ms eval=${evalWallMs}ms setup=${setupMs}ms total=${totalMs}ms`,
  );
  console.log(
    `[simple] DONE | ${totalMs}ms | turns=${telemetry.turnsUsed} | ` +
      `evalRounds=${telemetry.evalRoundsUsed} | ` +
      `tokens=${telemetry.totalIn + telemetry.totalOut} | ` +
      `compiled=${telemetry.compiledCode.length}B`,
  );

  // Machine-parseable breakdown — key=value so grep/awk parses without regex heroics.
  const { phases, outcomes } = telemetry.counters;
  console.log(
    `[simple] SUMMARY | turns=${telemetry.turnsUsed} ` +
      `impl=${phases.impl} patch=${phases.patch} evalFix=${phases.evalFix}` +
      (a1Mode ? ` scaffold=${phases.scaffold} fill=${phases.fill}` : "") +
      ` | ` +
      `pass=${outcomes.pass} patchInvalid=${outcomes.patchInvalid} ` +
      `selfCheckFail=${outcomes.selfCheckFail} diffFail=${outcomes.diffFail} | ` +
      `evalRounds=${telemetry.evalRoundsUsed} | ` +
      `codingLlmMs=${telemetry.cumulativeLlmMs} ` +
      `evalLlmMs=${telemetry.cumulativeEvalLlmMs} ` +
      `toolMs=${telemetry.cumulativeToolMs} ` +
      `evalWallMs=${evalWallMs}`,
  );

  return {
    compiledCode: telemetry.compiledCode,
    sourceCode: source,
    tokens: {
      input: telemetry.totalIn,
      output: telemetry.totalOut,
      total: telemetry.totalIn + telemetry.totalOut,
    },
    // Prompt-cache counters are provider-specific — pass through truthfully.
    // Absent on the telemetry (provider didn't report) stays absent here,
    // never defaulted to 0, so the downstream observability ratio reflects
    // real cache activity instead of a structural zero.
    ...(telemetry.cacheReadTokens !== undefined
      ? { cacheReadTokens: telemetry.cacheReadTokens }
      : {}),
    ...(telemetry.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: telemetry.cacheCreationTokens }
      : {}),
    generationTimeMs: totalMs,
    turnsUsed: telemetry.turnsUsed,
    passesUsed: 1,
    evalResult: telemetry.evalResult,
    needsBackgroundImprovement,
    selfCheckPassed: telemetry.selfCheckPassed,
    timing,
    breakdown: {
      phases: { ...phases },
      outcomes: { ...outcomes },
      evalRounds: telemetry.evalRoundsUsed,
      // `llmMs` retained as coding-turn LLM (stable semantics for existing
      // consumers in benchmarks/multi-sdk/runner.ts:312); `evalLlmMs` is
      // new, covers eval-round parallel LLM+visual wall-time.
      llmMs: telemetry.cumulativeLlmMs,
      evalLlmMs: telemetry.cumulativeEvalLlmMs,
      toolMs: telemetry.cumulativeToolMs,
      evalMs: evalWallMs,
      codingMs: codingOnlyMs,
      setupMs,
    },
  };
}
