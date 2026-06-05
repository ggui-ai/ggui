// packages/ui-gen/src/harness/coding/run-coding-turn.ts
//
// One iteration of the apply_changes coding loop, extracted from
// runSimpleHarness as part of the runHarness migration (#142, step 1).
//
// Owns: prompt assembly for this turn (scaffold/fill/impl/patch/eval-fix),
// the LLM call, the executeTool dispatch, outcome classification, and the
// per-turn token / latency / breakdown accounting.
//
// Does NOT own: the do/while wrapper, staged-process phase transitions,
// initialResult delivery, or the eval round (axis + LLM + visual +
// merge + feedback) — those are driven by the harness runtime.
//
// Behavior MUST match the inlined original byte-for-byte — this is a
// mechanical extraction, not a redesign.

import type { DataContract } from "@ggui-ai/protocol";
import type { CommitMetadata } from "../../coding-agent/types.js";
import type { AgentWorkspace } from "../../coding-agent/workspace.js";
import { executeTool } from "../../coding-agent/tools.js";
import type { CostTracker } from "../../evaluation/cost-tracker.js";
import type { LLMAgent } from "../llm-router.js";
import type { Harness } from "../types-public.js";
import {
  APPLY_CHANGES_HASHLINE_TOOL,
  APPLY_CHANGES_HASHLINE_TOOL_FLAT,
  APPLY_CHANGES_TOOL,
  APPLY_CHANGES_TOOL_FLAT,
  APPLY_CHANGES_TOOL_SCOPED,
  GET_COMPONENTS_INFO_TOOL,
  GET_ICONS_TOOL,
  REWRITE_TOOL,
  WRITE_PLAN_TOOL,
  type LLMToolDef,
} from "../../tools.js";
import { formatWithHashlines } from "../hashline.js";

/** Staged process-mode phase machine — also defined in runtime.ts. */
export type A1Phase = "scaffold" | "fill" | "post";

/**
 * Tool set advertised to the LLM for a given turn. Exactly ONE
 * authoring tool is advertised per turn so the LLM never has to choose;
 * the harness picks based on workspace state.
 *
 *  - forceEscape (dupe-fingerprint hit): `APPLY_CHANGES_TOOL_SCOPED` only,
 *    one-shot, ≤20 lines — narrow blast radius for transport-error recovery
 *    (notably Google Gemini malformed_tool_call).
 *  - consecutiveBrokenApplies ≥ 3: `REWRITE_TOOL` only — the LLM has been
 *    iterating on broken state via apply-and-warn and hasn't converged;
 *    reset the file with a full rewrite.
 *  - Otherwise (including turn 1, since a boilerplate was scaffolded into
 *    the workspace before coding started): `APPLY_CHANGES_TOOL` plus the
 *    read-only `get_available_icons` helper.
 *
 * Notes:
 *  - No more `write` on turn 1. Boilerplate is committed by initSession at
 *    scaffold time; turn-1 patches fill it in. This removes the ambiguous
 *    "apply vs write" choice the LLM used to have.
 *  - Rename: `WRITE_TOOL` → `REWRITE_TOOL` to match its new role as
 *    escape-only, not primary authoring.
 */
/**
 * Extract a coarse error signature from a failed apply_changes result.
 * Used by dupe-break fingerprinting to detect "same patch, same failure"
 * loops across PATCH_INVALID + PATCH_APPLIED_BROKEN + SELF_CHECK_FAIL.
 *
 * Priority order — return the first match:
 *   1. `esbuild error: <msg>` — preflight + apply-and-warn paths
 *   2. First `[CATEGORY] description` line — tier-0 self-check violation
 *   3. `Build errors:` followed by next non-empty line — esbuild build fail
 *      after a successful preflight (rare)
 *   4. Empty string — fingerprint still works on (ranges, code).
 */
function extractFailSignature(resultText: string): string {
  const esbuildMatch = resultText.match(/esbuild error: ([^\n]+)/);
  if (esbuildMatch) return esbuildMatch[1];
  const violationMatch = resultText.match(/^\[[A-Z][^\]]*\] [^\n]+/m);
  if (violationMatch) return violationMatch[0];
  const buildErrMatch = resultText.match(/Build errors:\s*\n([^\n]+)/);
  if (buildErrMatch) return buildErrMatch[1];
  return "";
}

