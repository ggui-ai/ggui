// First-class `Harness` type — the thing a classification produces that
// actually drives UI generation. Structurally aligned with the TRIAD
// principle: HOW / WHAT / CHECK are explicit legs, plus a Process
// dimension that carries the workflow DAG.
//
// Design doctrine:
//   - Classification → createHarness → Harness. Single dispatch step.
//   - Per-axis decomposition belongs to HOW/WHAT/CHECK (fragment registry).
//     Workflow is selected as a whole based on classification shape.
//   - Workflow is pure-productive: inputs → source. Eval runs AFTER a
//     workflow completes; failure triggers derive-and-retry at the
//     orchestration level, not inside the workflow.
//   - Harness is immutable per run; `derive()` produces a new Harness
//     when a planner reclassifies or a runtime signal demands a topology
//     swap.
//
// This file is a pure type module with no runtime — it is the single
// types hub for the harness module. `AxisCheck` + `AxisCheckInput` live
// in `@ggui-ai/ui-gen/evaluation`.

import type { GadgetDescriptor, DataContract, JsonValue } from "@ggui-ai/protocol";
import type { Classification } from "../classifier/axes.js";
import type { EvalIssue, EvalTier, AxisCheck } from "../evaluation/types-public.js";
import type { LLMToolDef } from "../llm.js";
import type { CacheTier, HarnessFragment } from "../fragments/index.js";
import type { HarnessPolicy, ProcessMode } from "../policy.js";

export type { ProcessMode };

// ─────────────────────────────────────────────────────────────────────────────
// Harness identity
// ─────────────────────────────────────────────────────────────────────────────

/** Deterministic fingerprint of a harness. Same inputs → same id. */
export type HarnessId = string;

/** Human-readable name — e.g., "axis-v1/state=merge+realtime=mixed/staged". */
export type HarnessName = string;

// ─────────────────────────────────────────────────────────────────────────────
// HOW leg — the system prompt + axis-keyed prose
// ─────────────────────────────────────────────────────────────────────────────

