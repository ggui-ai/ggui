// Evaluation type vocabulary shared between the harness runtime and its
// check/evaluator surfaces. This is the narrow contract layer — the
// type language every harness leg is written against:
//
//   - `EvalIssue` — the single issue shape everything produces.
//   - `EvalTier` / `EvalOutcome` / `EvalCategory` — the issue's axes.
//   - `Priority` — P0/P1/P2 ranking referenced by the retry formatter.
//   - `EvalResult` — aggregate shape a runner returns.
//   - `QualityMode` / `QualityConfig` / `DEFAULT_QUALITY_CONFIG` —
//      the quality-mode knob the adapter surface consumes.
//   - `priorityForIssue` / `isBlocked` / `getActionableIssues` — the
//      purely-typed helpers over the vocabulary.
//
// `EvalIssue` is referenced by `PatchFn`, `TierCheck`, `LLMEvaluator`,
// and `RuntimeRenderCheck` in the harness types hub.

// ─── Priority ──────────────────────────────────────────────────────────────
// P0 = must (compile + complete), P1 = should (safety), P2 = nice (quality).
// Single source of truth for the retry-formatter ranking.

export type Priority = "P0" | "P1" | "P2";

import type { GenerationRuntimeProbeStatus } from "@ggui-ai/mcp-server-core";
import type { CanvasClass, DesignMode } from "../design-mode.js";

// ─── Issue shape ───────────────────────────────────────────────────────────

export type EvalTier = 0 | 1 | 2;
export type EvalOutcome = "fail" | "warn" | "pass";

export type EvalCategory =
  | "compile"
  | "security"
  | "contract"
  | "types"
  | "imports"
  | "tokens" // tier 0
  | "mode" // tier 0 — per-mode deterministic
  | "functionality"
  | "crash" // tier 1
  | "interactivity"
  | "accessibility"
  | "layout"
  | "loading"
  | "visual"; // tier 2

export interface EvalIssue {
  tier: EvalTier;
  result: EvalOutcome;
  category: EvalCategory;
  /**
   * Priority tier — threaded through to the retry formatter so the LLM can
   * rank its next patch against the prompt's P0/P1/P2 priority schema.
   * Derived from (category, result) via {@link priorityForIssue} when not
   * explicitly set. Optional on construction; check-runners typically
   * populate it before returning.
   */
  priority?: Priority;
  subcategory?: string;
  severity?: "critical" | "major";
  description: string;
  fix: string;
  line?: number;
}

/**
 * Runtime-render probe execution status — four-valued so "the probe
 * never ran" is never conflated with "the probe ran clean". ONE union: the
 * same values a generation's metadata reports (`GenerationRuntimeProbeStatus`
 * in `@ggui-ai/mcp-server-core`), declared there and named here.
 *
 *   - `ran`           — probe executed; its findings (possibly none) are
 *                       in the issue stream under `runtime:*` subcategories.
 *   - `infra-skipped` — probe could NOT execute (environment failure:
 *                       happy-dom load, user-event document capture,
 *                       ESM/CJS interop). Carries ZERO probe evidence;
 *                       consumers MUST NOT count it as a pass.
 *   - `not-applicable`— nothing to probe (no compiled code, no contract
 *                       surface, or no runtimeRender check configured).
 *   - `timed-out`     — probe started but did not finish inside its
 *                       wall-clock bound (ggui#1299). Carries ZERO
 *                       evidence about the component: on a contended
 *                       host an ordinary component crosses the bound.
 *                       Consumers MUST NOT count it as a pass, and MUST
 *                       NOT count it as a crash either. `elapsedMs` and
 *                       `hostLoad` say how long it ran and how busy the
 *                       host was, so a reader can tell the two cases apart.
 */
export type RuntimeProbeStatus = GenerationRuntimeProbeStatus;

/**
 * The host's 1-minute load average at a probe's start and end, beside the
 * number of CPUs the process can use (ggui#1299). A load well above
 * `cores` means the probe competed for CPU; a wall-clock bound crossed
 * there says more about the host than about the component.
 */
export interface ProbeHostLoad {
  readonly start: number;
  readonly end: number;
  readonly cores: number;
}

/**
 * Probe execution meta stamped onto an `EvalResult` at the exit-decision
 * points that invoke the probe. Absence of this field means the eval
 * path never reached a probe invocation at all — consumers treat that
 * the same as not-run, never as a pass.
 */
