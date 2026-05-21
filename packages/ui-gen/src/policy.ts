// packages/ui-gen/src/policy.ts
//
// Harness policy — validated defaults + identity resolvers.
//
// What lives here is the CONTRACT layer + the SHIPPING DEFAULTS:
//   - Type vocabulary every harness is built against
//     (ContextPolicy, HarnessPolicy, RuntimeCtx, ResolvedRunPolicy,
//      ProcessMode).
//   - The default values that reflect the current best-known harness
//     (DEFAULT_CONTEXT_POLICY, DEFAULT_HARNESS_POLICY), updated as new
//     configurations ship as new defaults.
//   - The structural-equality check `isDefaultHarnessPolicy`, used by
//     createHarness to decide whether policy participates in the
//     harness id (a harness running the vanilla default policy gets a
//     byte-identical id regardless of how the policy was constructed).
//   - The default `resolveHarnessPolicy(classification)` (returns
//     `DEFAULT_HARNESS_POLICY` for every classification — no ENV
//     profile branches here).
//   - The identity `resolveRunPolicy(harness, runtimeCtx)` (returns
//     `harness.policy` unchanged — no per-model registry lookup here).
//
// What does NOT live here (it lives in `./harness/policy.ts`, the
// experiment layer that wraps this module):
//   - `GGUI_POLICY_PROFILE` environment-variable reading.
//   - The named experimental profile branches
//     (narrow-merge-v1, hashline-v2, tool-driven-primitives-*,
//      primitives-ts-format, tsformat-plan-impl, numberline-flat,
//      legacy-code-array, hashline-v2-flat).
//   - `resolveRunPolicyForProfile`.
//   - The per-model `MODEL_HARNESS_REGISTRY` consultation in
//     `resolveRunPolicy`.
// Those are experiment plumbing — a new arm lives in the wrapper layer
// until it is validated, then graduates into the defaults here.

import type { Classification } from "./classifier/axes.js";

// ─── Execution topology ────────────────────────────────────────────────────

/**
 * Coarse execution-topology label attached to `ProcessLeg`. The workflow
 * DAG itself is the source of truth; this is a label on it, used by filters
 * and by `HarnessPolicy.processMode` to override the default `"single_pass"`.
 */
export type ProcessMode = "single_pass" | "staged" | "staged-concurrent";

// ─── ContextPolicy ─────────────────────────────────────────────────────────

/**
 * Context-leg policy. Controls the SHAPE of feedback the LLM sees on retry /
 * patch surfaces, the format of the primitives reference, and the tool-grammar
 * schema of `apply_changes`. Does NOT change what errors get caught or how
 * the code executes — only how errors get rendered back to the LLM and how
 * the primitive documentation is staged on turn 1.
 *
 * Every field is documented against the experiment that justified it. The
 * defaults in `DEFAULT_CONTEXT_POLICY` reflect the current best-known
 * harness; changing a default here is a semver-major-level event for
 * a hosted closed runtime (which shifts every benchmark cell) and
 * deserves its own commit with bench evidence.
 */
