// packages/ui-gen/src/harness/coding/run-eval-round.ts
//
// One eval round (axis-checks + LLM eval + visual eval + merge + feedback
// formatting), extracted from runSimpleHarness as part of the runHarness
// migration (#142, step 2).
//
// Owns: the eval-round body — runCheck dispatch, low-risk bypass, parallel
// LLM + visual eval, cost tracking, issue merge, cross-round subcategory
// diff log, the continue/break/feedback decision, and feedback formatting
// (capped at MAX_FEEDBACK_ISSUES per turn).
//
// Does NOT own: the do/while wrapper, the eligibility gate at the call
// site (`!evalDone && compiledCode && tiersMod && (codeEval || visualEval)`),
// or the threading of mutable state — caller still owns those for now and
// the closure migration (step 3) will move them too.
//
// Behavior MUST match the inlined original byte-for-byte — this is a
// mechanical extraction, not a redesign.

import type { DataContract, JsonObject } from "@ggui-ai/protocol";
import { listContractGadgets } from "@ggui-ai/protocol";
import type { Classification } from "../../classifier/index.js";
import type { AgentWorkspace } from "../../coding-agent/workspace.js";
import type { CostTracker } from "../../evaluation/cost-tracker.js";
import type { EvalIssue, EvalResult } from "../../evaluation/types-public.js";
import { mapProviderForEvaluator } from "../enforced-coding.js";
import { runCheck } from "../index.js";
import { isRecoverableRenderCrash } from "../check/runtime-render/index.js";
import type { Harness } from "../types-public.js";
import type { AgentSpec, SingleComponentParams } from "../runtime.js";

type PreWarmedEvalContext =
  import("../../evaluation/llm-evaluator.js").PreWarmedEvalContext;
type LlmEvalMod = typeof import("../../evaluation/llm-evaluator.js");
type VisualEvalMod = typeof import("../../evaluation/visual-evaluator.js");

/**
 * Persistent eval context — captured once per generation, reused across
 * every eval round. After step 3's closure migration, these will move
 * into the generate-runner's session state.
 */
export interface EvalRoundContext {
  readonly workspace: AgentWorkspace;
  readonly harness: Harness;
  readonly contract: DataContract | undefined;
  readonly userPrompt: string;
  readonly fixtureProps: JsonObject | undefined;
  readonly classification: Classification;
  readonly evaluationAgent: AgentSpec;
  readonly visualEvalAgent: AgentSpec;
  readonly visualEvaluation: SingleComponentParams["visualEvaluation"];
  readonly visualThreshold: number;
  readonly qualityMode: "fast" | "auto-improve" | "high-quality";
  readonly maxEvalRounds: number;
  /** Non-null inside a round — the call-site gate guarantees it's been built. */
  readonly costTracker: CostTracker;
  readonly llmEvalMod: LlmEvalMod | null;
  readonly visualMod: VisualEvalMod | null;
  readonly preWarmPromise: Promise<PreWarmedEvalContext | null> | undefined;
  readonly onProgress?: (event: unknown) => void;
}

/**
 * Per-round inputs that change between rounds.
 */
export interface EvalRoundInput {
  /** Compiled code from the most recent self-check-passing turn. */
  readonly compiledCode: string;
  /** Round counter BEFORE this round runs (function increments internally). */
  readonly evalRoundsUsed: number;
  readonly preWarmedContext: PreWarmedEvalContext | null | undefined;
  /** Mode-check subcategory keys from prior round, for cross-round diff log. */
  readonly prevModeSubcats: Set<string>;
  /**
   * Fail-fingerprints from prior round. Used by the stuck-loop detector:
   * if round N's fails are a strict subset of round N-1's fails, the LLM
   * is patching things the eval keeps re-flagging — exit early instead
   * of burning more turns. Tier-1 LLM-eval `functionality` fails are the
   * common offender on complex contract (chat-interface, kanban-board)
   * because the criterion auto-promotes any "ALL features met?" nitpick
   * to fail+critical, which the LLM can't always make go away.
   */
  readonly prevFailFingerprints: Set<string>;
}