export interface RuntimeProbeMeta {
  readonly status: RuntimeProbeStatus;
  /** Populated for `infra-skipped` / `not-applicable` / `timed-out` — why the probe didn't finish. */
  readonly reason?: string;
  /**
   * How long the probe took, wall-clock, as measured around the check by the
   * side that invoked it — on every status that reached the check (`ran`,
   * `timed-out`, `infra-skipped`). Absent on `not-applicable`: nothing ran.
   */
  readonly elapsedMs?: number;
  /** `ran` only: the check's own render time, inside `elapsedMs`. */
  readonly renderMs?: number;
  /** Host load around the probe, when it ran isolated (absent for an in-process probe). */
  readonly hostLoad?: ProbeHostLoad;
}

/**
 * The one repair turn a probe-only round buys (ggui#1380). A serving
 * deployment that wires the runtime probe and configures no evaluator runs
 * the probe once after the coding turns; a recoverable render crash buys
 * exactly one repair turn, then one re-probe. This records what came of it:
 *   - `compiled: false` — the repair turn's code did not pass self-check, so
 *     no re-probe ran and the pre-repair card is the one served;
 *   - `afterStatus` — the re-probe ran (the repair compiled) and this is its
 *     status; `recoverableFailAfter` says whether the crash class the turn
 *     was bought for is still there.
 */
export type RuntimeProbeRepair =
  | { readonly attempted: true; readonly compiled: false }
  | { readonly attempted: true; readonly afterStatus: RuntimeProbeStatus; readonly recoverableFailAfter: boolean };

/**
 * Per-criterion execution status — three-valued so "the criterion
 * silently produced no verdict" is never conflated with "the criterion
 * ran clean", and neither is conflated with "not evaluated by design".
 * Same doctrine and vocabulary family as `RuntimeProbeStatus` above.
 *
 *   - `ran`            — the LLM call completed and returned a verdict
 *                        for this criterion; its findings (possibly
 *                        none) are in `issues`.
 *   - `skipped`        — the call errored or returned no tool call. The
 *                        criterion carries ZERO evidence; the evaluator
 *                        fail-opens it into `pass` to avoid blocking
 *                        generation on flaky LLM calls, so consumers
 *                        MUST consult this field before treating `pass`
 *                        membership as a verdict. Counts AGAINST
 *                        coverage.
 *   - `not-applicable` — the evaluator was bypassed by design for this
 *                        cell (e.g. the same-image low-risk bypass:
 *                        axis checks clean, tier-1/2 never invoked).
 *                        `reason` names the bypass. Excluded from
 *                        coverage denominators — it is neither evidence
 *                        nor a silent absence.
 */
export type CriterionRunStatus = "ran" | "skipped" | "not-applicable";

/** Coverage row for one evaluation criterion of one eval run. */
export interface CriterionCoverage {
  readonly criterion: string;
  readonly tier: 1 | 2;
  readonly status: CriterionRunStatus;
  /** Populated for `skipped` / `not-applicable` — why no verdict. */
  readonly reason?: string;
}

/**
 * Coverage of the screenshot JUDGE leg for one eval round (ggui#1221) — a
 * different surface from the `visual` CRITERION in `criteriaCoverage` (the
 * LLM evaluator's read of the source). `ran` = a frame was captured and
 * judged; `skipped` = the leg was configured but produced no verdict
 * (no browser, a launch or in-page failure, an unbundlable component, an
 * unparsable judge answer) with `reason` naming why; `not-applicable` =
 * the round had no visual leg configured. Before this row a skipped leg
 * left NO trace on the result — `{ issues: [] }` read exactly like a
 * clean run, and every bootstrap mint on a browserless runtime "passed"
 * its visual round that way.
 */
export interface VisualCoverage {
  readonly status: CriterionRunStatus;
  /** Populated for `skipped` / `not-applicable` — why no verdict. */
  readonly reason?: string;
}

/**
 * The static criteria `runLLMEvaluation` runs, in stamp order — the
 * ONE list both the evaluator's coverage stamp and the harness's
 * bypass stamp derive from, so the two can never disagree on the set.
 * Tier 1 = binary pass/fail gates; tier 2 = fail/warn/pass quality.
 */
