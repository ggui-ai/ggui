// Closure-based generate TaskRunner — wraps a CodingSession and drives
// the multi-turn coding + eval loop.
//
// The closure captures all per-generation mutable state (totals,
// breakdowns, prevModeSubcats, evalRoundsUsed, phase machine, …) so the
// same coding agent + workspace + pre-warm carry across every iteration
// runHarness drives. This matters for prompt-cache reuse: the agent is
// never recreated between turns, so the cache stays warm.
//
// Wired into dispatchGeneration via
// runHarness({ taskRunners: { generate } }).

import type { Classification } from "../../classifier/index.js";
import type { JsonValue } from "@ggui-ai/protocol";
import type { EvalResult } from "../../evaluation/types-public.js";
import type { Harness, Task, TaskContext } from "../types-public.js";
import type { SingleComponentParams } from "../runtime.js";
import type { TaskRunner } from "../index.js";
import type { CodingSession } from "./init-session.js";
import {
  runCodingTurn,
  type A1Phase,
} from "./run-coding-turn.js";
import { runEvalRound } from "./run-eval-round.js";

type PreWarmedEvalContext =
  import("../../evaluation/llm-evaluator.js").PreWarmedEvalContext;

/**
 * Per-generation breakdown counters — exposed so result assembly can
 * read them back after the closure finishes.
 */
export interface BreakdownCounters {
  phases: { impl: number; patch: number; evalFix: number; scaffold: number; fill: number };
  outcomes: { pass: number; patchInvalid: number; selfCheckFail: number; diffFail: number };
}

/**
 * Per-generation telemetry handles. The closure mutates these in place;
 * the lifecycle owner reads them after generate returns to assemble the
 * GenerationResult.
 */
export interface GenerateTelemetry {
  readonly counters: BreakdownCounters;
  /** Read after generate(): turns the closure actually ran. */
  turnsUsed: number;
  /** Read after generate(): eval rounds the closure actually ran. */
  evalRoundsUsed: number;
  /** Cumulative LLM wall-time across coding turns only. Does NOT include
   *  eval-round LLM calls (those live in {@link cumulativeEvalLlmMs}). */
  cumulativeLlmMs: number;
  /** Cumulative tool-execution wall-time across all turns. */
  cumulativeToolMs: number;
  /** Cumulative wall-clock across all eval rounds. Measured at the
   *  runEvalRound call-site (includes axis-checks, parallel LLM+visual,
   *  merge, logging). */
  cumulativeEvalWallMs: number;
  /** Cumulative parallel-wall of LLM eval calls inside eval rounds (wraps the
   *  `Promise.all([runLLMEvaluation, runVisualEval])` in run-eval-round.ts).
   *  Distinct from {@link cumulativeLlmMs}, which is coding-turn only. */
  cumulativeEvalLlmMs: number;
  /** Total input tokens billed across coding + eval. */
  totalIn: number;
  /** Total output tokens billed across coding + eval. */
  totalOut: number;
  /** Latest evalResult — undefined when eval was disabled or never ran. */
  evalResult: EvalResult | undefined;
  /** Latest compiled code — empty string until the first self-check pass. */
  compiledCode: string;
  /**
   * Source that pairs with `compiledCode`. Distinct from
   * `session.workspace.read()` because a later eval-fix turn may have
   * mutated the workspace without producing a passing compile. The
   * caller (dispatchGeneration) returns THIS string as the final source
   * so that source ↔ compiled stay paired across the boundary.
   */
  pairedSource: string;
  /** True after at least one self-check passed. */
  selfCheckPassed: boolean;
  /** True after onInitialResult fired (or would have fired). */
  initialResultDelivered: boolean;
  /** Wall-clock when coding loop started (set when generate is invoked). */
  codingStartedAtMs: number;
  /** Time spent in coding loop only — set when the loop exits. */
  codingMs: number;
}

/**
 * Build a fresh telemetry record. One per generate-runner instance.
 */
