// packages/ui-gen/src/harness/coding/init-session.ts
//
// Build a coding session — workspace, agent, lazy-loaded eval modules,
// pre-warm promise. Captured once per generation, reused for every
// coding turn + eval round inside the closure-based generate runner.
//
// Step 3 of the runHarness migration (#142). Pure additive — the
// existing runSimpleHarness still builds its own session inline.

import { AgentWorkspace } from "../../coding-agent/workspace.js";
import type { CommitMetadata } from "../../coding-agent/types.js";
import type { CostTracker } from "../../evaluation/cost-tracker.js";
import { mapProviderForEvaluator } from "../enforced-coding.js";
import { createAgent } from "../llm-router.js";
import type { LLMAgent } from "../llm-router.js";
import { APPLY_CHANGES_TOOL, GET_ICONS_TOOL } from "../../tools.js";
import type { Harness } from "../types-public.js";
import type { AgentSpec, SingleComponentParams } from "../runtime.js";
import type { ResolvedRunPolicy } from "../policy.js";
import { DEFAULT_HARNESS_POLICY } from "../policy.js";
import { createDupeBreakState, type DupeBreakState } from "./dupe-break.js";

type PreWarmedEvalContext =
  import("../../evaluation/llm-evaluator.js").PreWarmedEvalContext;
type TiersMod = typeof import("../../check/index.js");
type LlmEvalMod = typeof import("../../evaluation/llm-evaluator.js");
type VisualEvalMod = typeof import("../../evaluation/visual-evaluator.js");

export interface SessionAgents {
  /** Coding agent + model — drives apply_changes turns. */
  readonly coding: AgentSpec;
  /** Code-eval agent + model — falls back to coding when caller omits. */
  readonly evaluation: AgentSpec;
  /** Visual-eval agent + model — falls back to evaluation. */
  readonly visualEval: AgentSpec;
}

export interface CodingSession {
  // Long-lived per-generation state (closure-captured by the task runner).
  readonly harness: Harness;
  readonly workspace: AgentWorkspace;
  readonly codingAgent: LLMAgent;
  readonly agents: SessionAgents;
  readonly commitMeta: Map<string, CommitMetadata>;
  readonly boilerplate: string;
  readonly originalProps: string | undefined;
  readonly systemPrompt: string;

  // Eval gate config (computed once from params/qualityConfig).
  readonly codeEvalEnabled: boolean;
  readonly visualEvalEnabled: boolean;
  readonly maxEvalRounds: number;
  readonly visualThreshold: number;
  readonly qualityMode: "fast" | "auto-improve" | "high-quality";

  // Lazy-loaded eval modules — null when eval disabled.
  readonly tiersMod: TiersMod | null;
  readonly llmEvalMod: LlmEvalMod | null;
  readonly visualMod: VisualEvalMod | null;
  readonly costTracker: CostTracker | null;

  // Pre-warm runs concurrently with coding so the first eval round skips
  // the criteria-generation cost.
  readonly preWarmPromise: Promise<PreWarmedEvalContext | null> | undefined;

  /**
   * Runtime-resolved policy for this generation. Defaults to the
   * harness's static policy. dispatchGeneration may call
   * {@link resolveRunPolicyForProfile} and pass a provider-aware
   * override here when an experimental profile is active.
   */
  readonly resolvedPolicy: ResolvedRunPolicy;

  /**
   * Mutable duplicate-patch-break state machine. Gated by
   * `resolvedPolicy.context.breakDuplicatePatch`. Always initialized
   * (so downstream code can read safely) but no-ops when the flag is off.
   * See {@link DupeBreakState} in `./dupe-break.ts`.
   */
  readonly dupeBreak: DupeBreakState;

  /** Wall-clock at session creation. Used for total-elapsed in result assembly. */
  readonly startedAtMs: number;
}

/**
 * Resolve agent specs from caller config, applying the documented fallbacks:
 *   evaluation  ← codingAgent
 *   visualEval  ← evaluationAgent ← codingAgent
 */
export function resolveSessionAgents(config: {
  codingAgent: AgentSpec;
  evaluationAgent?: AgentSpec;
  visualEvalAgent?: AgentSpec;
}): SessionAgents {
  const coding = config.codingAgent;
  const evaluation = config.evaluationAgent ?? coding;
  const visualEval = config.visualEvalAgent ?? evaluation;
  return { coding, evaluation, visualEval };
}

/**
 * Construct a coding session: init workspace, scaffold-commit the
 * boilerplate, create + warm-cache the coding agent, lazy-load eval
 * modules, and kick off pre-warm.
 */