export const LLM_EVAL_STATIC_CRITERIA: ReadonlyArray<{ readonly criterion: string; readonly tier: 1 | 2 }> = [
  { criterion: "functionality", tier: 1 },
  { criterion: "crash", tier: 1 },
  { criterion: "interactivity", tier: 2 },
  { criterion: "accessibility", tier: 2 },
  { criterion: "layout", tier: 2 },
  { criterion: "loading", tier: 2 },
  { criterion: "visual", tier: 2 },
];

/**
 * Coverage rows for a cell where the evaluator was BYPASSED BY DESIGN
 * (never invoked) — one `not-applicable` row per static criterion, all
 * carrying `reason`. Harness exits that skip tier-1/2 evaluation stamp
 * this so the cell is neither a silent absence (field missing) nor
 * evidence. Same shape contract as `runLLMEvaluation`'s stamp: always
 * every criterion. Lives here (not in llm-evaluator) because the bypass
 * exit runs before the evaluator module is lazily loaded.
 */
export function notApplicableCoverage(reason: string): CriterionCoverage[] {
  return LLM_EVAL_STATIC_CRITERIA.map(({ criterion, tier }) => ({
    criterion,
    tier,
    status: "not-applicable",
    reason,
  }));
}

/** One contract-feedback round (ggui#1261): what bought it, and the source it was fed back on. */
export interface ContractFeedbackRecord {
  /** The exit-probe issue subcategories that bought the round, e.g. `runtime:prop-sensitivity:currentUser`. */
  readonly firedOn: readonly string[];
  /** The component source as it stood when the model was told — the round's BEFORE. */
  readonly sourceBefore: string;
}

export interface EvalResult {
  issues: EvalIssue[];
  pass: string[];
  /**
   * Per-criterion coverage for this eval run — one row per static
   * criterion, ALWAYS all of them when present. Stamped by
   * `runLLMEvaluation` (`ran` / `skipped`) and by the harness on
   * evaluator-bypass exits (`not-applicable` + reason). The harness
   * carries it unchanged through every later re-stamp of this result.
   * Absent = coverage UNKNOWN (paths that predate the instrument, e.g.
   * `parseEvalResponse` replays) — never assume `ran`, never assume
   * bypass.
   */
  criteriaCoverage?: CriterionCoverage[];
  /**
   * Runtime-render probe execution meta. Stamped by the exit-decision
   * probe runner; absent on eval paths that never invoke the probe.
   */
  runtimeProbe?: RuntimeProbeMeta;
  /**
   * The probe-only round's repair record (ggui#1380) — present only when a
   * recoverable render crash bought the one repair turn. See
   * {@link RuntimeProbeRepair}. `runtimeProbe` beside it is the re-probe's
   * verdict when the repair compiled, else the pre-repair probe's.
   */
  runtimeProbeRepair?: RuntimeProbeRepair;
  /**
   * The contract-feedback round, when one fired this generation (ggui#1261):
   * which exit-probe findings bought it and the source as it stood when the
   * model was told. `runtimeProbe` and the `runtime:*` issues on this result
   * are the probe's verdict AFTER that round; `sourceBefore` beside the final
   * source is the round's before/after. Absent when no such round fired.
   */
  contractFeedback?: ContractFeedbackRecord;
  /**
   * Per-canvas visual verdicts. Stamped by the harness ONLY when the
   * visual leg ran with `visualEvaluation.canvases` set (arm-neutral —
   * the same judge in every design mode); absent on the single-shot
   * visual path and whenever the visual leg did not run. PNGs stay on
   * `runVisualEvaluation`'s own result (`VisualEvaluationResult.canvases[*].screenshotPng`),
   * never here — this object is serialized into reports.
   */
  visual?: VisualEvalSummary;
  /**
   * Whether the screenshot judge leg ran, was skipped (with the reason) or
   * was not configured — ALWAYS stamped by the harness's eval round
   * (ggui#1221), so a consumer can tell a clean visual run from a leg
   * that silently could not run. See {@link VisualCoverage}.
   */
  visualCoverage?: VisualCoverage;
}

/** One canvas's visual verdict, PNG-free — see `EvalResult.visual`. */
/**
 * How one canvas's `score` was reached (ggui#1072): `k` vision calls on the
 * SAME captured frame, aggregated by `rule`. Always present — `k: 1` ⇒
 * `samples: [score]`, `sigma: 0`, `notes: [critique]` — so one shape serves
 * a single judgement and a median of many. `samples`/`notes` carry only the
 * calls the judge could parse (in call order); `k` stays the requested count,
 * so a short `samples` is visible on the row rather than filled in.
 */