export interface HowLeg {
  /** Fully materialized system prompt — A4-lite v2 stable prefix + axisDelta injection. */
  readonly systemPrompt: string;
  /** Extra turn-1 implementation prompt (axisDelta text, empty for now). */
  readonly implPrompt: string;
  /** Fragments that contributed to HOW (have non-empty promptText). */
  readonly fragments: readonly HarnessFragment[];
  /** Version tag — bumps when buildSystemPrompt semantics change. */
  readonly version: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// WHAT leg — the scaffold + tool grammar + patch interpreter
// ─────────────────────────────────────────────────────────────────────────────

/** Signature for the patch-application function (pluggable per harness). */
export type PatchFn = (input: {
  sourceBefore: string;
  changes: ReadonlyArray<{
    startLine: number;
    endLine: number;
    code: readonly string[];
    description?: string;
  }>;
}) => Promise<{
  ok: boolean;
  sourceAfter?: string;
  error?: string;
  preflightIssues?: readonly EvalIssue[];
}>;

export interface WhatLeg {
  /** Rendered boilerplate source — base.tsx.tmpl + Props/Actions/Streams + axis markers. */
  readonly boilerplate: string;
  /** Fragments that contributed to WHAT (have non-empty boilerplateMarker). */
  readonly fragments: readonly HarnessFragment[];
  /** Primary tool grammar used by the LLM to emit changes. */
  readonly codingTools: readonly LLMToolDef[];
  /** Narrower fallback tool grammar — invoked on malformed_tool_call retries. */
  readonly scopedTools?: readonly LLMToolDef[];
  /** Patch interpreter — swappable per harness variant (e.g., "atomic" vs "diff3"). */
  readonly applyPatch: PatchFn;
  /**
   * Operator-registered gadget catalog. Threaded verbatim from
   * `createHarness({ appGadgets })`. Drives the system-prompt gadget
   * table and the boilerplate's direct-import emission (one
   * `import { useFoo } from '<package>'` per registered gadget
   * package). Omitted when no gadgets are registered.
   */
  readonly appGadgets?: readonly GadgetDescriptor[];
  /**
   * A `package -> .d.ts content` map for third-party gadget wrappers.
   * Threaded verbatim from `createHarness({ gadgetTypes })` so
   * coding-agent tool execution (autoCommit → runTier0Checks →
   * typecheck) overlays each wrapper `.d.ts` into the TypeScript
   * sandbox VFS at `node_modules/<package>/index.d.ts`. Without it a
   * generated direct `import { useFoo } from '<package>'` collapses to
   * `any` and the LLM loses strict option/return narrowing.
   */
  readonly gadgetTypes?: Readonly<Record<string, string>>;
  /** Version tag — bumps when boilerplate or tool grammar semantics change. */
  readonly version: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK leg — gated self-eval + tier checks + LLM evaluator
// ─────────────────────────────────────────────────────────────────────────────

/** Deterministic tier-0/1/2 check (e.g., typecheck, render-smoke, compile-smoke). */
export interface TierCheck {
  readonly id: string;
  readonly tier: EvalTier;
  readonly run: (input: {
    sourceCode: string;
    compiledCode: string | null;
  }) => readonly EvalIssue[] | Promise<readonly EvalIssue[]>;
}

/** LLM-driven aesthetic/functional review (post-compile). */
export interface LLMEvaluator {
  readonly id: string;
  readonly run: (input: {
    sourceCode: string;
    compiledCode: string | null;
    contract: DataContract;
    prompt: string;
  }) => Promise<readonly EvalIssue[]>;
}

/**
 * Runtime render check — eval-time verification that a compiled component
 * actually wires its declared contract surface (actions, streams,
 * context slots, client capabilities) to interactive DOM.
 */
export interface RuntimeRenderCheck {
  readonly id: string;
  readonly run: (input: {
    sourceCode: string;
    compiledCode: string | null;
    contract?: DataContract;
    /** Optional fixture props (e.g., from a benchmark commit) — wins over schema synthesis. */
    fixtureProps?: import("@ggui-ai/protocol").JsonObject;
  }) => Promise<readonly EvalIssue[]>;
}

export interface CheckLeg {
  /** Axis-gated checks — only those whose `matches()` fire on this classification. */
  readonly axisChecks: readonly AxisCheck[];
  /** Deterministic tier checks (always fire). */
  readonly tierChecks: readonly TierCheck[];
  /**
   * Runtime render verification — optional, fires only when the harness
   * has a contract worth checking. Adds ~100-300ms to eval.
   */
  readonly runtimeRender?: RuntimeRenderCheck;
  /** Optional LLM evaluator (may be omitted for fast-path classifications). */
  readonly llmEvaluator?: LLMEvaluator;
  /** Version tag. */
  readonly version: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Process leg — execution topology (the workflow DAG)
// ─────────────────────────────────────────────────────────────────────────────

/** A single LLM call (or deterministic step) within a workflow phase. */
export interface Task {
  readonly id: string;
  /** System prompt — either a static string or a builder reading prior results. */
  readonly systemPrompt: string | PromptBuilder;
  /** How to assemble the user message for this task. */
  readonly contextBuilder: (ctx: TaskContext) => string;
  /** Which prior-task outputs to inject by name. Default: all. */
  readonly inputs?: readonly string[];
  /** Task-specific tool grammar (omit to inherit from harness.what.codingTools). */
  readonly tools?: readonly LLMToolDef[];
  /** How the LLM returns its result. */
  readonly outputFormat: "tool-call" | "structured" | "text";
  /** Coerce raw LLM output into a typed value. */
  readonly outputParser: (raw: unknown) => JsonValue;
  /** Key under which this task's output is available to downstream tasks. */
  readonly outputName: string;
  /** Max output tokens for this task. */
  readonly maxTokens?: number;
}

export type PromptBuilder = (ctx: TaskContext) => string;

export interface TaskContext {
  readonly harness: Harness;
  readonly priorResults: Readonly<Record<string, JsonValue>>;
  readonly classification: Classification;
  readonly prompt: string;
  readonly contract: DataContract;
}

export interface Phase {
  readonly id: string;
  /** Tasks to run in parallel within this phase. */
  readonly tasks: readonly Task[];
  /** Prior phase IDs this one depends on. Default: immediately preceding phase. */
  readonly dependsOn?: readonly string[];
}

export interface Workflow {
  readonly id: string;
  readonly name: string;
  readonly phases: readonly Phase[];
  /** Human-readable description for logs. */
  readonly description?: string;
}

/** Runtime planner — turn-1 hook that may reclassify + return a revision. */
export type PlannerFn = (input: {
  harness: Harness;
  prompt: string;
  contract: DataContract;
}) => Promise<PlannerDecision>;

export interface PlannerDecision {
  readonly action: "continue" | "reclassify" | "restage";
  readonly reclassifyAs?: Classification;
  readonly restageAs?: Workflow;
  readonly reasoning: string;
}

/** Retry policy — how the harness responds to runtime signals during workflow. */
export interface RetryPolicy {
  readonly onMalformedToolCall?: (harness: Harness) => HarnessRevision | null;
  readonly onPatchInvalid?: (
    harness: Harness,
    issues: readonly EvalIssue[],
  ) => HarnessRevision | null;
  readonly maxIterations: number;
}

export interface ProcessLeg {
  /**
   * Coarse topology label — kept for backward-compat + filtering. The
   * workflow is the source of truth; this is a label on it.
   */
  readonly mode: ProcessMode;
  /** The DAG that actually runs. */
  readonly workflow: Workflow;
  /** Optional turn-1 re-selector. */
  readonly planner?: PlannerFn;
  /** Policy for runtime-signal fallbacks. */
  readonly retry: RetryPolicy;
  /** Version tag. */
  readonly version: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Harness metadata
// ─────────────────────────────────────────────────────────────────────────────

export interface HarnessMeta {
  /** Hash of the classification used to produce this harness. */
  readonly classificationHash: string;
  /** IDs of fragments that contributed to HOW + WHAT legs. */
  readonly fragmentIds: readonly string[];
  /** Count of fragments by cache tier — for audit + cache-cost reasoning. */
  readonly cacheTierBreakdown: Readonly<Record<CacheTier, number>>;
  /** Names of overrides applied (empty if harness is vanilla). */
  readonly overrides: readonly string[];
  /** When this harness was constructed. */
  readonly createdAt: string;
  /** Overall harness-module version — bumps when the type shape changes. */
  readonly harnessVersion: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Harness — the first-class unit that drives generation
// ─────────────────────────────────────────────────────────────────────────────

export interface Harness {
  readonly id: HarnessId;
  readonly name: HarnessName;
  readonly classification: Classification;

