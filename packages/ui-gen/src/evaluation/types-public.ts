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

export interface EvalResult {
  issues: EvalIssue[];
  pass: string[];
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
    codingGuidance: "Add labels on form inputs, alt text on images, semantic HTML.",
    evalInstruction: `Evaluate ACCESSIBILITY: missing labels, alt text, semantic HTML, keyboard support.

ggui primitives bake in their own ARIA — see "Primitive Accessibility" in the Design System context above. NEVER flag a ggui primitive (Input/Select/TextArea, RadioGroup, Checkbox, Toggle, Progress, Slider, Spinner, Skeleton, Tabs, Accordion, Alert, Toast, Tooltip, Clickable, Icon) for a missing role / aria-* / label / keyboard handler — it is already there and not visible in the source you are reading.

Flag ONLY real gaps: a raw div/span used as an interactive control; an image with no alt text; an Input/Select/TextArea with no \`label\` prop; an icon-only Button with no aria-label; live/streaming data not wrapped in an aria-live region; inverted heading hierarchy.

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

/** Get all criteria for a specific priority level */
export function getCriteriaByPriority(priority: Priority): EvalCriterion[] {
  return CRITERIA.filter((c) => c.priority === priority);
}

/** Get a specific criterion by ID */
export function getCriterionById(id: string): EvalCriterion | undefined {
  return CRITERIA.find((c) => c.id === id);
}

/** Get all LLM-evaluated criteria (tier 1 + 2) */
export function getLLMCriteria(): EvalCriterion[] {
  return CRITERIA.filter((c) => c.tier > 0);
}

/**
 * Build the coding agent's criteria summary from the single source of truth.
 * Grouped by priority for the P0→P1→P2 hierarchy.
 */
export function buildCodingCriteriaSummary(): string {
  const lines: string[] = ["## Priority (P0 first, then P1, then P2)", ""];

  for (const priority of ["P0", "P1", "P2"] as Priority[]) {
    const label =
      priority === "P0"
        ? "Must (compile + complete)"
        : priority === "P1"
          ? "Should (safety)"
          : "Nice (quality)";
    const criteria = getCriteriaByPriority(priority);
    lines.push(`**${priority} — ${label}:**`);
    for (const c of criteria) {
      lines.push(`- ${c.codingGuidance}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