export interface CanvasJudgeRecord {
  readonly k: number;
  readonly rule: 'median';
  readonly samples: number[];
  /** Population σ of `samples` (0 when one sample). */
  readonly sigma: number;
  /** The judge's per-canvas critique per sample — the words beside a swing. */
  readonly notes: string[];
}

export interface CanvasVisualSummary {
  canvas: CanvasClass;
  viewport: { width: number; height: number };
  /** The judge's weighted score at this canvas (0-100). */
  score: number;
  /** `score >= passThreshold`, and on the inline card: no overflow (ggui#1027). */
  passed: boolean;
  /** The document's scroll height at this canvas, CSS px; `null` when unmeasurable (ggui#1027). */
  contentHeight: number | null;
  /** `contentHeight > viewport.height` — measured on every canvas, judged per `canvasFitPolicy`. */
  overflow: boolean;
  /** How `score` was reached — always present (ggui#1072). */
  judge: CanvasJudgeRecord;
  /**
   * How the judge composed the mount (ggui#1100): `'fill'` on every
   * fullscreen canvas — the served runtime's fit, the root stretched to
   * the frame; absent on the inline card, which keeps its natural height.
   */
  fit?: 'fill';
}

/**
 * ggui#1195 — the fit reading on the canvas whose policy FAILS an overflow
 * (the inline chat card): the box it was judged at (`ceiling` — the order's
 * declared viewport when one was carried, else the class box), whether that
 * box was declared, and how many px of content sit below it (0 = fits).
 * Present only when such a canvas was judged with a measurable height, so
 * the bar and the ledger read one number for "does the hello fit".
 */
export interface VisualFitStamp {
  readonly canvas: CanvasClass;
  readonly ceiling: { readonly width: number; readonly height: number };
  readonly declared: boolean;
  readonly overflowPx: number;
}

/** The visual leg's per-canvas summary — see `EvalResult.visual`. */
export interface VisualEvalSummary {
  /** Mean of the canvas scores (rounded). */
  score: number;
  /** Every canvas passed. */
  passed: boolean;
  canvases: CanvasVisualSummary[];
  /** ggui#1195 — see {@link VisualFitStamp}; absent when no fail-policy canvas was judged. */
  fit?: VisualFitStamp;
  /** The design tree the judge painted with (ggui#1042): `src` + `srcSha256` — `design@judge`. */
  design?: { readonly src: string; readonly srcSha256: string };
  /** The mode the judge's tokens were composed in, when the caller said (ggui#1076). */
  themeMode?: 'light' | 'dark';
}

// ─── Quality mode ──────────────────────────────────────────────────────────

export type QualityMode = "fast" | "auto-improve" | "high-quality";

export interface QualityConfig {
  quality: QualityMode;
  visualEval: boolean;
  maxCostPerGeneration: number;
  model?: { provider?: string; model?: string };
}

export const DEFAULT_QUALITY_CONFIG: QualityConfig = {
  quality: "fast",
  visualEval: false,
  maxCostPerGeneration: 3,
};

// ─── Axis-check types ──────────────────────────────────────────────────────
// The `AxisCheck` type vocabulary lives here. The check bodies
// themselves (REGISTRY, per-axis implementations) live under
// `./axis-checks/`.

import type { DataContract } from "@ggui-ai/protocol";
import type { AxisVector, Classification } from "../classifier/axes.js";
import type { AxisKey } from "../fragments/index.js";

export interface AxisCheckInput {
  sourceCode: string;
  compiledCode: string | null;
  contract?: DataContract;
  originalPrompt: string;
  /** Full classification — checks may read sibling axes. */
  classification: Classification;
  /**
   * Which triad produced the source. Checks that assert a design-package
   * component (e.g. `layout.multi_step.stepper_adopted`) read it and
   * stand down in `free` mode, where the primitive is optional. Absent
   * means `constrained`.
   */
  designMode?: DesignMode;
  /**
   * The rendering canvas the source is judged FOR (ggui#1117). A width cap on
   * the outermost element is a defect on a fullscreen canvas and a no-op in a
   * chat bubble, so a check that reads width must know the surface. Populated
   * where the harness is built (`Harness.canvas`); ABSENT for callers with no
   * rendering context — a check handles `undefined`, it never assumes a
   * default (a silent `lg` would be the same guess with a nicer face).
   */
  canvas?: CanvasClass;
}