export interface ContextPolicy {
  /**
   * Prefix the preflight `PATCH_INVALID` retry message with `[P0-compile]`
   * so the LLM can rank it against the prompt's P0/P1/P2 priority schema.
   * Default `false`.
   */
  readonly labeledPreflight: boolean;
  /**
   * Reserved for future plumbing. When true, would prefix tier-0 self-check
   * retry violations with `[P0-*]` / `[P1-*]` priority tags. Default false.
   */
  readonly labeledTier0: boolean;
  /**
   * When true, the coding loop detects duplicate patch/error-class
   * fingerprints across consecutive patch turns and, on match, runs the
   * action chosen by {@link dupeBreakAction}. Default false.
   */
  readonly breakDuplicatePatch: boolean;
  /**
   * When `breakDuplicatePatch` fires, choose the intervention. Default
   * `"escape"` for back-compat with the dormant scoped-escape plumbing —
   * has no effect unless `breakDuplicatePatch` is also true.
   */
  readonly dupeBreakAction?: "escape" | "diagnostic" | "diagnostic-noforce";
  /**
   * Axis-keyed primitives doc slice. When `"axis-keyed"`, the first-turn
   * system prompt injects only the allowlisted primitives derived from
   * the classification, shrinking the ~130 KB monolith to ~30–50 KB.
   * Default `"full"`.
   */
  readonly primitiveDocSlice?: "full" | "axis-keyed";
  /**
   * Primitives to exclude from the axis-keyed slice. Only meaningful
   * when `primitiveDocSlice === "axis-keyed"`.
   */
  readonly primitiveDocExcludes?: readonly string[];
  /**
   * Hashline view format on `## Current File` + hash-verified
   * apply_changes line refs. Default `"off"`.
   */
  readonly hashline?: "off" | "v2";
  /**
   * Tool-driven primitive docs. When `"names-only"` or `"with-props"`,
   * the ~130 KB primitives doc is replaced with a compact ~7–9 KB index
   * and `get_components_info` is advertised alongside the authoring tool.
   * Default `"off"`.
   */
  readonly primitiveIndex?: "off" | "names-only" | "with-props";
  /**
   * Force turn 1 to advertise ONLY `get_components_info`. Requires
   * `primitiveIndex !== "off"`. Default `false`.
   */
  readonly primitiveIndexForceFetch?: boolean;
  /**
   * Force turn 2 to advertise ONLY `write_plan`. Requires
   * `primitiveIndex !== "off"` and typically `primitiveIndexForceFetch`.
   * Default `false`.
   */
  readonly primitiveIndexPlanTurn?: boolean;
  /**
   * Format of the primitive component reference. `"markdown"` = verbose
   * markdown tables (~128 KB); `"ts"` = compact TS-interface format
   * (~59 KB, same enum coverage). The TS format is the shipped default.
   */
  readonly primitiveDocFormat?: "markdown" | "ts";
  /**
   * Force turn 1 to advertise ONLY `write_plan`. Orthogonal to
   * `primitiveIndex`. Default `false`.
   */
  readonly planFirstTurn?: boolean;
  /**
   * apply_changes `code` field schema. `"array"` = `string[]` (one line
   * per element); `"flat"` = single string with `\n` separators (3 JSON
   * nesting levels instead of 4). The flat format is the shipped
   * default.
   */
  readonly codeFormat?: "array" | "flat";
}

// ─── HarnessPolicy + runtime context ───────────────────────────────────────

/**
 * Top-level policy attached to a harness. v1 defines only the context
 * sub-policy + an optional process-mode override. More sub-policies
 * (eval, retry, process-specific) will land when they have a first real
 * field with clean semantics.
 */
export interface HarnessPolicy {
  readonly context: ContextPolicy;
  /**
   * Process-leg mode override. When set, `createHarness` uses this value
   * instead of the default `"single_pass"`. Null/undefined → default.
   */
  readonly processMode?: ProcessMode;
}

/**
 * Runtime context visible at dispatch time. v1 carries `provider` +
 * optional `modelId`. Future fields (observed axis values, capability
 * flags) may appear as warranted.
 */
export interface RuntimeCtx {
  readonly provider: "anthropic" | "openai" | "google" | "openrouter";
  /**
   * Model id as passed to the provider SDK. Optional — when absent,
   * runtime policy resolution falls through to provider-level and
   * default resolution only.
   */
  readonly modelId?: string;
}

/**
 * Runtime-resolved policy. Identical shape to {@link HarnessPolicy} for
 * v1 — the default {@link resolveRunPolicy} is an identity. The separate
 * type exists as a parking spot for future provider-aware overrides so
 * callers can start typing `ResolvedRunPolicy` today and get new fields
 * automatically when they land.
 */
export type ResolvedRunPolicy = HarnessPolicy;

// ─── Defaults ──────────────────────────────────────────────────────────────

/** Validated shipping defaults for the generation harness. */
export const DEFAULT_CONTEXT_POLICY: ContextPolicy = Object.freeze({
  labeledPreflight: false,
  labeledTier0: false,
  breakDuplicatePatch: false,
  dupeBreakAction: "escape",
  primitiveDocSlice: "full",
  hashline: "off",
  primitiveIndex: "off",
  primitiveIndexForceFetch: false,
  primitiveIndexPlanTurn: false,
  // A processed TypeScript-interface format for the primitive docs,
  // chosen over verbose markdown tables: roughly half the size with no
  // loss of enum-value information.
  primitiveDocFormat: "ts",
  planFirstTurn: false,
  // A flat `code: string` patch payload instead of `code: string[]`.
  // The shallower JSON nesting is more reliably decoded by tool-calling
  // models.
  codeFormat: "flat",
});