  readonly how: HowLeg;
  readonly what: WhatLeg;
  readonly check: CheckLeg;
  readonly process: ProcessLeg;

  /**
   * Static harness-level policy — controls the SHAPE of feedback the LLM
   * sees on retry/patch surfaces (and, in future, eval/retry topologies).
   * Resolved at createHarness time by `resolveHarnessPolicy`. Defaults
   * match pre-R3 behavior exactly; only non-default policies appear in
   * `meta.overrides`. See `@ggui-ai/ui-gen/policy`.
   */
  readonly policy: HarnessPolicy;

  readonly meta: HarnessMeta;

  /**
   * Produce a derived harness for a subsequent iteration — turn-1 planner
   * reclassification or runtime-signal topology swap. Current harness stays
   * immutable; `derive()` returns a new one.
   */
  derive(revision: HarnessRevision): Harness;
}

// ─────────────────────────────────────────────────────────────────────────────
// Revision + overrides
// ─────────────────────────────────────────────────────────────────────────────

/** A diff applied on top of a harness to produce a new one. */
export interface HarnessRevision {
  /** Rebuild as if classified differently. */
  readonly classification?: Classification;
  /** Swap to a different workflow DAG. */
  readonly workflow?: Workflow;
  /** Promote scopedTools → codingTools (runtime fallback). */
  readonly useFallbackTools?: boolean;
  /** Attach a freeform override bundle. */
  readonly overrides?: HarnessOverrides;
}

/**
 * Plug-point surface for experimental harness variants. Each leg accepts
 * either a partial override object OR a function that builds that leg from
 * the default base + a construction context.
 */
export interface HarnessOverrides {
  readonly how?:
    | Partial<HowLeg>
    | ((base: HowLeg, ctx: HarnessConstructionContext) => HowLeg);
  readonly what?:
    | Partial<WhatLeg>
    | ((base: WhatLeg, ctx: HarnessConstructionContext) => WhatLeg);
  readonly check?:
    | Partial<CheckLeg>
    | ((base: CheckLeg, ctx: HarnessConstructionContext) => CheckLeg);
  readonly process?:
    | Partial<ProcessLeg>
    | ((base: ProcessLeg, ctx: HarnessConstructionContext) => ProcessLeg);
  /** Label for meta.overrides listing. */
  readonly label?: string;
}

/** Context passed to override builder functions. */
export interface HarnessConstructionContext {
  readonly classification: Classification;
  readonly contract: DataContract;
  readonly prompt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public construction API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builder for the HOW-leg system prompt. Receives the classification-
 * derived inputs (`userRequest`, `shellType`, `screen`, `axisDelta`) and
 * returns a fully-materialized prompt string.
 *
 * Default when `systemPromptBuilder` is omitted on `CreateHarnessInput`:
 * the skeleton `buildSystemPrompt` from `@ggui-ai/ui-gen/boilerplate`
 * with its content blocks (pitfalls, design-system docs, primitives
 * doc, wire doc) defaulted to empty. Callers can wrap `buildSystemPrompt`
 * with fully-populated content blocks and pass the wrapper.
 */
export type SystemPromptBuilder = (input: {
  readonly userRequest: string;
  readonly shellType?: string;
  readonly screen?: string;
  readonly axisDelta?: string;
}) => string;

export interface CreateHarnessInput {
  readonly classification: Classification;
  readonly contract: DataContract;
  readonly prompt: string;
  readonly shellType?: "chat" | "fullscreen" | "spatial";
  readonly screen?: "mobile" | "tablet" | "desktop" | "universal";
  readonly overrides?: HarnessOverrides;
  /**
   * Pre-resolved static harness policy. When omitted, `createHarness`
   * falls back to `DEFAULT_HARNESS_POLICY` from `@ggui-ai/ui-gen/policy`.
   * Callers can pre-resolve via a `resolveHarnessPolicy` variant (e.g.
   * one that reads `GGUI_POLICY_PROFILE` and dispatches experimental
   * branches) and pass the result here.
   */
  readonly policy?: HarnessPolicy;
  /**
   * Builder for the HOW-leg system prompt. When omitted, `createHarness`
   * falls back to the skeleton `buildSystemPrompt` from
   * `@ggui-ai/ui-gen/boilerplate` (empty content blocks). Callers can
   * inject a builder that wraps the skeleton with fully-populated
   * content (pitfalls, design-system docs, primitives doc, wire doc).
   */
  readonly systemPromptBuilder?: SystemPromptBuilder;
  /**
   * Pre-filtered axis-gated checks to install on `check.axisChecks`.
   * When omitted, `createHarness` installs an empty list — consumers
   * that want axis-keyed evaluation supply the pre-filtered registry
   * here (using `matches()` from `@ggui-ai/ui-gen/evaluation`). The
   * filter step is explicit caller work — `createHarness` does not
   * import a registry itself.
   */
  readonly axisChecks?: readonly AxisCheck[];
  /**
   * Optional runtime render check — eval-time verification that a
   * compiled component wires its declared contract surface (actions,
   * streams, context slots, client capabilities) to interactive DOM.
   * When omitted, `createHarness` sets `check.runtimeRender = undefined`
   * (the check leg skips the stage). Heavy runtime deps (happy-dom,
   * `@ggui-ai/wire`, `@ggui-ai/design`) keep this out of the default;
   * callers can inject `DEFAULT_RUNTIME_RENDER_CHECK`.
   */
  readonly runtimeRender?: RuntimeRenderCheck;
  /**
   * Operator-registered gadget catalog. Forwarded to
   * `generateBoilerplate` so the starter file's
   * `import { useLeafletMap } from '<package>'` line resolves to the
   * registered descriptor's `package` field — without this, thin
   * contract refs (`{hook: 'useLeafletMap'}` with no per-binding
   * `package`) default to `@ggui-ai/gadgets`, which doesn't export
   * operator-registered wrapper hooks; the LLM sees an import that
   * won't resolve and removes the hook with a "not available" comment.
   * ALSO forwarded to the default `systemPromptBuilder` when no custom
   * builder is supplied.
   *
   * When omitted, the boilerplate falls back to the `package` field on
   * each entry (or `@ggui-ai/gadgets` when nothing is specified).
   */
  readonly appGadgets?: readonly GadgetDescriptor[];
  /**
   * A `package -> .d.ts content` map for third-party gadget wrappers
   * (the push handler parallel-fetches each non-stdlib gadget's `.d.ts`
   * via `GadgetDescriptor.typesUrl`). Threaded onto the `WhatLeg` so
   * coding-agent tool execution (autoCommit → runTier0Checks →
   * typecheck) overlays each `.d.ts` into the TypeScript sandbox VFS —
   * yielding strict third-party hook types. Also forwarded to the
   * default `systemPromptBuilder` so the code-gen prompt renders a
   * `Type:` line per third-party gadget. Omitted for STDLIB-only
   * callers.
   */
  readonly gadgetTypes?: Readonly<Record<string, string>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator cluster
// ─────────────────────────────────────────────────────────────────────────────
//
// The runtime for the HOW/WHAT/CHECK/Process spine:
//   - runWorkflow : phase DAG executor (pluggable task runners).
//   - runCheck    : iterates CheckLeg against produced source.
//   - runHarness  : end-to-end loop (runWorkflow → compile → runCheck →
//                   derive-on-fail, up to process.retry.maxIterations).
//
// These are re-exported on this subpath. Task runner implementations
// (notably the coding/generate runner) live elsewhere in the package.

export { runWorkflow } from "../run-workflow.js";
export type {
  RunWorkflowInput,
  WorkflowRunResult,
  PhaseRunResult,
  TaskRunner,
  DefaultTaskRunner,
} from "../run-workflow.js";

export { runCheck } from "../run-check.js";
export type { RunCheckInput, CheckResult } from "../run-check.js";

export { runHarness } from "../run-harness.js";
export type {
  RunHarnessInput,
  RunHarnessResult,
  RunHarnessReason,
  IterationRecord,
} from "../run-harness.js";

// ─────────────────────────────────────────────────────────────────────────────
// Skeleton constructor
// ─────────────────────────────────────────────────────────────────────────────
//
// All four injection seams (policy / systemPromptBuilder / axisChecks /
// runtimeRender) are caller-injected, so the constructor body is pure
// assembly. The `HarnessOverrides.check.axisChecks` / `.runtimeRender`
// paths still work for advanced override cases; the top-level input
// fields are the ergonomic default-injection seam for the common case.

export { createHarness } from "../create-harness.js";