/**
 * A gated check. Runs only when the classification's axis value matches
 * one of the gate's accepted values. Multiple gates (implicit AND) support
 * cross-axis combinations.
 */
export interface AxisCheck {
  /** Stable id used in issue subcategories. */
  id: string;
  /** Primary axis this check gates on. */
  axis: AxisKey;
  /** Which values of that axis activate the check. */
  values: readonly string[];
  /** Optional extra gate on a sibling axis (e.g., only when state=merge AND writes=per-item). */
  and?: { axis: AxisKey; values: readonly string[] };
  /** Execute the check and emit zero or more issues. */
  run(input: AxisCheckInput): EvalIssue[];
}

/**
 * Whether a check's gate(s) match the given axis vector. Pure function,
 * no issue emission.
 */
export function matches(vector: AxisVector, check: AxisCheck): boolean {
  const primary = vector[check.axis] as string;
  if (!check.values.includes(primary)) return false;
  if (check.and) {
    const sibling = vector[check.and.axis] as string;
    if (!check.and.values.includes(sibling)) return false;
  }
  return true;
}

// ─── Purely-typed helpers ──────────────────────────────────────────────────

/**
 * Map a tier-0 issue category to the canonical P0/P1/P2 priority.
 *
 * Sourced from the criteria priority assignments:
 *   - P0 (must): compile, security, imports, contract, types, mode
 *   - P1 (safety): tokens, crash, functionality
 *   - P2 (quality): interactivity, accessibility, layout, loading, visual
 */
export function priorityForIssue(category: EvalCategory): Priority {
  if (
    category === "interactivity" ||
    category === "accessibility" ||
    category === "layout" ||
    category === "loading" ||
    category === "visual"
  ) {
    return "P2";
  }
  if (category === "tokens" || category === "crash" || category === "functionality") {
    return "P1";
  }
  // compile, security, imports, contract, types, mode → P0.
  return "P0";
}

/** Whether any issue blocks shipping (has result = 'fail'). */
export function isBlocked(result: EvalResult): boolean {
  return result.issues.some((i) => i.result === "fail");
}

/**
 * Return the issues the agent should act on, depending on quality mode.
 * - fast: only fails (blocking issues)
 * - auto-improve / high-quality: fails + warns
 */
export function getActionableIssues(result: EvalResult, mode: QualityMode): EvalIssue[] {
  if (mode === "fast") {
    return result.issues.filter((i) => i.result === "fail");
  }
  return result.issues.filter((i) => i.result === "fail" || i.result === "warn");
}

// ─── Criteria (single source of truth for coding + eval sides) ─────────────
//
// Each criterion is defined ONCE with both sides of the contract:
//   - codingGuidance: what the coding agent should DO
//   - evalInstruction: what the eval agent should CHECK
// They must be compatible — changing one means reviewing the other.
//
// This is *validated* shipping content: it's what the hosted runtime sends
// to every generation today. External OSS implementers building their own
// prompts should be able to use the same rubric — hence it's open.

export interface EvalCriterion {
  /** Unique identifier matching the eval tool name (e.g., 'functionality') */
  id: string;
  /** Human-readable name shown to both agents */
  name: string;
  /** Priority tier — P0 must, P1 should, P2 nice */
  priority: Priority;
  /** What the coding agent should DO to satisfy this criterion */
  codingGuidance: string;
  /** What the eval agent should CHECK — the evaluation prompt */
  evalInstruction: string;
  /** Tier 0 = programmatic, Tier 1 = LLM critical, Tier 2 = LLM quality */
  tier: 0 | 1 | 2;
  /** Eval outcome when this criterion fails */
  failOutcome: "fail" | "warn";
}