export async function initSession(input: {
  harness: Harness;
  params: SingleComponentParams;
  agents: SessionAgents;
  /** Optional runtime-resolved policy. Defaults to the harness's static
   *  policy when omitted. */
  resolvedPolicy?: ResolvedRunPolicy;
  /** Optional override for the first-turn system prompt. When provided,
   *  replaces `harness.how.systemPrompt` verbatim. Used by
   *  `dispatchGeneration` to inject the axis-keyed primitives doc slice
   *  without rebuilding the Harness. `harness.how.systemPrompt` is still
   *  the default when this is undefined. */
  systemPromptOverride?: string;
}): Promise<CodingSession> {
  const { harness, params, agents } = input;
  const resolvedPolicy =
    input.resolvedPolicy ?? harness.policy ?? DEFAULT_HARNESS_POLICY;
  const startedAtMs = Date.now();

  // ── Boilerplate (from harness — WHAT leg) ──
  const boilerplate = harness.what.boilerplate;
  console.log(
    `[simple] boilerplate: ${boilerplate.split("\n").length} lines, ` +
      `shell=${params.shellType ?? "fullscreen"}, ` +
      `screen=${params.screen ?? "universal"}`,
  );

  // ── Init workspace + scaffold commit ──
  const workspace = new AgentWorkspace();
  await workspace.init();
  const commitMeta = new Map<string, CommitMetadata>();

  workspace.write(boilerplate);
  await workspace.stage();
  await workspace.commit("scaffold: boilerplate");

  // ── System prompt (from harness — HOW leg, or override for #45) ──
  const systemPrompt = input.systemPromptOverride ?? harness.how.systemPrompt;

  // ── Create + warm-cache the coding agent ──
  const codingAgent = createAgent(agents.coding.provider);
  await codingAgent.warmCache(
    agents.coding.model,
    systemPrompt,
    [APPLY_CHANGES_TOOL, GET_ICONS_TOOL],
    "required",
  );

  // ── Pre-warm eval (overlaps with coding turn 1) ──
  // Uses a separate agent instance so it doesn't disturb the coding cache.
  let preWarmPromise: Promise<PreWarmedEvalContext | null> | undefined;
  if (params.evaluation?.enabled) {
    const evalSpec = agents.evaluation;
    preWarmPromise = import("../../evaluation/llm-evaluator.js")
      .then((mod) =>
        mod.preWarmEval(
          {
            sourceCode: "",
            originalPrompt: params.userPrompt,
            contract: params.contract,
            designContext: undefined,
          },
          {
            provider: mapProviderForEvaluator(evalSpec.provider),
            model: evalSpec.model,
          },
        ),
      )
      .catch((e) => {
        console.warn(`[simple] eval pre-warm failed: ${e instanceof Error ? e.message : e}`);
        return null;
      });
  }

  // ── Extract un-diffable Props interface ──
  // After each apply_changes the runner restores it so the LLM can't break
  // the contract by mutating the props shape.
  const propsMatch = boilerplate.match(/interface Props \{[\s\S]*?\n\}/);
  const originalProps = propsMatch?.[0];

  // ── Eval gate + lazy-loaded modules ──
  const qualityConfig = params.qualityConfig;
  const qualityMode = qualityConfig?.quality ?? "fast";
  const codeEvalEnabled = !!params.evaluation?.enabled;
  const visualEvalEnabled = !!(params.visualEvaluation?.enabled || qualityConfig?.visualEval);
  const maxEvalRounds =
    qualityMode === "high-quality"
      ? (params.evaluation?.maxRounds ?? 3)
      : (params.evaluation?.maxRounds ?? 2);
  const visualThreshold = params.visualEvaluation?.passThreshold ?? 70;

  let tiersMod: TiersMod | null = null;
  let llmEvalMod: LlmEvalMod | null = null;
  let visualMod: VisualEvalMod | null = null;
  let costTracker: CostTracker | null = null;

  if (codeEvalEnabled || visualEvalEnabled) {
    tiersMod = await import("../../check/index.js");
    const costTrackerMod = await import("../../evaluation/cost-tracker.js");
    costTracker = new costTrackerMod.CostTracker(
      qualityConfig?.maxCostPerGeneration ?? null,
    );
    if (codeEvalEnabled) {
      llmEvalMod = await import("../../evaluation/llm-evaluator.js");
    }
    if (visualEvalEnabled) {
      visualMod = await import("../../evaluation/visual-evaluator.js").catch(() => null);
    }
  }

  return {
    harness,
    workspace,
    codingAgent,
    agents,
    commitMeta,
    boilerplate,
    originalProps,
    systemPrompt,
    codeEvalEnabled,
    visualEvalEnabled,
    maxEvalRounds,
    visualThreshold,
    qualityMode,
    tiersMod,
    llmEvalMod,
    visualMod,
    costTracker,
    preWarmPromise,
    resolvedPolicy,
    dupeBreak: createDupeBreakState(),
    startedAtMs,
  };
}