export function selectTurnTools(
  turnsUsed: number,
  forceEscape = false,
  consecutiveBrokenApplies = 0,
  hashlineMode: "off" | "v2" = "off",
  primitiveIndexMode: "off" | "names-only" | "with-props" = "off",
  primitiveIndexForceFetch = false,
  primitiveIndexPlanTurn = false,
  planFirstTurn = false,
  codeFormat: "array" | "flat" = "array",
): LLMToolDef[] {
  if (forceEscape) return [APPLY_CHANGES_TOOL_SCOPED];
  if (consecutiveBrokenApplies >= 3) return [REWRITE_TOOL];
  // Plan-first turn (independent of index mode). When on, turn 1 is
  // write_plan only; turn 2+ is normal write tools.
  if (planFirstTurn && turnsUsed === 1) {
    return [WRITE_PLAN_TOOL];
  }
  // Force turn 1 to fetch-only when `primitiveIndexForceFetch` is on.
  // This removes the LLM's ability to guess prop values; it must load
  // enum docs before writing any JSX.
  if (primitiveIndexForceFetch && primitiveIndexMode !== "off" && turnsUsed === 1) {
    return [GET_COMPONENTS_INFO_TOOL];
  }
  // Force turn 2 to write_plan only when `primitiveIndexPlanTurn` is
  // on. Combined with the turn-1 fetch-only step, this produces the
  // fetch → plan → write pipeline, which breaks fetch-loops where the
  // model over-fetches without committing to a structure.
  if (primitiveIndexPlanTurn && primitiveIndexMode !== "off" && turnsUsed === 2) {
    return [WRITE_PLAN_TOOL];
  }
  // Hashline profile: swap the numeric-line apply_changes for the
  // hash-verified variant. Independently, `codeFormat` picks the
  // flat-code variant when "flat" — a shallower JSON schema that some
  // model decoders handle more reliably.
  const applyTool =
    hashlineMode === "v2"
      ? codeFormat === "flat"
        ? APPLY_CHANGES_HASHLINE_TOOL_FLAT
        : APPLY_CHANGES_HASHLINE_TOOL
      : codeFormat === "flat"
        ? APPLY_CHANGES_TOOL_FLAT
        : APPLY_CHANGES_TOOL;
  const tools: LLMToolDef[] = [applyTool, GET_ICONS_TOOL];
  // Tool-driven primitive docs. Advertise the component-docs fetch
  // tool alongside the authoring tool so the LLM can pull full prop
  // APIs on demand when the compact index isn't enough signal.
  if (primitiveIndexMode !== "off") tools.push(GET_COMPONENTS_INFO_TOOL);
  return tools;
}

/** Pre-warmed eval context handle (lazy-loaded module type). */
type PreWarmedEvalContext =
  import("../../evaluation/llm-evaluator.js").PreWarmedEvalContext;

/**
 * Persistent coding-loop context — captured once per generation, reused
 * across every turn. After the closure-based migration (step 3), these
 * will move into a session object held by the generate task runner.
 */
export interface CodingTurnContext {
  readonly workspace: AgentWorkspace;
  readonly codingAgent: LLMAgent;
  readonly codingModel: string;
  readonly systemPrompt: string;
  readonly harness: Harness;
  readonly contract: DataContract | undefined;
  readonly commitMeta: Map<string, CommitMetadata>;
  readonly originalProps: string | undefined;
  readonly costTracker: CostTracker | null;
  /**
   * Runtime-resolved context policy. Defaults to `harness.policy.context`
   * when the caller hasn't threaded a dispatched override through. Closure
   * callers (generate-task-runner) pass `session.resolvedPolicy.context`
   * so experiment profiles (see policy.ts / C2) apply.
   */
  readonly contextPolicy?: import("../policy.js").ContextPolicy;
  /**
   * Mutable duplicate-patch-break state (see dupe-break.ts). Safe to
   * mutate in place — the caller (generate-task-runner) holds the same
   * reference and reads from it on the next turn. Always provided; the
   * `breakDuplicatePatch` policy flag gates whether this turn reads it.
   */
  readonly dupeBreak?: import("./dupe-break.js").DupeBreakState;
}

/**
 * Per-turn input — mutates between turns based on prior turn's result.
 */
export interface CodingTurnInput {
  /** 1-indexed turn counter (caller increments before calling). */
  readonly turnsUsed: number;
  readonly a1Phase: A1Phase;
  /** Feedback text from prior turn — issues to fix in patch / eval-fix mode. */
  readonly lastResultText: string;
  readonly lastDiffFailed: boolean;
  /** True when lastResultText came from the eval round (vs self-check). */
  readonly isEvalFeedback: boolean;
  /** Cached lucide icon name list (populated lazily on first get_icons call). */
  readonly iconNamesCache: string | null;
  readonly preWarmedContext: PreWarmedEvalContext | null | undefined;
  readonly preWarmPromise: Promise<PreWarmedEvalContext | null> | undefined;
}

/**
 * Outcome class used in benchmark breakdowns. Mirrors the original
 * runtime.ts string literals so log/grep tooling keeps working unchanged.
 */
export type CodingTurnOutcome =
  | "PASS"
  | "PATCH_INVALID"
  | "DIFF_FAIL"
  | "SELF_CHECK_FAIL";

/** Phase label used in breakdowns. */
export type CodingTurnPhase = "scaffold" | "fill" | "impl" | "patch" | "eval-fix";

/**
 * Flow-control instruction the caller acts on:
 *   "break"    — no tool call; abort the do/while
 *   "continue" — self-check failed (or icon branch); feed back + next turn
 *   "proceed"  — self-check passed; advance to phase transition / eval round
 */
export type CodingTurnControl = "break" | "continue" | "proceed";

export interface CodingTurnResult {
  readonly control: CodingTurnControl;
  /** Set only when control === "proceed" — best compiled code from commitMeta. */
  readonly compiledCode: string;
  readonly selfCheckPassed: boolean;
  /** Outcome label for breakdown counters. Undefined when control === "break". */
  readonly outcome: CodingTurnOutcome | undefined;
  readonly phase: CodingTurnPhase | undefined;
  readonly tokens: { input: number; output: number };
  readonly llmMs: number;
  readonly toolMs: number;
  /** Updated state — caller stores back into its own variables for next turn. */
  readonly lastResultText: string;
  readonly lastDiffFailed: boolean;
  readonly isEvalFeedback: boolean;
  readonly iconNamesCache: string | null;
  readonly preWarmedContext: PreWarmedEvalContext | null | undefined;
}

/**
 * Run one coding turn. Mutates `ctx.workspace` (file writes, commits) and
 * `ctx.commitMeta` (build/self-check metadata side-channel from executeTool).
 * Returns flow-control + measurements; caller threads them back as state.
 */