export function createTelemetry(): GenerateTelemetry {
  return {
    counters: {
      phases: { impl: 0, patch: 0, evalFix: 0, scaffold: 0, fill: 0 },
      outcomes: { pass: 0, patchInvalid: 0, selfCheckFail: 0, diffFail: 0 },
    },
    turnsUsed: 0,
    evalRoundsUsed: 0,
    cumulativeLlmMs: 0,
    cumulativeToolMs: 0,
    cumulativeEvalWallMs: 0,
    cumulativeEvalLlmMs: 0,
    totalIn: 0,
    totalOut: 0,
    evalResult: undefined,
    compiledCode: "",
    pairedSource: "",
    selfCheckPassed: false,
    initialResultDelivered: false,
    codingStartedAtMs: 0,
    codingMs: 0,
  };
}

export interface CreateGenerateRunnerInput {
  readonly session: CodingSession;
  readonly params: SingleComponentParams;
  readonly classification: Classification;
  /** Mutated in place — caller reads after generate() returns. */
  readonly telemetry: GenerateTelemetry;
  /** Hard cap on coding turns (defaults to 30 to match runSimpleHarness). */
  readonly maxTurns?: number;
}

/**
 * Build a `generate` TaskRunner that drives the full multi-turn coding +
 * eval loop using the captured session. Returns the final source string
 * (read from workspace.read()) as its task output.
 *
 * The TaskRunner ignores its `task` and `ctx` params — it derives all
 * inputs from the closure-captured session/params/classification, so
 * the same instance works across runHarness iterations without needing
 * workflow-context plumbing for feedback.
 */