/**
 * Flow-control instruction the caller acts on:
 *   "break"    — exit the do/while (low-risk bypass / no blocking / max
 *                rounds / budget exhausted / eval error)
 *   "feedback" — format issues into next coding turn's input; let the
 *                outer while-condition re-enter for another turn
 */
export type EvalRoundControl = "break" | "feedback";

export interface EvalRoundResult {
  readonly control: EvalRoundControl;
  /** True only on the low-risk bypass + clean-pass paths. */
  readonly evalDone: boolean;
  /** Latest evalResult — undefined only when the round didn't produce one
   *  (eval error caught at the very top before runCheck completed). */
  readonly evalResult: EvalResult | undefined;
  /** Updated round counter (caller stores back). */
  readonly evalRoundsUsed: number;
  /** Updated subcategory set (caller stores back for next round's diff log). */
  readonly prevModeSubcats: Set<string>;
  /** Updated fail-fingerprint set (caller stores back for stuck detection). */
  readonly prevFailFingerprints: Set<string>;
  readonly preWarmedContext: PreWarmedEvalContext | null | undefined;
  /** Tokens added during this round — caller adds to its own totals. */
  readonly evalTokens: { input: number; output: number };
  /** Wall-clock of the parallel LLM + visual eval block (zero on the
   *  low-risk bypass path, which exits before `Promise.all`). Caller
   *  accumulates into its `cumulativeEvalLlmMs`. */
  readonly evalLlmMs: number;
  /** Feedback state — only meaningful when control === "feedback". */
  readonly lastResultText: string;
  readonly isEvalFeedback: boolean;
  readonly lastDiffFailed: boolean;
}

/** Cap feedback to N issues per eval-fix turn so the LLM stays surgical. */
const MAX_FEEDBACK_ISSUES = 3;

/**
 * Fingerprint a fail issue for cross-round stuck detection. Identifies the
 * "same fail" without being thrown by minor description-text variation.
 * Format: `category|subcategory|first 40 chars of description, lowercased,
 * collapsed whitespace, line numbers stripped`. Line numbers are stripped
 * because the LLM may shift them while leaving the underlying bug intact —
 * we want those to fingerprint identical.
 */