export const CRITERIA: readonly EvalCriterion[] = [
  // ── P0: Correctness (must satisfy — failure = broken component) ──

  {
    id: "compile",
    name: "Compile & type-check",
    priority: "P0",
    tier: 0,
    failOutcome: "fail",
    codingGuidance:
      "Code must compile. The typed Props and wire hook generics are enforced by the compiler.",
    evalInstruction: "Checked automatically by esbuild + TypeScript. No LLM evaluation needed.",
  },
  {
    id: "render-props",
    name: "Render all Props fields",
    priority: "P0",
    tier: 0,
    failOutcome: "warn",
    codingGuidance: "Render every Props field in JSX. Access via props.fieldName.",
    evalInstruction:
      "Check that every field from interface Props appears as props.fieldName in the function body.",
  },
  {
    id: "wire-hooks",
    name: "Wire all contract hooks",
    priority: "P0",
    tier: 0,
    failOutcome: "warn",
    codingGuidance:
      "Wire every useAction/useStream and every clientCapabilities.gadgets hook (e.g., useGeolocation) to a UI element. `agentCapabilities.tools` is a catalog the AGENT invokes — NOT a component hook surface.",
    evalInstruction:
      "Check that every hook variable from the boilerplate appears in the JSX or an effect.",
  },
  {
    id: "imports",
    name: "Valid imports only",
    priority: "P0",
    tier: 0,
    failOutcome: "fail",
    codingGuidance: "Only import from react, @ggui-ai/design/*, and @ggui-ai/wire.",
    evalInstruction: "Flag any import from a package not in the allowlist.",
  },
  {
    id: "security",
    name: "No eval/fetch/window",
    priority: "P0",
    tier: 0,
    failOutcome: "fail",
    codingGuidance: "Never use eval(), fetch(), or window. Data comes from props and hooks.",
    evalInstruction: "Flag any call to eval(), fetch(), or window access.",
  },

  // ── P1: Safety (should satisfy — failure = crash or bad UX) ──

  {
    id: "functionality",
    name: "All features implemented",
    priority: "P1",
    tier: 1,
    failOutcome: "fail",
    codingGuidance: "Implement ALL features from the request AND the data contract.",
    evalInstruction: `Evaluate FUNCTIONALITY: Does this component implement ALL features from the request AND the data contract?

Check against BOTH sources:
1. Original request — each feature must be coded AND rendered in JSX
2. Data contract (if present) — verify:
   - Props fields are rendered in the UI. EXCEPTION: pure identifier fields (\`id\`, \`*Id\`, keys) that exist only to be echoed back inside an action payload do NOT need to be visibly rendered.
   - ALL useAction hooks are wired to clickable UI elements
   - ALL useStream hooks are consumed — the streamed data must reach the UI. Merging stream events into rendered state (a list, a counter, the displayed records) COUNTS as consuming the stream; it need not be a literal \`.latest\` render.
   - ALL clientCapabilities gadgets are used. \`clientCapabilities.gadgets\` is keyed by npm package: built-in browser capabilities (useGeolocation / useCamera / …) import from @ggui-ai/gadgets; registered third-party gadgets (e.g. useChartTheme) import from their OWN package. Any gadget the contract declares IS a contract feature — NEVER flag it as "not part of the contract".
   - \`agentCapabilities.tools\` is a catalog declaration only; do NOT flag missing component-side calls for it

A contract hook that is declared but never used at all is a MISSING feature.

CRITICAL: The "issues" array must ONLY contain features you are CERTAIN are missing or broken — never an implemented feature. (See "Issue-array discipline" above: no speculative, self-negating, or "verify that…" entries.)`,
  },
  {
    id: "crash",
    name: "No crash scenarios",
    priority: "P1",
    tier: 1,
    failOutcome: "fail",
    codingGuidance:
      "Guard optional props (props.field?.x). stream.latest is T|null — always null-guard. .all is always an array.",
    evalInstruction: `Evaluate CRASH SAFETY: Are there ACTUAL runtime crash scenarios?

WILL crash (include in issues):
- .map()/.filter()/.length on an uninitialized variable
- Accessing property of undefined without guard
- useStream().latest.field WITHOUT null guard — .latest is T | null
- Optional Props field accessed as props.field.x without guard
- Array item optional field: items.map(item => item.priority.toUpperCase()) when priority is optional

SAFE (do NOT include):
- Optional chaining: props.items?.map() — SAFE
- Fallback: items || [] — SAFE
- useState initializer: useState([]) — SAFE
- Null check: items && items.map() — SAFE
- stream.latest && stream.latest.field — SAFE, guarded
- stream.all.map(...) — SAFE, .all is always an array
- stream.all.length — SAFE, always a number

The "issues" array is ONLY for a specific line that WILL throw at runtime. NEVER put a line you have determined is safe into the issues array — not even to note that it is safe ("…so this is safely guarded", "…so there is no crash"). If you cannot name a concrete line that will throw, the answer is {"pass": true} — return that and an empty issues array.`,
  },
  {
    id: "tokens",
    name: "Design system tokens",
    priority: "P1",
    tier: 0,
    failOutcome: "warn",
    codingGuidance:
      "Use CSS variables for colors (var(--ggui-color-*)); use the spacing scale for gap/padding/margin (gap=\"md\", padding=\"lg\").",
    evalInstruction:
      "Flag hardcoded hex colors, rgba/hsl functions, and numeric or raw-CSS-length spacing props. A t-shirt-scale spacing name (gap=\"md\") IS a token — never flag it.",
  },

  // ── P2: Quality (nice to have — failure = lower score, not broken) ──

  {
    id: "interactivity",
    name: "Sufficient interactive elements",
    priority: "P2",
    tier: 2,
    failOutcome: "warn",
    codingGuidance: "Add appropriate interactive elements for the component purpose.",
    evalInstruction: `Evaluate INTERACTIVITY: Does this component have sufficient interactive elements?

Consider: forms need submit buttons, lists need selection, editable content needs save/cancel.
Contract actions (if present): every useAction hook should be triggered by a visible UI element.

Only list MISSING interactive elements. Use 'fail' only for issues blocking core purpose.`,
  },
  {
    id: "accessibility",
    name: "Accessible markup",
    priority: "P2",
    tier: 2,
    failOutcome: "warn",
    codingGuidance:
      "Add labels on form inputs, alt text on images, semantic HTML, and state ARIA (aria-checked/pressed/selected/expanded) on hand-rolled interactive controls.",
    evalInstruction: `Evaluate ACCESSIBILITY: missing labels, alt text, semantic HTML, keyboard support, ARIA state.

ggui primitives bake in their own ARIA — see "Primitive Accessibility" in the Design System context above. NEVER flag a ggui primitive (Input/Select/TextArea, RadioGroup, Checkbox, Toggle, Progress, Slider, Spinner, Skeleton, Tabs, Accordion, Alert, Toast, Tooltip, Clickable, Icon) for a missing role / aria-* / label / keyboard handler — it is already there and not visible in the source you are reading.

Flag ONLY real gaps: a raw div/span used as an interactive control; a hand-rolled control whose checked/selected/expanded/pressed state is conveyed only by styling (strikethrough, color, a check icon) with no \`aria-checked\` / \`aria-pressed\` / \`aria-selected\` / \`aria-expanded\`; an image with no alt text; an Input/Select/TextArea with no \`label\` prop; an icon-only Button with no aria-label; live/streaming data not wrapped in an aria-live region; inverted heading hierarchy.

Only list MISSING accessibility features. Use 'fail' only if it blocks delivery.`,
  },
  {
    id: "layout",
    name: "Clean layout",
    priority: "P2",
    tier: 2,
    failOutcome: "warn",
    codingGuidance: "Use proper spacing and visual grouping.",
    evalInstruction: `Evaluate LAYOUT: Check spacing, alignment, visual grouping, and composition.

Only list ACTUAL layout problems. Use 'fail' only for fundamentally broken layouts.`,
  },
  {
    id: "loading",
    name: "Loading/empty/error states",
    priority: "P2",
    tier: 2,
    failOutcome: "warn",
    codingGuidance: "Handle async data, empty collections, and error cases.",
    evalInstruction: `Evaluate LOADING/EMPTY/ERROR STATES: Does the component handle async data and edge cases?

Contract-specific: useStream should handle pre-data state. clientCapabilities hooks may return undefined / permission-denied — defensive guards expected before threading values into JSX.
Props-only components (no async, no streams, no client capabilities) do NOT need loading states — return pass.

Only list MISSING states.`,
  },
  {
    id: "visual",
    name: "Design system consistency",
    priority: "P2",
    tier: 2,
    failOutcome: "warn",
    codingGuidance: "Use design system tokens consistently.",
    evalInstruction: `Evaluate VISUAL CONSISTENCY: Is the component using the design system correctly?

Flag: hardcoded colors instead of CSS variables, numeric or raw-CSS-length spacing instead of the t-shirt scale, style objects bypassing design system.
A t-shirt-scale spacing name (gap="md", padding="lg") IS correct token usage — never flag it.
Intentional custom colors (status indicators) are acceptable when no semantic token fits.

Only list ACTUAL violations. Use 'fail' only for pervasive violations.`,
  },
] as const;