export async function runCodingTurn(
  ctx: CodingTurnContext,
  input: CodingTurnInput,
): Promise<CodingTurnResult> {
  const {
    workspace,
    codingAgent,
    codingModel,
    systemPrompt,
    harness,
    contract,
    commitMeta,
    originalProps,
    costTracker,
  } = ctx;
  const {
    turnsUsed,
    a1Phase,
    lastResultText,
    lastDiffFailed,
    isEvalFeedback,
  } = input;
  let { iconNamesCache, preWarmedContext } = input;

  // Restore Props interface if the LLM changed it
  if (originalProps) {
    const current = workspace.read() ?? "";
    const currentProps = current.match(/interface Props \{[\s\S]*?\n\}/)?.[0];
    if (currentProps && currentProps !== originalProps) {
      workspace.write(current.replace(currentProps, originalProps));
      await workspace.stage();
    }
  }

  // Hashline format: when the profile is on, the
  // `## Current File` view includes per-line 2-char content hashes
  // (`N:hh│content`). Otherwise, the existing numeric-only format.
  const hashlineMode = ctx.contextPolicy?.hashline ?? "off";
  const currentFile =
    hashlineMode === "v2"
      ? formatWithHashlines(workspace.read() ?? "")
      : workspace.cat();
  let userPrompt: string;

  if (a1Phase === "scaffold") {
    // ── Scaffold pass (experimental, env: GGUI_A1=1) ──
    // Goal: a compileable structural first pass — no feature content
    // yet. The smaller patch surface means next-turn fills tend to have
    // fewer JSX tag-geometry failures than a one-shot implementation.
    userPrompt = `Produce a COMPILEABLE structural first pass. This is turn 1 of 2 — you are NOT implementing the feature yet.

## Required this turn (non-negotiable)

1. Declare all hooks from the boilerplate: \`useState\` for local state you'll need, plus every \`useAction\` / \`useStream\` / \`useGguiContext\` from the contract, plus any capability hooks declared in \`clientCapabilities\` (from \`@ggui-ai/gadgets\`)
2. Build a minimal valid JSX skeleton — one top-level \`<Container>\` or \`<Card>\` with a \`<Stack>\` of empty-but-valid region containers (one per logical section of the UI)
3. Keep the \`export default function\` signature + \`Props\` interface exactly as in the boilerplate

## NOT required yet (next turn will fill these in)

- Rendering prop values or real content
- Wiring hook callbacks to UI elements (empty \`onClick={() => {}}\` is fine)
- Styling polish, icons, badges, variants
- Interactive flows and derived state

**Goal: compile + pass syntactic checks. Broken JSX wastes the whole round-trip — keep it minimal and valid.**

## Current File
\`\`\`tsx
${currentFile}
\`\`\``;
  } else if (a1Phase === "fill") {
    // ── Fill pass (experimental) ──
    // The skeleton compiled. Flesh it out against a known-good tree.
    userPrompt = `The scaffold compiled. Now FILL in the details against the compiled skeleton. Make minimal, targeted patches — don't rewrite the whole file.

## Required this turn (non-negotiable)

1. GguiSession every required prop from the Props interface in the appropriate region
2. Wire every hook to a real interactive element with the correct payload shape
3. Add real content — text, labels, icons, variants — so the UI matches the user's request

## Allowed to simplify (ONLY flourishes/polish)

- Elaborate animations → plain CSS transitions or static styles
- Rare empty states → skip the branch
- Fancy layout refinements → simpler grid/stack

**Preserve the scaffolded region containers wherever possible.** Patch surgically inside them instead of rewriting the tree. Broken JSX or type errors waste a whole round-trip.

## Current File (scaffolded, compiles)
\`\`\`tsx
${currentFile}
\`\`\``;
  } else if (turnsUsed === 1) {
    // ── Phase 1: Implementation ──────────────────────────
    // The load-bearing structure of this prompt: 3 numbered
    // non-negotiables plus an explicit "allowed to simplify" scope.
    // Benchmarking found this shape produces materially better
    // implementation-pass rates and fewer malformed tool calls than
    // either a longer or a flatter variant.
    // v2.1 falsified "fallback wording = universal fix" — helped multi-step
    // forms (+44pp onboarding) but regressed rendering commits (-45pp
    // product-page) and slowed Google/OpenAI. Multi-shape need is A2 scaffold
    // territory, not prompt wording.
    userPrompt = `Deliver a compileable, end-to-end first pass in one turn.

## Required this turn (non-negotiable)

1. JSX structure that parses — balanced tags, closed fragments, no stray braces
2. GguiSession every required prop from the Props interface
3. Wire every \`useAction\` / \`useStream\` / \`useGguiContext\` hook from the boilerplate to a visible element. If the contract declared \`clientCapabilities\`, the boilerplate emits a capability-hook call for each (e.g., \`const loc = useGeolocation();\`); call \`.start()\` from a UI control and render the result.

## Allowed to simplify (ONLY flourishes/polish — NOT core work above)

- Elaborate animations → plain CSS transitions or static styles
- Rare empty states → skip the branch entirely
- Fancy layout refinements → simpler grid/stack

**If a flourish risks broken JSX or type errors, OMIT it rather than leaving a placeholder or partial structure.** No TODOs, no half-finished helpers, no stub components. Broken syntax or missing core work wastes a whole round-trip.

Read the boilerplate comments — each hook has its type and call signature inline. Follow P0 → P1 → P2 priority from the system prompt.

## Current File
\`\`\`tsx
${currentFile}
\`\`\``;
  } else {
    // ── Phase 2: Targeted patches (self-check or eval issues) ──
    // Prioritize issues so the LLM fixes the most critical first.
    const issues = lastResultText;
    const diffHint = lastDiffFailed
      ? `\n**Your last diff did not apply.** Make sure context lines match the current file exactly. Use 3 lines of context around each change.\n`
      : "";

    // Resolve dynamic criteria from pre-warm (non-blocking: if not ready yet, skip)
    if (!preWarmedContext && input.preWarmPromise) {
      // Race: resolve immediately if ready, otherwise skip this turn
      preWarmedContext = await Promise.race([
        input.preWarmPromise,
        new Promise<null>((r) => setTimeout(r, 0, null)),
      ]);
    }
    const issueHeader = isEvalFeedback ? "## Evaluation Issues (fix all)" : "## Issues (fix all)";

    // ─────────────────────────────────────────────────────────────────────
    // Diagnostic retry prompt.
    // ─────────────────────────────────────────────────────────────────────
    // When a duplicate-patch was detected on the prior turn AND the policy
    // selected the diagnostic intervention, replace the normal "Fix the
    // issues below" blueprint with a focused, structured retry prompt:
    //
    //   - line-numbered excerpt around the failing range (not full file)
    //   - enumeration of the prior 2 failed fingerprints
    //   - structured-diagnosis instruction routed via `commit_message`
    //   - explicit "next patch must differ materially" rule
    //
    // Tool surface is UNCHANGED — same apply_changes + get_icons. The
    // intervention targets the LLM's reasoning state, not its tool
    // selection. See ui-generation-experiments.md #43.
    if (ctx.dupeBreak?.pendingDiagnosticTurn) {
      ctx.dupeBreak.pendingDiagnosticTurn = false;
      ctx.dupeBreak.awaitingDiagnosticOutcome = true;
      const recents = ctx.dupeBreak.recentFailedPatches;
      const head = recents[0];
      // Build a focused excerpt: ±15 lines around the most recent failing
      // range. The current file is shown with line numbers prefixed so
      // the LLM can name "line X" precisely. Falls back to full file if
      // we can't parse a range (defensive).
      const lines = currentFile.split("\n");
      const firstRange = head?.rangesShort.split(",")[0]?.trim() ?? "";
      const m = /^(\d+)-(\d+)$/.exec(firstRange);
      const focusStart = m ? Math.max(1, parseInt(m[1]!, 10) - 15) : 1;
      const focusEnd = m
        ? Math.min(lines.length, parseInt(m[2]!, 10) + 15)
        : lines.length;
      const numbered = lines
        .slice(focusStart - 1, focusEnd)
        .map((line, i) => `${String(focusStart + i).padStart(4, "0")}: ${line}`)
        .join("\n");
      const priorBlock = recents
        .map(
          (p, i) =>
            `  Attempt ${recents.length - i}: ranges=[${p.rangesShort}] error="${p.errClass}" fp=${p.fingerprint.slice(0, 12)}`,
        )
        .join("\n");

      // #44 family-final ablation: when action is "diagnostic-noforce",
      // emit information-only — drop the "must differ materially" rule.
      // Tests whether information alone unlocks Gate 5 vs the coercion.
      // (Recompute policy here — effectivePolicy is computed later in
      // the post-tool-call detection block; this path runs earlier.)
      const promptPolicy = ctx.contextPolicy ?? harness.policy.context;
      const noForce = promptPolicy.dupeBreakAction === "diagnostic-noforce";
      const step2 = noForce
        ? `2. Then call \`apply_changes\`. The information above (line numbers + prior fingerprints) should let you see exactly what's wrong. If your patch turns out to be the same one you tried before, that's fine — but make sure you've verified line-by-line against the focused excerpt that the patch is actually correct.`
        : `2. Then call \`apply_changes\` with a patch that **differs materially** from your prior failed attempt — different ranges OR meaningfully different code at the same range. Re-emitting the same patch is not allowed.`;

      userPrompt = `[LOOP DETECTED] Your last patch was byte-identical to a prior failed patch and produced the same preflight error. You are stuck in a fixed point — apply_changes alone won't escape this loop unless you re-examine the file.

## Prior failed attempts (most recent first)
${priorBlock}

## Failing region — focused excerpt (lines ${focusStart}–${focusEnd}, line-numbered)
\`\`\`tsx
${numbered}
\`\`\`

## What to emit on this turn

1. Set \`commit_message\` to a one-line structured diagnosis in this exact format:
   \`DIAG: why=<why the prior patch failed, ≤80 chars> | next=<what you will change instead, ≤80 chars> | lines=<startLine-endLine you will target>\`
${step2}

## Issues from prior turn (full text — for context)
${issues}
`;
    } else {
      // NOTE: exp61 tested batch-fix emphasis (fix ALL errors in ONE
      // call). Bisect (exp62) showed that variants — strong text,
      // gated N≥2, split self-check/eval — all introduced regressions
      // on at least one provider/fixture combination. LLMs batch
      // naturally; the explicit instruction over-pressured them into
      // wide patches that reference undefined functions. Reverted to
      // the original short prompt. `GGUI_BATCH_FIX=on` preserved as
      // env-opt-in if future experimentation wants to revisit.
      const batchFixForced = typeof process !== "undefined" && process.env?.GGUI_BATCH_FIX === "on";
      const closingInstruction = batchFixForced
        ? `**Fix EVERY error listed above in THIS single \`apply_changes\` call.** Emit multiple \`changes[]\` entries — one per range.`
        : `Produce ONE \`apply_changes\` call targeting only the lines that need fixing.`;
      userPrompt = `Fix the issues below. Make **minimal, targeted changes** — do NOT rewrite the whole file.${diffHint}

${issueHeader}
${issues}

## Current File
\`\`\`tsx
${currentFile}
\`\`\`

${closingInstruction}`;
    }
  }

  // Scoped fallback: if the provider exhausts retries with
  // malformed_tool_call (a transport error — the payload is too
  // complex), the router falls back to the narrower schema so the next
  // attempt fits within the JSON size ceiling.
  // When the prior patch turn's fingerprint matched, force
  // APPLY_CHANGES_TOOL_SCOPED for this one turn only. The flag is
  // consumed here so the next turn goes back to apply_changes unless
  // the chain re-triggers. The cooldown ticks down at turn start so
  // detection re-enables after N turns.
  const forceEscape = ctx.dupeBreak?.forceEscapeNextTurn === true;
  if (ctx.dupeBreak && forceEscape) ctx.dupeBreak.forceEscapeNextTurn = false;
  if (ctx.dupeBreak && ctx.dupeBreak.cooldown > 0) ctx.dupeBreak.cooldown--;
  const consecutiveBrokenApplies = ctx.dupeBreak?.consecutiveBrokenApplies ?? 0;
  const primitiveIndexMode = ctx.contextPolicy?.primitiveIndex ?? "off";
  const primitiveIndexForceFetch = ctx.contextPolicy?.primitiveIndexForceFetch ?? false;
  const primitiveIndexPlanTurn = ctx.contextPolicy?.primitiveIndexPlanTurn ?? false;
  const planFirstTurn = ctx.contextPolicy?.planFirstTurn ?? false;
  const codeFormat = ctx.contextPolicy?.codeFormat ?? "array";
  const tools = selectTurnTools(
    turnsUsed,
    forceEscape,
    consecutiveBrokenApplies,
    hashlineMode,
    primitiveIndexMode,
    primitiveIndexForceFetch,
    primitiveIndexPlanTurn,
    planFirstTurn,
    codeFormat,
  );
  const llmStart = Date.now();
  const response = await codingAgent.callTools(
    codingModel,
    systemPrompt,
    userPrompt,
    tools,
    "required",
    [APPLY_CHANGES_TOOL_SCOPED],
  );
  const llmMs = Date.now() - llmStart;
  if (costTracker) {
    costTracker.record(codingModel, response.inputTokens, response.outputTokens);
  }

  const tokens = { input: response.inputTokens, output: response.outputTokens };

  const call = response.toolCalls[0];
  if (!call) {
    // Track consecutive no-tool-calls. One observed fail mode is: turn
    // 1 broken-apply (preflight fail), turn 2 no-tool-call → break →
    // SKIP. Force one retry on the FIRST no-tool-call (the model has
    // the prior broken-patch context in scope and usually recovers);
    // break only on the second consecutive no-tool-call.
    if (ctx.dupeBreak) {
      ctx.dupeBreak.consecutiveNoToolCalls += 1;
    }
    const noToolStreak = ctx.dupeBreak?.consecutiveNoToolCalls ?? 1;
    const shouldBreak = noToolStreak >= 2;
    console.warn(
      `[simple] turn ${turnsUsed}: no tool call` +
        (shouldBreak ? ` — breaking (streak=${noToolStreak})` : ` — retrying (streak=${noToolStreak})`),
    );
    // On retry, prepend a directive to the next turn's lastResultText
    // so the prompt explicitly tells the LLM that no tool call was
    // observed and one is REQUIRED. Combined with the existing broken-
    // apply diagnostic (already in lastResultText from prior turn), the
    // model gets the full picture: "your patch was broken AND you
    // didn't try again — fix the patch NOW."
    const retryDirective = shouldBreak
      ? lastResultText
      : `${lastResultText ?? ""}\n\n[harness] Your previous turn returned no tool call. You MUST issue an apply_changes (or scoped) tool call. Re-read the current file state and emit a corrected patch.`.trim();
    return {
      control: shouldBreak ? "break" : "continue",
      compiledCode: "",
      selfCheckPassed: false,
      outcome: undefined,
      phase: undefined,
      tokens,
      llmMs,
      toolMs: 0,
      lastResultText: retryDirective,
      lastDiffFailed,
      isEvalFeedback,
      iconNamesCache,
      preWarmedContext,
    };
  }
  // Tool call present — reset the no-tool-call streak.
  if (ctx.dupeBreak) {
    ctx.dupeBreak.consecutiveNoToolCalls = 0;
  }

  // Handle get_available_icons — return icon list without consuming a turn
  if (call.name === "get_available_icons") {
    if (!iconNamesCache) {
      try {
        // Dynamic import — resolve from design package dist
        const iconDataPath = new URL(
          "../../../../packages/design/dist/primitives/icon-data.js",
          import.meta.url,
        ).pathname;
        const { LUCIDE_ICONS } = await import(iconDataPath);
        iconNamesCache = Object.keys(LUCIDE_ICONS)
          .map((n) => n.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase())
          .join(", ");
      } catch {
        iconNamesCache =
          "sun, moon, cloud, cloud-rain, heart, star, search, home, plus, minus, check, x, arrow-left, arrow-right, chevron-down, chevron-up, menu, user, settings, bell, mail, phone, shopping-cart, download, upload, edit, trash-2, save, eye, lock, globe, map-pin, calendar, clock, zap, alert-circle, info, help-circle";
      }
    }
    console.log(`[simple] turn ${turnsUsed}: get_available_icons`);
    const iconResult = `Available Lucide icon names (use with <Icon name="...">):\n${iconNamesCache}`;
    await codingAgent.sendToolResult([{ callId: call.id, name: call.name, result: iconResult }]);
    return {
      control: "continue",
      compiledCode: "",
      selfCheckPassed: false,
      outcome: undefined,
      phase: undefined,
      tokens,
      llmMs,
      toolMs: 0,
      lastResultText: iconResult,
      lastDiffFailed: false,
      isEvalFeedback: false,
      iconNamesCache,
      preWarmedContext,
    };
  }

  const toolStart = Date.now();
  const result = await executeTool(
    workspace,
    call.name,
    call.input,
    commitMeta,
    contract,
    harness.what.applyPatch,
    // Prefer the caller-threaded runtime-resolved policy
    // (session.resolvedPolicy.context) so experimental profiles take
    // effect. Falls back to the harness's static policy.
    ctx.contextPolicy ?? harness.policy.context,
    // Forward the third-party wrapper `.d.ts` map so autoCommit's
    // typecheck overlays the real wrapper declarations and a generated
    // direct gadget import gets strict option/return narrowing.
    harness.what.gadgetTypes,
  );
  const toolMs = Date.now() - toolStart;

  // ─────────────────────────────────────────────────────────────────────────
  // SCOPED_ESCAPE_USED mechanism check.
  // ─────────────────────────────────────────────────────────────────────────
  // When the prior turn fingerprint-matched, this turn was forced to
  // APPLY_CHANGES_TOOL_SCOPED (single change, ≤20 lines). Verify the LLM
  // actually emitted a conforming scoped call — otherwise the detector
  // fired but the escape path wasn't engaged, which is a wiring bug.
  //
  // The scoped tool shares `call.name === "apply_changes"` with the main
  // variant — distinguish by payload shape (changes.length === 1 and
  // endLine - startLine ≤ 20).
  if (forceEscape && ctx.dupeBreak && call.name === "apply_changes") {
    const changes = (call.input?.changes as
      | ReadonlyArray<{ startLine: number; endLine: number; code: string[] }>
      | undefined) ?? [];
    const scopedShape =
      changes.length === 1 &&
      changes[0] !== undefined &&
      changes[0].endLine - changes[0].startLine <= 20;
    if (scopedShape) {
      ctx.dupeBreak.scopedEscapeUsedCount++;
      console.log(
        `[coding-agent] SCOPED_ESCAPE_USED | range=${changes[0]?.startLine}-${changes[0]?.endLine} | count=${ctx.dupeBreak.scopedEscapeUsedCount}`,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Duplicate-patch break detection (escape tool: APPLY_CHANGES_TOOL_SCOPED).
  // ─────────────────────────────────────────────────────────────────────────
  // Scope:
  //   - Only `apply_changes` tool calls (the patch tool; `write` is full
  //     rewrite, not comparable across turns).
  //   - Across patch / impl / eval-fix phases. The fingerprint includes
  //     the full sorted ranges + code + error class — if two consecutive
  //     turns emit a byte-identical patch with the same preflight error,
  //     it's a real loop regardless of which "issue" the LLM nominally
  //     thinks it's addressing. Initial #42 bench had this gate set to
  //     "patch only" (inherited from #41), which suppressed every fire
  //     because eval-fix → patch transitions are the most common dupe
  //     pathway in our risk:high logs.
  //   - Only when `breakDuplicatePatch` policy flag is on.
  //
  // On dupe detection: augment the retry message with an explicit
  // [DUPLICATE_PATCH] preface so the LLM sees WHY the next turn is
  // restricted, and flip `forceEscapeNextTurn` + set cooldown=3 so the
  // next turn is forced to a scoped single-change apply_changes.
  // After a non-dupe fail, record the fingerprint for the next comparison.
  //
  // See ./dupe-break.ts for the state shape + fingerprint.
  const effectivePolicy = ctx.contextPolicy ?? harness.policy.context;
  const isPatchInvalid = !!result.error && result.result.startsWith("PATCH_INVALID");
  const isApplyChanges = call.name === "apply_changes";
  // Dupe-break also covers SELF_CHECK_FAIL. An observed pathology: many
  // turns of identical apply_changes patches, each producing the same
  // tier-0/build-error result. The patch applied (not PATCH_INVALID)
  // but the resulting source failed self-check the same way every turn
  // — dupe-break would never fire if it gated on PATCH_INVALID only.
  //
  // `isFailedPatch` widens the gate to "any failed apply_changes turn";
  // `extractErrSignature` pulls a coarse error class from either:
  //   - PATCH_INVALID: `esbuild error: <msg>`
  //   - PATCH_APPLIED_BROKEN: `esbuild error: <msg>` (different prefix, same line)
  //   - SELF_CHECK_FAIL: first violation line (e.g. "[security] ..." / "Build errors: ...")
  // A failed patch with an unrecognizable error format still fingerprints
  // (errClass becomes empty string, ranges+code carry the load).
  const isFailedPatch = !result.done && isApplyChanges;

  // ─────────────────────────────────────────────────────────────────────────
  // Diagnostic outcome scoring.
  // ─────────────────────────────────────────────────────────────────────────
  // The PRIOR turn rendered the diagnostic retry prompt. Score what
  // happened on this turn before any new dupe detection runs:
  //   - did commit_message contain a parseable `DIAG:` (engagement)?
  //   - did the LLM escape the loop (PASS, OR PATCH_INVALID with a
  //     fingerprint that differs from `lastFailedPatchFingerprint`,
  //     which still holds the dupe fingerprint we just intervened on)?
  //
  // Cleared regardless of outcome — one-shot scoring window.
  if (ctx.dupeBreak?.awaitingDiagnosticOutcome) {
    ctx.dupeBreak.awaitingDiagnosticOutcome = false;
    const commitMsg =
      typeof call.input?.commit_message === "string"
        ? call.input.commit_message
        : "";
    const returnedDiag = /^\s*DIAG\s*:/i.test(commitMsg);
    if (returnedDiag) {
      ctx.dupeBreak.diagnosticReturnedCount++;
      console.log(
        `[coding-agent] DUPE_DIAGNOSTIC_RETURNED | msg=${JSON.stringify(commitMsg.slice(0, 120))}`,
      );
    } else {
      console.log(
        `[coding-agent] DUPE_DIAGNOSTIC_RETURNED=false | msg=${JSON.stringify(commitMsg.slice(0, 120))}`,
      );
    }
    // Did the dupe loop break? The gate covers any failed
    // apply_changes (matching the detection block above). PASS /
    // DIFF_FAIL count as broken-by-progress; SELF_CHECK_FAIL on a
    // different patch counts as broken; an identical SELF_CHECK_FAIL
    // counts as stuck.
    const dupeFp = ctx.dupeBreak.lastFailedPatchFingerprint;
    let brokeLoop = false;
    if (result.done) {
      brokeLoop = true;
    } else if (isApplyChanges && dupeFp) {
      const { computePatchFingerprint } = await import("./dupe-break.js");
      const changes2 = (call.input?.changes as
        | ReadonlyArray<{ startLine: number; endLine: number; code: string[] }>
        | undefined) ?? [];
      const errText2 = extractFailSignature(result.result);
      const currentFp = computePatchFingerprint(changes2, errText2);
      brokeLoop = currentFp !== dupeFp;
    } else {
      brokeLoop = true;
    }
    if (brokeLoop) {
      ctx.dupeBreak.diagnosticBrokeLoopCount++;
      console.log(`[coding-agent] DUPE_DIAGNOSTIC_BROKE_LOOP=true`);
    } else {
      console.log(`[coding-agent] DUPE_DIAGNOSTIC_BROKE_LOOP=false`);
    }
  }

  let augmentedResultText = result.result;
  if (
    isFailedPatch &&
    effectivePolicy?.breakDuplicatePatch &&
    ctx.dupeBreak
  ) {
    const { computePatchFingerprint } = await import("./dupe-break.js");
    const changes = (call.input?.changes as
      | ReadonlyArray<{ startLine: number; endLine: number; code: string[] }>
      | undefined) ?? [];
    const errText = extractFailSignature(result.result);
    const fingerprint = computePatchFingerprint(changes, errText);
    const priorPrint = ctx.dupeBreak.lastFailedPatchFingerprint;
    const inCooldown = ctx.dupeBreak.cooldown > 0;
    if (priorPrint && priorPrint === fingerprint && !inCooldown) {
      // Dupe detected — branch on the policy's intervention choice.
      ctx.dupeBreak.cooldown = 3;
      ctx.dupeBreak.firedCount++;
      const action = effectivePolicy.dupeBreakAction ?? "escape";
      console.log(
        `[coding-agent] DUPLICATE_PATCH_BREAK fired | action=${action} | fingerprint=${fingerprint.slice(0, 12)} error=${JSON.stringify(errText.slice(0, 48))}`,
      );
      // Always record this failure into the recent-patches ring (newest first,
      // cap 2). Read by the diagnostic prompt; harmless under "escape" action.
      const codeHead = (() => {
        const sorted = [...changes].sort(
          (a, b) => a.startLine - b.startLine || a.endLine - b.endLine,
        );
        const flat = sorted
          .map((c) => (Array.isArray(c.code) ? c.code.join("\n") : String(c.code ?? "")))
          .join("\n");
        return flat.slice(0, 200);
      })();
      const rangesShort = [...changes]
        .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine)
        .map((c) => `${c.startLine}-${c.endLine}`)
        .join(", ");
      const errClass = (errText || "unknown").toLowerCase().slice(0, 60);
      const summary = { rangesShort, codeHead, errClass, fingerprint };
      ctx.dupeBreak.recentFailedPatches = [
        summary,
        ...ctx.dupeBreak.recentFailedPatches,
      ].slice(0, 2);

      if (action === "diagnostic" || action === "diagnostic-noforce") {
        // #43 / #44: leave tool surface alone; switch the next turn's
        // prompt to the structured-diagnosis variant. The prompt
        // assembly checks `action` again to decide whether to include
        // the "must differ materially" rule (#43) or omit it (#44).
        ctx.dupeBreak.pendingDiagnosticTurn = true;
        ctx.dupeBreak.diagnosticFiredCount++;
        // The augmented retry text below explains WHY the next prompt
        // will look different. Tools still unrestricted.
        augmentedResultText =
          `[DUPLICATE_PATCH] Identical failed patch detected.\n` +
          `Your previous patch was byte-identical to one you tried before ` +
          `and failed for the same reason. The next prompt will give you a ` +
          `focused excerpt of the failing region with line numbers and ` +
          `require a one-line structured diagnosis (in commit_message) ` +
          `before your next patch. Your next apply_changes MUST differ ` +
          `materially from the prior failed patch — different ranges OR ` +
          `meaningfully different code.\n\n` +
          `Repeated error: ${errText}\n\n---\n\n` +
          result.result;
      } else {
        // #41/#42 (dormant): tool-surface escape via APPLY_CHANGES_TOOL_SCOPED.
        ctx.dupeBreak.forceEscapeNextTurn = true;
        augmentedResultText =
          `[DUPLICATE_PATCH] Identical failed patch detected.\n` +
          `Your previous patch failed with the same error, and this retry is byte-identical.\n` +
          `The next turn is FORCED to a scoped single-change apply_changes ` +
          `(one change, ≤20 lines). Target the minimal failing region — ` +
          `do not retry the full patch. The rest of the file is correct.\n\n` +
          `Repeated error: ${errText}\n\n---\n\n` +
          result.result;
      }
    }
    // Always record the current fingerprint so the NEXT patch turn can compare.
    ctx.dupeBreak.lastFailedPatchFingerprint = fingerprint;
  }
  // A successful done-patch breaks the chain — the LLM moved on. Reset
  // so we don't match stale fingerprints if a later successful patch
  // happens to land on the same ranges. The gate is `result.done` so
  // the SELF_CHECK_FAIL / PATCH_APPLIED_BROKEN paths still persist
  // their fingerprint for the next-turn comparison.
  if (result.done && ctx.dupeBreak?.lastFailedPatchFingerprint) {
    ctx.dupeBreak.lastFailedPatchFingerprint = null;
  }

  // Track consecutive PATCH_APPLIED_BROKEN (apply-and-warn) events so
  // selectTurnTools can escalate to REWRITE_TOOL after N in a row. The
  // counter resets on any clean apply (PASS / auto-commit success) so
  // the escape triggers only on sustained tangled states.
  if (ctx.dupeBreak && call.name === "apply_changes") {
    const wasBrokenApply = result.result.startsWith("PATCH_APPLIED_BROKEN");
    if (wasBrokenApply) {
      ctx.dupeBreak.consecutiveBrokenApplies++;
    } else if (!result.error) {
      // clean apply (or non-error result for any reason) — reset
      ctx.dupeBreak.consecutiveBrokenApplies = 0;
    }
  } else if (ctx.dupeBreak && call.name === "rewrite") {
    // rewrite succeeded — file is fresh, reset the escape counter
    if (!result.error) ctx.dupeBreak.consecutiveBrokenApplies = 0;
  }

  // Send tool result back to close the API contract (Google/OpenAI/OpenRouter)
  // This enables proper session chaining on the next callTools() invocation.
  await codingAgent.sendToolResult([{
    callId: call.id,
    name: call.name,
    result: augmentedResultText,
    isError: !!result.error,
  }]);

  // Track whether the diff itself failed to apply (vs applied but had violations)
  const turnDiffFailed = !!result.error && result.result.includes("DIFF");

  // (`isPatchInvalid` was already computed above for dupe-break detection.)
  const isDiffFail = turnDiffFailed && !isPatchInvalid;
  const outcome: CodingTurnOutcome = result.done
    ? "PASS"
    : isPatchInvalid
      ? "PATCH_INVALID"
      : isDiffFail
        ? "DIFF_FAIL"
        : "SELF_CHECK_FAIL";

  const phase: CodingTurnPhase =
    a1Phase === "scaffold"
      ? "scaffold"
      : a1Phase === "fill"
        ? "fill"
        : turnsUsed === 1
          ? "impl"
          : isEvalFeedback
            ? "eval-fix"
            : "patch";

  console.log(
    `[simple] turn ${turnsUsed} (${phase}): ${outcome} | llm=${llmMs}ms tool=${toolMs}ms | in=${response.inputTokens} out=${response.outputTokens}`,
  );
  // Preview model output for debugging — show first tool call summary
  if (!result.done) {
    const preview = JSON.stringify(call.input).slice(0, 150);
    console.log(`[simple] turn ${turnsUsed} preview: ${preview}...`);
  }

  if (!result.done) {
    // Self-check failed — feed back errors for next turn (phase 2)
    return {
      control: "continue",
      compiledCode: "",
      selfCheckPassed: false,
      outcome,
      phase,
      tokens,
      llmMs,
      toolMs,
      // Use the augmented text so the next turn's prompt gets the
      // [DUPLICATE_PATCH] preface when dupe-break fired (noop otherwise).
      lastResultText: augmentedResultText,
      lastDiffFailed: turnDiffFailed,
      isEvalFeedback: false,
      iconNamesCache,
      preWarmedContext,
    };
  }

  // ── Self-check passed — extract best compiled code from commit metadata ──
  let compiledCode = "";
  let selfCheckPassed = false;
  for (const [, meta] of commitMeta) {
    if (meta.build.success && meta.selfCheck.passed && meta.build.compiledCode) {
      compiledCode = meta.build.compiledCode;
      selfCheckPassed = true;
    }
  }
  if (!compiledCode) {
    // Fallback: use compiled-but-self-check-failed code (best effort for this session,
    // but should NOT be cached in pool — may have runtime bugs)
    for (const [, meta] of commitMeta) {
      if (meta.build.success && meta.build.compiledCode) {
        compiledCode = meta.build.compiledCode;
      }
    }
  }

  return {
    control: "proceed",
    compiledCode,
    selfCheckPassed,
    outcome,
    phase,
    tokens,
    llmMs,
    toolMs,
    lastResultText,
    lastDiffFailed: turnDiffFailed,
    isEvalFeedback,
    iconNamesCache,
    preWarmedContext,
  };
}