export function createGenerateTaskRunner(input: CreateGenerateRunnerInput): TaskRunner {
  const { session, params, classification, telemetry } = input;
  const maxTurns = input.maxTurns ?? 30;

  // ── Process-mode phase machine ──
  // staged → A1 scaffold → fill → post; everything else → "post" from turn 1.
  const a1Mode = session.harness.process.mode === "staged";
  let a1Phase: A1Phase = a1Mode ? "scaffold" : "post";

  // ── Mutable loop state owned by the closure (preserved across iterations) ──
  let lastResultText = "";
  let lastDiffFailed = false;
  let isEvalFeedback = false;
  let iconNamesCache: string | null = null;
  let preWarmedContext: PreWarmedEvalContext | null | undefined;
  let prevModeSubcats = new Set<string>();
  let prevFailFingerprints = new Set<string>();
  let evalDone = false;

  return async function generate(_task: Task, _ctx: TaskContext): Promise<JsonValue> {
    // Mark the start of the coding window for telemetry / SUMMARY logging.
    if (telemetry.codingStartedAtMs === 0) {
      telemetry.codingStartedAtMs = Date.now();
      params.onProgress?.({ type: "generating", phase: "coding" });
    }

    do {
      telemetry.turnsUsed++;

      // ── One coding turn ──
      const turn = await runCodingTurn(
        {
          workspace: session.workspace,
          codingAgent: session.codingAgent,
          codingModel: session.agents.coding.model,
          systemPrompt: session.systemPrompt,
          harness: session.harness,
          contract: params.contract,
          commitMeta: session.commitMeta,
          originalProps: session.originalProps,
          costTracker: session.costTracker,
          // Thread the dispatch-resolved policy so experimental
          // profiles take effect on both preflight and tier-0 retry
          // feedback.
          contextPolicy: session.resolvedPolicy.context,
          // Dupe-break state is mutable; runCodingTurn updates it in
          // place (fingerprint + cooldown + forceEscape +
          // scopedEscapeUsedCount).
          dupeBreak: session.dupeBreak,
        },
        {
          turnsUsed: telemetry.turnsUsed,
          a1Phase,
          lastResultText,
          lastDiffFailed,
          isEvalFeedback,
          iconNamesCache,
          preWarmedContext,
          preWarmPromise: session.preWarmPromise,
        },
      );

      telemetry.totalIn += turn.tokens.input;
      telemetry.totalOut += turn.tokens.output;
      telemetry.cumulativeLlmMs += turn.llmMs;
      telemetry.cumulativeToolMs += turn.toolMs;
      iconNamesCache = turn.iconNamesCache;
      preWarmedContext = turn.preWarmedContext;

      if (turn.phase) {
        if (turn.phase === "scaffold") telemetry.counters.phases.scaffold++;
        else if (turn.phase === "fill") telemetry.counters.phases.fill++;
        else if (turn.phase === "impl") telemetry.counters.phases.impl++;
        else if (turn.phase === "eval-fix") telemetry.counters.phases.evalFix++;
        else telemetry.counters.phases.patch++;
      }
      if (turn.outcome) {
        if (turn.outcome === "PASS") telemetry.counters.outcomes.pass++;
        else if (turn.outcome === "PATCH_INVALID") telemetry.counters.outcomes.patchInvalid++;
        else if (turn.outcome === "DIFF_FAIL") telemetry.counters.outcomes.diffFail++;
        else telemetry.counters.outcomes.selfCheckFail++;
      }

      if (turn.control === "break") break;
      if (turn.control === "continue") {
        lastResultText = turn.lastResultText;
        lastDiffFailed = turn.lastDiffFailed;
        isEvalFeedback = turn.isEvalFeedback;
        continue;
      }

      // ── Self-check passed (control === "proceed") ──
      telemetry.compiledCode = turn.compiledCode;
      // Pair the source that was just compiled. workspace.read() at this
      // point reflects the patch the LLM just applied AND that the
      // compile passed — so source/compiled match. A later failed
      // eval-fix turn may mutate the workspace, so we snapshot the
      // pairing now and only update on subsequent proceeds.
      telemetry.pairedSource = session.workspace.read() ?? "";
      telemetry.selfCheckPassed = turn.selfCheckPassed;

      // ── A1: scaffold passed → transition to fill ──
      if (a1Mode && a1Phase === "scaffold" && telemetry.selfCheckPassed && telemetry.compiledCode) {
        console.log(
          `[simple] A1: scaffold compiled (${telemetry.compiledCode.length}B, turns=${telemetry.turnsUsed}) → entering fill phase`,
        );
        a1Phase = "fill";
        telemetry.selfCheckPassed = false;
        telemetry.compiledCode = "";
        telemetry.pairedSource = "";
        lastResultText = "";
        isEvalFeedback = false;
        continue;
      }
      if (a1Mode && a1Phase === "fill" && telemetry.selfCheckPassed) {
        console.log(`[simple] A1: fill completed (turns=${telemetry.turnsUsed}) → post phase`);
        a1Phase = "post";
      }

      // ── Deliver initial result on first successful compile ──
      if (!telemetry.initialResultDelivered && telemetry.compiledCode) {
        const sourceCode = session.workspace.read() ?? "";
        console.log(`[simple] compiled: ${telemetry.compiledCode.length}B`);
        if (params.onInitialResult) {
          await params.onInitialResult({ componentCode: telemetry.compiledCode, sourceCode });
        }
        telemetry.initialResultDelivered = true;

        const codingDoneMs = Date.now() - telemetry.codingStartedAtMs;
        console.log(
          `[simple] initial result delivered | ${codingDoneMs}ms | turns=${telemetry.turnsUsed} | tokens=${telemetry.totalIn + telemetry.totalOut} | compiled=${telemetry.compiledCode.length}B`,
        );
      }

      // ── Eval round ──
      if (
        !evalDone &&
        telemetry.compiledCode &&
        session.tiersMod &&
        (session.codeEvalEnabled || session.visualEvalEnabled)
      ) {
        // Measure eval-round wall-clock here (not inside runEvalRound) so the
        // accumulator covers axis-checks + LLM+visual parallel + merge +
        // logging. Complements cumulativeEvalLlmMs which measures only the
        // inner Promise.all.
        const evalRoundStart = Date.now();
        const round = await runEvalRound(
          {
            workspace: session.workspace,
            harness: session.harness,
            contract: params.contract,
            userPrompt: params.userPrompt,
            fixtureProps: params.fixtureProps,
            classification,
            evaluationAgent: session.agents.evaluation,
            visualEvalAgent: session.agents.visualEval,
            visualEvaluation: params.visualEvaluation,
            visualThreshold: session.visualThreshold,
            qualityMode: session.qualityMode,
            maxEvalRounds: session.maxEvalRounds,
            costTracker: session.costTracker!,
            llmEvalMod: session.llmEvalMod,
            visualMod: session.visualMod,
            preWarmPromise: session.preWarmPromise,
            onProgress: params.onProgress,
          },
          {
            compiledCode: telemetry.compiledCode,
            evalRoundsUsed: telemetry.evalRoundsUsed,
            preWarmedContext,
            prevModeSubcats,
            prevFailFingerprints,
          },
        );
        telemetry.cumulativeEvalWallMs += Date.now() - evalRoundStart;
        telemetry.cumulativeEvalLlmMs += round.evalLlmMs;

        telemetry.evalRoundsUsed = round.evalRoundsUsed;
        prevModeSubcats = round.prevModeSubcats;
        prevFailFingerprints = round.prevFailFingerprints;
        preWarmedContext = round.preWarmedContext;
        if (round.evalResult) telemetry.evalResult = round.evalResult;
        evalDone = round.evalDone;
        telemetry.totalIn += round.evalTokens.input;
        telemetry.totalOut += round.evalTokens.output;

        if (round.control === "break") break;
        // round.control === "feedback" — set next coding turn input.
        lastResultText = round.lastResultText;
        isEvalFeedback = round.isEvalFeedback;
        lastDiffFailed = round.lastDiffFailed;
      } else {
        // Eval not enabled or already done — exit loop.
        break;
      }
    } while (telemetry.turnsUsed < maxTurns && !evalDone);

    telemetry.codingMs = Date.now() - telemetry.codingStartedAtMs;

    // ── Fallback: pull compiled code from commitMeta if loop exited dry ──
    // Walks commitMeta back to its most recent successful compile and uses
    // the workspace state at THIS moment as the paired source. Imperfect
    // (workspace may have drifted past the commit), but matches donor
    // behavior. The honest pairing path above (in the proceed branch)
    // covers the common case.
    if (!telemetry.compiledCode) {
      for (const [, meta] of session.commitMeta) {
        if (meta.build.success && meta.selfCheck.passed && meta.build.compiledCode) {
          telemetry.compiledCode = meta.build.compiledCode;
          telemetry.selfCheckPassed = true;
        }
      }
      if (!telemetry.compiledCode) {
        for (const [, meta] of session.commitMeta) {
          if (meta.build.success && meta.build.compiledCode) {
            telemetry.compiledCode = meta.build.compiledCode;
          }
        }
      }
      if (telemetry.compiledCode && !telemetry.pairedSource) {
        telemetry.pairedSource = session.workspace.read() ?? "";
      }
      console.log(`[simple] compiled (fallback): ${telemetry.compiledCode.length}B`);
    }

    // ── Deliver result if not yet delivered ──
    if (!telemetry.initialResultDelivered && params.onInitialResult && telemetry.compiledCode) {
      await params.onInitialResult({
        componentCode: telemetry.compiledCode,
        sourceCode: telemetry.pairedSource,
      });
    }

    // Return the paired source — the one that corresponds to compiledCode.
    // dispatchGeneration uses this same value as the canonical final source
    // so source ↔ compiled stay in sync at the boundary. Falls back to
    // workspace.read() only when no compile succeeded (no pairing exists).
    return telemetry.pairedSource || (session.workspace.read() ?? "");
  };
}

/** Read-only view of a partially-typed harness — passed where TaskContext does. */
export type GenerateTaskRunner = ReturnType<typeof createGenerateTaskRunner>;

/** Convenience export so callers can import the harness type without round-trips. */
export type { Harness };