/**
 * `designMode: 'free'` overrides — ONLY the two criteria whose text
 * encodes the design vocabulary. `tokens` narrows to COLOR (the free arm
 * relaxes spacing / typography / radius / shadow to literals but keeps
 * brand-bearing color on the closed `--ggui-color-*` manifest, no
 * fallbacks); `visual` becomes arm-neutral (composition, hierarchy,
 * consistency, fit to canvas — no reward or penalty for design-system
 * usage). Every other criterion is shared verbatim between the modes.
 * Constraint alignment: what the free prompt says, the free evaluator
 * checks — and nothing more.
 */
const FREE_DESIGN_CRITERIA_OVERRIDES: readonly EvalCriterion[] = [
  {
    id: "tokens",
    name: "Color tokens",
    priority: "P1",
    tier: 0,
    failOutcome: "warn",
    codingGuidance:
      "Every color is a bare var(--ggui-color-*) from the token manifest — no hex, rgb()/hsl(), CSS named colors or literal fallbacks, in style props and <style> blocks alike. Spacing, typography, radius and shadow geometry may be literals.",
    evalInstruction:
      "Flag hardcoded hex colors, rgba/hsl functions, CSS named colors, and literal fallbacks inside var(--ggui-*) references. Do NOT flag literal spacing, font sizes, radii or pixel values — they are allowed in this mode.",
  },
  {
    id: "visual",
    name: "Visual composition",
    priority: "P2",
    tier: 2,
    failOutcome: "warn",
    codingGuidance:
      "Compose deliberately: one clear focal point, consistent spacing rhythm, a coherent theme-token palette, a fit to the rendering canvas.",
    evalInstruction: `Evaluate VISUAL COMPOSITION: Is the component composed deliberately for its canvas?

Judge: visual hierarchy (one clear focal point, headings distinct from body text), consistent spacing rhythm and alignment, a coherent palette drawn from the theme tokens, fit to the canvas (fluid width, no fixed widths, nothing cramped or stretched).
Do NOT reward or penalise the use of design-system primitives — raw HTML with inline CSS is a first-class choice here. Literal spacing / typography / radius values are fine.

Only list ACTUAL composition problems. Use 'fail' only for a fundamentally incoherent composition.`,
  },
];