function fingerprintFail(issue: EvalIssue): string {
  const cat = issue.category ?? "";
  const sub = issue.subcategory ?? "";
  const desc = (issue.description ?? "")
    .toLowerCase()
    .replace(/line\s+\d+/g, "line N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  return `${cat}|${sub}|${desc}`;
}

/**
 * Result of running the in-loop runtime probe at an exit-decision point.
 *
 * The eval-round orchestrator turns this into a `feedback` control with a
 * `[runtime]` violation when `recoverableFail === true`, granting the
 * harness ONE additional patch turn with the class-specific fix advice.
 * On `recoverableFail === false` the orchestrator falls through to the
 * original break path (the issues are still merged into the eval result
 * for telemetry / scoring).
 */
interface ProbeAtExitResult {
  readonly fired: boolean;
  /** True when probe produced ≥1 fail with a class `classifyRenderCrashFix` recognizes. */
  readonly recoverableFail: boolean;
  readonly probeIssues: readonly EvalIssue[];
}

/**
 * Run the runtime-render probe ONCE at an exit-decision point. Off the
 * per-turn hot path: `runCheck` is invoked with `skipRuntimeRender: true`
 * every round; the probe (~500ms-2s) only fires here, when the harness
 * would otherwise exit.
 *
 * Returns `{ fired: false }` when there's nothing to probe (no compiled
 * code, no runtimeRender check on the harness, or the contract is empty).
 */
async function runProbeAtExit(input: {
  harness: Harness;
  sourceCode: string;
  compiledCode: string;
  contract: DataContract | undefined;
  fixtureProps: JsonObject | undefined;
}): Promise<ProbeAtExitResult> {
  const { harness, sourceCode, compiledCode, contract, fixtureProps } = input;
  const probe = harness.check.runtimeRender;
  if (!probe || !compiledCode) {
    return { fired: false, recoverableFail: false, probeIssues: [] };
  }
  let probeIssues: readonly EvalIssue[];
  try {
    probeIssues = await probe.run({
      sourceCode,
      compiledCode,
      contract,
      fixtureProps,
    });
  } catch (e) {
    // Probe infra failure — same treatment as the in-adapter catch:
    // log + skip silently, never penalize the LLM for env mismatch.
    console.warn(
      `[simple] in-loop probe at exit: infra failure — ${e instanceof Error ? e.message : String(e)}`,
    );
    return { fired: false, recoverableFail: false, probeIssues: [] };
  }
  const recoverableFail = probeIssues.some(
    (i) =>
      i.result === "fail" &&
      typeof i.subcategory === "string" &&
      i.subcategory.startsWith("runtime:render-no-throw") &&
      typeof i.description === "string" &&
      isRecoverableRenderCrash(i.description),
  );
  return { fired: true, recoverableFail, probeIssues };
}

/**
 * Format a single probe-emitted runtime issue as a `[runtime]` feedback
 * line for the next coding turn. Mirrors the loop's existing feedback
 * formatter (`[FAIL] category/subcat: ...\n  Fix: ...`) but tags it
 * `[runtime]` so the LLM can see the violation came from the in-loop
 * runtime probe rather than self-check / LLM eval.
 */
function formatRuntimeProbeFeedback(issue: EvalIssue): string {
  const subcat = issue.subcategory ? `/${issue.subcategory}` : "";
  return (
    `[runtime] ${issue.category}${subcat}: ${issue.description}\n` +
    `  Fix: ${issue.fix ?? ""}`
  );
}

/**
 * Run one eval round. Mutates `ctx.costTracker` (records LLM eval tokens)
 * and `ctx.workspace` is read-only from this function's POV. Returns
 * flow-control + updated state; caller threads them back as variables.
 */
export async function runEvalRound(
  ctx: EvalRoundContext,
  input: EvalRoundInput,
): Promise<EvalRoundResult> {
  const {
    workspace,
    harness,
    contract,
    userPrompt,
    fixtureProps,
    classification,
    evaluationAgent,
    visualEvalAgent,
    visualEvaluation,
    visualThreshold,
    qualityMode,
    maxEvalRounds,
    costTracker,
    llmEvalMod,
    visualMod,
    preWarmPromise,
    onProgress,
  } = ctx;
  const { compiledCode, prevModeSubcats, prevFailFingerprints } = input;
  let { evalRoundsUsed, preWarmedContext } = input;

  evalRoundsUsed++;
  onProgress?.({ type: "generating", phase: "evaluating" });
  const currentSource = workspace.read() ?? "";

  let evalResult: EvalResult | undefined;
  let evalTokens = { input: 0, output: 0 };
  let evalLlmMs = 0;

  try {
    // Tier 0 already ran in autoCommit — go straight to mode-checks + LLM eval.

    // ── Axis-keyed deterministic checks ──────────────
    // Contract-semantic, no LLM call, <100ms. Pre-filtered onto
    // harness.check.axisChecks at createHarness time; runCheck iterates
    // the already-gated list. Used up front so we can bypass the
    // expensive tier-1/2 LLM eval for low-risk vectors.
    //
    // 2026-04-27 (in-loop probe trigger): skip the runtime-render probe
    // here. The probe (~500ms-2s) runs ONCE at exit-decision time below,
    // not on every round. Goal: keep per-turn latency lean while still
    // catching crash-class fails before the harness ships broken UI.
    const checkResult = await runCheck({
      harness,
      sourceCode: currentSource,
      compiledCode,
      contract,
      prompt: userPrompt,
      fixtureProps,
      skipRuntimeRender: true,
    });
    const modeIssues: EvalIssue[] = [...checkResult.issues];
    const modeHasBlocking = modeIssues.some((i) => i.result === "fail");

    // A contract that declares `clientCapabilities.gadgets` always runs
    // the full LLM eval — a gadget is a contract obligation and the
    // evaluator is the only check that confirms it was actually USED.
    // A map / chart classifies as low-risk passive display, so without
    // this carve-out the bypass below would ship a component that
    // imports `<LeafletMap>` / `<Chart>` and never renders it, unseen.
    const contractDeclaresGadgets =
      contract !== undefined && listContractGadgets(contract).length > 0;

    // ── Low-risk bypass ──
    // Pure passive display (riskTier=low → state ∈ {none,ui-affordance},
    // writes=none, realtime=none, fetch=none) with clean axis checks
    // skips the LLM eval round — its findings are typically polish
    // warns, not worth the 3-6s Haiku cost. Gadget contracts are exempt
    // (see above) — they always need the evaluator.
    if (
      classification.riskTier === "low" &&
      !modeHasBlocking &&
      !contractDeclaresGadgets
    ) {
      // ── In-loop probe at exit-decision (one-shot) ──
      // Low-risk fixtures still ship runtime crashes (e.g.,
      // "is not iterable" on an empty array prop). Probe here before
      // declaring evalDone; if recoverable → +1 turn with [runtime]
      // violation; otherwise the probe issues (if any) merge into the
      // evalResult for telemetry and we exit clean.
      const exitProbe = await runProbeAtExit({
        harness,
        sourceCode: currentSource,
        compiledCode,
        contract,
        fixtureProps,
      });
      if (exitProbe.fired && exitProbe.recoverableFail) {
        const runtimeFails = exitProbe.probeIssues.filter(
          (i) => i.result === "fail" && i.subcategory?.startsWith("runtime:"),
        );
        const lines = runtimeFails.slice(0, MAX_FEEDBACK_ISSUES).map(formatRuntimeProbeFeedback);
        const allIssues = [...modeIssues, ...exitProbe.probeIssues];
        evalResult = { issues: allIssues, pass: ["axis.low-risk"] };
        console.log(
          `[simple] eval round ${evalRoundsUsed}: low-risk bypass clean BUT ` +
            `runtime probe fail (recoverable) — granting +1 turn`,
        );
        return {
          control: "feedback",
          evalDone: false,
          evalResult,
          evalRoundsUsed,
          prevModeSubcats,
          prevFailFingerprints,
          preWarmedContext,
          evalTokens,
          evalLlmMs,
          lastResultText: lines.join("\n\n"),
          isEvalFeedback: true,
          lastDiffFailed: false,
        };
      }
      evalResult = {
        issues: [...modeIssues, ...exitProbe.probeIssues],
        pass: ["axis.low-risk"],
      };
      console.log(
        `[simple] eval round ${evalRoundsUsed}: low-risk bypass ` +
          `(axis-checks clean, tier-1/2 skipped${exitProbe.fired ? ", probe ran" : ""}) — PASS`,
      );
      return {
        control: "break",
        evalDone: true,
        evalResult,
        evalRoundsUsed,
        prevModeSubcats,
        prevFailFingerprints,
        preWarmedContext,
        evalTokens,
        evalLlmMs,
        lastResultText: "",
        isEvalFeedback: false,
        lastDiffFailed: false,
      };
    }

    // Await pre-warmed context (only on first eval round, generated during coding)
    if (evalRoundsUsed === 1 && !preWarmedContext && preWarmPromise) {
      preWarmedContext = await preWarmPromise;
    }

    // ── Tier 1+2: LLM evaluation + Visual eval in parallel ──
    let llmResult: (EvalResult & { inputTokens: number; outputTokens: number }) | null = null;
    let visualIssues: EvalIssue[] | null = null;

    const evalLlmStart = Date.now();
    const [llm, visual] = await Promise.all([
      llmEvalMod
        ? llmEvalMod.runLLMEvaluation(
            {
              sourceCode: currentSource,
              originalPrompt: userPrompt,
              contract,
            },
            {
              provider: mapProviderForEvaluator(evaluationAgent.provider),
              model: evaluationAgent.model,
            },
            preWarmedContext,
          )
        : null,
      visualMod
        ? visualMod.runVisualEval(
            { compiledCode, originalPrompt: userPrompt },
            {
              provider: mapProviderForEvaluator(visualEvalAgent.provider) as "claude" | "google",
              model: visualEvalAgent.model,
              passThreshold: visualThreshold,
              sampleProps: visualEvaluation?.sampleProps,
              viewport: visualEvaluation?.viewport,
            },
          )
        : null,
    ]);
    evalLlmMs = Date.now() - evalLlmStart;
    llmResult = llm;
    visualIssues = visual;

    // Track costs from LLM eval calls
    if (llmResult) {
      costTracker.record(evaluationAgent.model, llmResult.inputTokens, llmResult.outputTokens);
      evalTokens = {
        input: llmResult.inputTokens,
        output: llmResult.outputTokens,
      };
    }

    // ── Merge LLM + visual + mode-check issues into EvalResult ──
    const allIssues: EvalIssue[] = [
      ...(llmResult?.issues ?? []),
      ...(visualIssues ?? []),
      ...modeIssues,
    ];
    const allPass: string[] = [...(llmResult?.pass ?? [])];
    evalResult = { issues: allIssues, pass: allPass };

    // ── Log merged results, with mode-check subcategory breakdown ──
    const fails = allIssues.filter((i) => i.result === "fail");
    const warns = allIssues.filter((i) => i.result === "warn");
    const modeFails = modeIssues.filter((i) => i.result === "fail").length;
    const modeWarns = modeIssues.filter((i) => i.result === "warn").length;
    const modeSubcatCounts = modeIssues.reduce<Record<string, number>>((acc, i) => {
      const key = i.subcategory ?? "mode";
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    const modeBreakdown = Object.entries(modeSubcatCounts)
      .map(([k, v]) => `${k}×${v}`)
      .join(", ");

    // Cross-round diff — only emit when round > 1 AND there's something to report
    const currSubcats = new Set(Object.keys(modeSubcatCounts));
    let crossRound = "";
    if (evalRoundsUsed > 1 && (prevModeSubcats.size > 0 || currSubcats.size > 0)) {
      const unresolved = [...currSubcats].filter((s) => prevModeSubcats.has(s));
      const fixed = [...prevModeSubcats].filter((s) => !currSubcats.has(s));
      const fresh = [...currSubcats].filter((s) => !prevModeSubcats.has(s));
      const parts: string[] = [];
      if (unresolved.length) parts.push(`unresolved=[${unresolved.join(",")}]`);
      if (fixed.length) parts.push(`fixed=[${fixed.join(",")}]`);
      if (fresh.length) parts.push(`new=[${fresh.join(",")}]`);
      if (parts.length) crossRound = ` | ${parts.join(" ")}`;
    }
    const updatedPrevModeSubcats = currSubcats;

    console.log(
      `[simple] eval round ${evalRoundsUsed}: ${fails.length} fails, ${warns.length} warns | ` +
        `cost=$${costTracker.getTotal().toFixed(4)} | ` +
        `tiers: t1+2=${llmResult?.issues.length ?? 0} visual=${visualIssues?.length ?? 0} ` +
        `axis[${classification.riskTier}]=${modeFails}F/${modeWarns}W${modeBreakdown ? ` (${modeBreakdown})` : ""}${crossRound}`,
    );

    // ── Decide whether to continue the loop ──
    // In fast mode: only fails trigger another iteration.
    // In auto-improve / high-quality: fails + warns trigger iterations.
    const blocking = evalResult.issues.filter((i) => i.result === "fail");
    const shouldContinue =
      qualityMode === "fast"
        ? blocking.length > 0
        : blocking.length > 0 || warns.length > 0;

    // Compute current round's fail fingerprints — used by the stuck-loop
    // detector (round N+1) and threaded back to caller for round N+2.
    const currFailFingerprints = new Set(blocking.map(fingerprintFail));

    if (!shouldContinue) {
      // ── In-loop probe at exit-decision (one-shot) ──
      // Tier-1/2 LLM eval said clean. The probe is the last gate before
      // the harness ships — if it catches a recoverable runtime crash
      // (function-not-iterable on Google × stock-ticker etc.), grant
      // +1 turn with class-specific [runtime] advice. Otherwise probe
      // issues merge into evalResult for scoring and we exit clean.
      const exitProbe = await runProbeAtExit({
        harness,
        sourceCode: currentSource,
        compiledCode,
        contract,
        fixtureProps,
      });
      if (exitProbe.fired && exitProbe.recoverableFail) {
        const runtimeFails = exitProbe.probeIssues.filter(
          (i) => i.result === "fail" && i.subcategory?.startsWith("runtime:"),
        );
        const lines = runtimeFails.slice(0, MAX_FEEDBACK_ISSUES).map(formatRuntimeProbeFeedback);
        const enrichedIssues = [...allIssues, ...exitProbe.probeIssues];
        evalResult = { issues: enrichedIssues, pass: allPass };
        const enrichedFingerprints = new Set([
          ...currFailFingerprints,
          ...runtimeFails.map(fingerprintFail),
        ]);
        console.log(
          `[simple] eval round ${evalRoundsUsed}: tier-1/2 clean BUT ` +
            `runtime probe fail (recoverable) — granting +1 turn`,
        );
        return {
          control: "feedback",
          evalDone: false,
          evalResult,
          evalRoundsUsed,
          prevModeSubcats: updatedPrevModeSubcats,
          prevFailFingerprints: enrichedFingerprints,
          preWarmedContext,
          evalTokens,
          evalLlmMs,
          lastResultText: lines.join("\n\n"),
          isEvalFeedback: true,
          lastDiffFailed: false,
        };
      }
      // Probe ran but didn't trip a recoverable fail — fold its issues
      // into the merged result for telemetry and exit.
      if (exitProbe.fired && exitProbe.probeIssues.length > 0) {
        evalResult = {
          issues: [...allIssues, ...exitProbe.probeIssues],
          pass: allPass,
        };
      }
      console.log(`[simple] eval round ${evalRoundsUsed}: no blocking issues — PASS`);
      return {
        control: "break",
        evalDone: true,
        evalResult,
        evalRoundsUsed,
        prevModeSubcats: updatedPrevModeSubcats,
        prevFailFingerprints: currFailFingerprints,
        preWarmedContext,
        evalTokens,
        evalLlmMs,
        lastResultText: "",
        isEvalFeedback: false,
        lastDiffFailed: false,
      };
    }

    // Stuck-loop detector. From round 2 onward, if every fail this round was
    // also a fail last round, the LLM made no fail-resolving progress — the
    // eval keeps re-flagging the same issues (commonly tier-1 `functionality`
    // nitpicks the LLM can't make go away on complex contract). Burning more
    // turns risks introducing new bugs (saw "Too many re-renders" on chat-
    // interface in v7). Exit early; the post-eval scoring still runs.
    // 2026-04-27 (rev 3): runtime probe fails are exempt from stuck-loop
    // exit. claude × survey-form run3 hit stuck-loop at round 2 with a
    // SINGLE runtime fail recurring — exiting there gave the LLM only 1
    // retry. Runtime crashes are critical and the LLM often needs 3+ tries
    // to localize them; the +2 max-rounds extension is the right escape
    // hatch, not stuck-loop exit. Keep stuck-loop active for non-runtime
    // fail-sets (the original tier-1 nitpick case it was built for).
    const onlyRuntimeFails =
      currFailFingerprints.size > 0 &&
      [...currFailFingerprints].every((fp) => fp.includes("|runtime:"));
    if (
      evalRoundsUsed > 1 &&
      currFailFingerprints.size > 0 &&
      !onlyRuntimeFails &&
      [...currFailFingerprints].every((fp) => prevFailFingerprints.has(fp))
    ) {
      console.log(
        `[simple] eval round ${evalRoundsUsed}: stuck — all ${currFailFingerprints.size} ` +
          `fails recur from prior round, exiting eval-fix loop`,
      );
      return {
        control: "break",
        evalDone: false,
        evalResult,
        evalRoundsUsed,
        prevModeSubcats: updatedPrevModeSubcats,
        prevFailFingerprints: currFailFingerprints,
        preWarmedContext,
        evalTokens,
        evalLlmMs,
        lastResultText: "",
        isEvalFeedback: false,
        lastDiffFailed: false,
      };
    }

    // Max eval rounds reached — exit, EXCEPT when there's an active runtime
    // probe fail. Runtime crashes are the harshest production failure
    // (broken UI ships) and are worth up to 2 extra retry rounds.
    //
    // 2026-04-27 (rev 2): widened from "newly-introduced only" to "any
    // active runtime fail, up to maxEvalRounds + 2". Class-specific fix
    // advice is plumbed through; the LLM needs more attempts for hard
    // crash classes (e.g., "Too many re-renders", which requires reasoning
    // about which setState is unbounded). Runaway risk is bounded by:
    //   1. The stuck-loop detector above — exits if every fail recurs
    //      from the prior round.
    //   2. Hard cap at maxEvalRounds + 2.
    // The "newly-introduced only" gate was too tight: when an LLM patch
    // surfaces a runtime crash AND introduces other fixable fails, the
    // stuck-loop detector won't fire (some fails change), but the cap
    // hits with the runtime fail unresolved.
    const RUNTIME_EXTENSION_BONUS = 2;
    if (evalRoundsUsed >= maxEvalRounds) {
      // 2026-04-27 (in-loop probe trigger): probe is now off the per-turn
      // hot path; `blocking` from runCheck won't contain `runtime:*` fails
      // because we passed `skipRuntimeRender: true`. To honor the
      // RUNTIME_EXTENSION_BONUS gate, run the probe ONCE at this exit.
      const exitProbe = await runProbeAtExit({
        harness,
        sourceCode: currentSource,
        compiledCode,
        contract,
        fixtureProps,
      });
      const hasRuntimeFail =
        exitProbe.fired && exitProbe.recoverableFail;
      const allowRuntimeExtension =
        hasRuntimeFail &&
        evalRoundsUsed < maxEvalRounds + RUNTIME_EXTENSION_BONUS;
      if (!allowRuntimeExtension) {
        // Fold probe issues (if any) into evalResult for telemetry,
        // even though we're not granting an extension.
        if (exitProbe.fired && exitProbe.probeIssues.length > 0) {
          evalResult = {
            issues: [...evalResult.issues, ...exitProbe.probeIssues],
            pass: evalResult.pass,
          };
        }
        console.log(`[simple] eval round ${evalRoundsUsed}: max eval rounds reached — stopping`);
        return {
          control: "break",
          evalDone: false,
          evalResult,
          evalRoundsUsed,
          prevModeSubcats: updatedPrevModeSubcats,
          prevFailFingerprints: currFailFingerprints,
          preWarmedContext,
          evalTokens,
          evalLlmMs,
          lastResultText: "",
          isEvalFeedback: false,
          lastDiffFailed: false,
        };
      }
      // Recoverable probe fail at the cap → grant +1 retry, switch the
      // feedback path to the probe diagnostic so the LLM sees a [runtime]
      // violation instead of the prior round's tier-1 nitpicks.
      const runtimeFails = exitProbe.probeIssues.filter(
        (i) => i.result === "fail" && i.subcategory?.startsWith("runtime:"),
      );
      const probeLines = runtimeFails
        .slice(0, MAX_FEEDBACK_ISSUES)
        .map(formatRuntimeProbeFeedback);
      const enrichedIssues = [...evalResult.issues, ...exitProbe.probeIssues];
      evalResult = { issues: enrichedIssues, pass: evalResult.pass };
      console.log(
        `[simple] eval round ${evalRoundsUsed}: runtime-probe fail active at cap — granting +1 retry (${maxEvalRounds + RUNTIME_EXTENSION_BONUS - evalRoundsUsed} of ${RUNTIME_EXTENSION_BONUS} bonus rounds remain)`,
      );
      return {
        control: "feedback",
        evalDone: false,
        evalResult,
        evalRoundsUsed,
        prevModeSubcats: updatedPrevModeSubcats,
        prevFailFingerprints: new Set([
          ...currFailFingerprints,
          ...runtimeFails.map(fingerprintFail),
        ]),
        preWarmedContext,
        evalTokens,
        evalLlmMs,
        lastResultText: probeLines.join("\n\n"),
        isEvalFeedback: true,
        lastDiffFailed: false,
      };
    }

    // Budget exhausted — exit
    if (!costTracker.canContinue()) {
      console.log(
        `[simple] eval: budget exhausted (spent=$${costTracker.getTotal().toFixed(4)}) — stopping`,
      );
      return {
        control: "break",
        evalDone: false,
        evalResult,
        evalRoundsUsed,
        prevModeSubcats: updatedPrevModeSubcats,
        prevFailFingerprints: currFailFingerprints,
        preWarmedContext,
        evalTokens,
        evalLlmMs,
        lastResultText: "",
        isEvalFeedback: false,
        lastDiffFailed: false,
      };
    }

    // ── Limit feedback to at most MAX_FEEDBACK_ISSUES per eval-fix turn ──
    // Feeding too many issues at once causes the LLM to make many simultaneous
    // changes, breaking JSX nesting in complex components. Prioritize fails
    // first, then warns, capped to keep fixes surgical.
    const allActionable = evalResult.issues
      .filter((i) => i.result === "fail" || i.result === "warn")
      .sort((a, b) => (a.result === "fail" ? 0 : 1) - (b.result === "fail" ? 0 : 1))
      .slice(0, MAX_FEEDBACK_ISSUES);
    const issueLines = allActionable.map((issue) => {
      const tag = issue.result === "fail" ? "FAIL" : "WARN";
      return `[${tag}] ${issue.category}${issue.subcategory ? "/" + issue.subcategory : ""}: ${issue.description}\n  Fix: ${issue.fix}`;
    });

    console.log(
      `[simple] eval round ${evalRoundsUsed}: ${allActionable.length} issues (${blocking.length} fail, ${warns.length} warn) → feeding back to coding loop`,
    );

    return {
      control: "feedback",
      evalDone: false,
      evalResult,
      evalRoundsUsed,
      prevModeSubcats: updatedPrevModeSubcats,
      prevFailFingerprints: currFailFingerprints,
      preWarmedContext,
      evalTokens,
      evalLlmMs,
      lastResultText: issueLines.join("\n\n"),
      isEvalFeedback: true,
      lastDiffFailed: false,
    };
  } catch (e) {
    console.error("[simple] eval failed:", e instanceof Error ? e.message : e);
    return {
      control: "break",
      evalDone: false,
      evalResult,
      evalRoundsUsed,
      prevModeSubcats,
      prevFailFingerprints,
      preWarmedContext,
      evalTokens,
      evalLlmMs,
      lastResultText: "",
      isEvalFeedback: false,
      lastDiffFailed: false,
    };
  }
}