export const DEFAULT_HARNESS_POLICY: HarnessPolicy = Object.freeze({
  context: DEFAULT_CONTEXT_POLICY,
});

// ─── Resolvers (defaults + identity) ───────────────────────────────────────

/**
 * Default harness-policy resolver — v1 returns `DEFAULT_HARNESS_POLICY`
 * for every classification. A hosted closed runtime can overlay its own
 * funnel profile-branching wrapper around this; OSS consumers get this
 * single default path and can wrap it themselves if they need
 * classification-aware overrides.
 *
 * Preserves reference equality: every call on every classification
 * returns the same frozen singleton object, so callers can use
 * `resolved === DEFAULT_HARNESS_POLICY` to detect the vanilla path
 * (used by `createHarness` via `isDefaultHarnessPolicy` to keep
 * `harness.id` byte-identical on the default path).
 */
export function resolveHarnessPolicy(_classification: Classification): HarnessPolicy {
  return DEFAULT_HARNESS_POLICY;
}

/**
 * Identity run-time resolver — returns `harness.policy` unchanged for
 * any runtime context. A hosted closed runtime can overlay a per-model
 * registry lookup on top (graduating bench-validated overrides per
 * model id); OSS consumers get the identity, preserving reference
 * equality so `resolved === harness.policy` detects "no override
 * applied."
 */
export function resolveRunPolicy(
  harness: { readonly policy: HarnessPolicy },
  _runtimeCtx: RuntimeCtx,
): ResolvedRunPolicy {
  return harness.policy;
}

// ─── Structural-equality check ─────────────────────────────────────────────

/**
 * Structural equality against `DEFAULT_HARNESS_POLICY`. Used by
 * `createHarness` to skip hashing the policy for the vanilla case —
 * keeps `harness.id` byte-identical for every harness running the
 * default policy.
 *
 * Checks each field explicitly (including the unset-means-default
 * shorthand) instead of `policy === DEFAULT_HARNESS_POLICY` so callers
 * can pass a structurally-equivalent object they built themselves.
 */
export function isDefaultHarnessPolicy(policy: HarnessPolicy): boolean {
  return (
    policy.context.labeledPreflight === DEFAULT_CONTEXT_POLICY.labeledPreflight &&
    policy.context.labeledTier0 === DEFAULT_CONTEXT_POLICY.labeledTier0 &&
    policy.context.breakDuplicatePatch === DEFAULT_CONTEXT_POLICY.breakDuplicatePatch &&
    (policy.context.dupeBreakAction ?? "escape") ===
      (DEFAULT_CONTEXT_POLICY.dupeBreakAction ?? "escape") &&
    (policy.context.primitiveDocSlice ?? "full") ===
      (DEFAULT_CONTEXT_POLICY.primitiveDocSlice ?? "full") &&
    (policy.context.primitiveDocExcludes?.length ?? 0) === 0 &&
    (policy.context.hashline ?? "off") === (DEFAULT_CONTEXT_POLICY.hashline ?? "off") &&
    (policy.context.primitiveIndex ?? "off") ===
      (DEFAULT_CONTEXT_POLICY.primitiveIndex ?? "off") &&
    (policy.context.primitiveIndexForceFetch ?? false) ===
      (DEFAULT_CONTEXT_POLICY.primitiveIndexForceFetch ?? false) &&
    (policy.context.primitiveIndexPlanTurn ?? false) ===
      (DEFAULT_CONTEXT_POLICY.primitiveIndexPlanTurn ?? false) &&
    (policy.context.primitiveDocFormat ?? "markdown") ===
      (DEFAULT_CONTEXT_POLICY.primitiveDocFormat ?? "markdown") &&
    (policy.context.planFirstTurn ?? false) ===
      (DEFAULT_CONTEXT_POLICY.planFirstTurn ?? false) &&
    (policy.context.codeFormat ?? "array") ===
      (DEFAULT_CONTEXT_POLICY.codeFormat ?? "array") &&
    policy.processMode === undefined
  );
}