/**
 * The criteria registry for a design mode. `constrained` IS `CRITERIA`
 * (same array, byte-identical summary); `free` swaps in the two
 * overrides above by id, preserving order.
 */
export function criteriaFor(designMode: DesignMode = "constrained"): readonly EvalCriterion[] {
  if (designMode === "constrained") return CRITERIA;
  return CRITERIA.map(
    (c) => FREE_DESIGN_CRITERIA_OVERRIDES.find((o) => o.id === c.id) ?? c,
  );
}

/** Get all criteria for a specific priority level */
export function getCriteriaByPriority(
  priority: Priority,
  designMode: DesignMode = "constrained",
): EvalCriterion[] {
  return criteriaFor(designMode).filter((c) => c.priority === priority);
}

/** Get a specific criterion by ID */
export function getCriterionById(
  id: string,
  designMode: DesignMode = "constrained",
): EvalCriterion | undefined {
  return criteriaFor(designMode).find((c) => c.id === id);
}

/** Get all LLM-evaluated criteria (tier 1 + 2) */
export function getLLMCriteria(designMode: DesignMode = "constrained"): EvalCriterion[] {
  return criteriaFor(designMode).filter((c) => c.tier > 0);
}

/**
 * Build the coding agent's criteria summary from the single source of truth.
 * Grouped by priority for the P0→P1→P2 hierarchy.
 */
export function buildCodingCriteriaSummary(designMode: DesignMode = "constrained"): string {
  const lines: string[] = ["## Priority (P0 first, then P1, then P2)", ""];

  for (const priority of ["P0", "P1", "P2"] as Priority[]) {
    const label =
      priority === "P0"
        ? "Must (compile + complete)"
        : priority === "P1"
          ? "Should (safety)"
          : "Nice (quality)";
    const criteria = getCriteriaByPriority(priority, designMode);
    lines.push(`**${priority} — ${label}:**`);
    for (const c of criteria) {
      lines.push(`- ${c.codingGuidance}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
