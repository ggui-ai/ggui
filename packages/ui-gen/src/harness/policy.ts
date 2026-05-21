// Experiment layer over the base policy module (`../policy.ts`).
//
// This file adds opt-in experimental policy on top of the validated
// shipping defaults. It is where new ideas are exercised before they
// graduate into the defaults.
//
// Experiment material kept here:
//   - `GGUI_POLICY_PROFILE` environment-variable reading.
//   - Named experimental profile branches (narrow-merge-v1, hashline-v2,
//     tool-driven-primitives-*, primitives-ts-format, tsformat-plan-impl,
//     numberline-flat, legacy-code-array, hashline-v2-flat).
//   - `resolveRunPolicyForProfile`.
//   - `MODEL_HARNESS_REGISTRY` consultation via `resolveModelOverride`.
//
// Validated material in the base policy module (`../policy.ts`):
//   - Type vocabulary (ContextPolicy, HarnessPolicy, RuntimeCtx,
//     ResolvedRunPolicy, ProcessMode).
//   - Shipping defaults (DEFAULT_CONTEXT_POLICY, DEFAULT_HARNESS_POLICY).
//   - `isDefaultHarnessPolicy` structural-equality check.
//   - Default `resolveHarnessPolicy` + identity `resolveRunPolicy`.
//
// A new experimental arm lives here until it is validated; once proven,
// the field moves into the base module's DEFAULT_CONTEXT_POLICY and the
// arm's profile branch is removed.

import type { Classification } from "../classifier/index.js";
import {
  DEFAULT_CONTEXT_POLICY,
  DEFAULT_HARNESS_POLICY,
  resolveHarnessPolicy as resolveDefaultHarnessPolicy,
  resolveRunPolicy as resolveIdentityRunPolicy,
  type ContextPolicy,
  type HarnessPolicy,
  type ResolvedRunPolicy,
  type RuntimeCtx,
} from "../policy.js";
import { resolveModelOverride } from "./model-registry.js";

// Re-export the base contract surface so importers
// (`create-harness.ts`, `coding/init-session.ts`, `model-registry.ts`,
// tests) can reach it through this module.
export {
  DEFAULT_CONTEXT_POLICY,
  DEFAULT_HARNESS_POLICY,
  isDefaultHarnessPolicy,
  type ContextPolicy,
  type HarnessPolicy,
  type ResolvedRunPolicy,
  type RuntimeCtx,
} from "../policy.js";

// `Priority` is sourced from the evaluation subpath where it lives.
export type { Priority } from "../evaluation/types-public.js";

// ────────────────────────────────────────────────────────────────────────────
// Funnel: classification-time profile branches
// ────────────────────────────────────────────────────────────────────────────

/**
 * Static resolver — runs at `createHarness` time. Consults
 * `GGUI_POLICY_PROFILE` and dispatches to named experimental profile
 * branches. On no profile match, falls through to the default
 * `resolveHarnessPolicy` from `@ggui-ai/ui-gen/policy` which returns
 * the shipping default singleton.
 *
 * Every profile here is experimental: opt-in via an environment
 * variable, never on by default in production dispatch. When a profile
 * is validated, its fields graduate into `DEFAULT_CONTEXT_POLICY` (in
 * the base policy module) and the branch below is deleted.
 */
export function resolveHarnessPolicy(classification: Classification): HarnessPolicy {
  const profile =
    typeof process !== "undefined" ? process.env?.GGUI_POLICY_PROFILE : undefined;

  // `narrow-merge-v1`: drop near-synonym layout primitives (Row, Box,
  // Spacer) from the axis-keyed slice on state=merge fixtures, to
  // reduce JSX tag-mismatch patch failures.
  if (profile === "narrow-merge-v1" && classification.vector.state === "merge") {
    return {
      ...DEFAULT_HARNESS_POLICY,
      context: {
        ...DEFAULT_CONTEXT_POLICY,
        primitiveDocSlice: "axis-keyed",
        primitiveDocExcludes: ["Row", "Box", "Spacer"],
      },
    };
  }

  // `hashline-v2`: N:hh line refs with content-hash verification on
  // apply_changes.
  if (profile === "hashline-v2") {
    return {
      ...DEFAULT_HARNESS_POLICY,
      context: {
        ...DEFAULT_CONTEXT_POLICY,
        hashline: "v2",
      },
    };
  }

  // Tool-driven primitive docs. Two sub-profiles for A/B comparison.
  if (profile === "tool-driven-primitives-names") {
    return {
      ...DEFAULT_HARNESS_POLICY,
      context: {
        ...DEFAULT_CONTEXT_POLICY,
        primitiveIndex: "names-only",
      },
    };
  }
  if (profile === "tool-driven-primitives-props") {
    return {
      ...DEFAULT_HARNESS_POLICY,
      context: {
        ...DEFAULT_CONTEXT_POLICY,
        primitiveIndex: "with-props",
      },
    };
  }
  // Props index + force turn 1 to fetch-only.
  if (profile === "tool-driven-primitives-force-fetch") {
    return {
      ...DEFAULT_HARNESS_POLICY,
      context: {
        ...DEFAULT_CONTEXT_POLICY,
        primitiveIndex: "with-props",
        primitiveIndexForceFetch: true,
      },
    };
  }
  // fetch → plan → write pipeline.
  if (profile === "tool-driven-primitives-fetch-plan") {
    return {
      ...DEFAULT_HARNESS_POLICY,
      context: {
        ...DEFAULT_CONTEXT_POLICY,
        primitiveIndex: "with-props",
        primitiveIndexForceFetch: true,
        primitiveIndexPlanTurn: true,
      },
    };
  }
  // TS-interface format. Full doc retained, compacted ~128 KB → ~59 KB.
  // This is the shipped default; the profile remains for A/B regression
  // investigation.
  if (profile === "primitives-ts-format") {
    return {
      ...DEFAULT_HARNESS_POLICY,
      context: {
        ...DEFAULT_CONTEXT_POLICY,
        primitiveDocFormat: "ts",
      },
    };
  }
  // TS-format + plan→impl pipeline.
  if (profile === "tsformat-plan-impl") {
    return {
      ...DEFAULT_HARNESS_POLICY,
      context: {
        ...DEFAULT_CONTEXT_POLICY,
        primitiveDocFormat: "ts",
        planFirstTurn: true,
      },
    };
  }
  // Flat `code: string` is the shipped default. `numberline-flat` is
  // kept as an explicit opt-in for A/B benchmarks; `legacy-code-array`
  // reverts to the `string[]` schema for regression investigation.
  if (profile === "numberline-flat") {
    return {
      ...DEFAULT_HARNESS_POLICY,
      context: { ...DEFAULT_CONTEXT_POLICY, codeFormat: "flat" },
    };
  }
  if (profile === "legacy-code-array") {
    return {
      ...DEFAULT_HARNESS_POLICY,
      context: { ...DEFAULT_CONTEXT_POLICY, codeFormat: "array" },
    };
  }
  if (profile === "hashline-v2-flat") {
    return {
      ...DEFAULT_HARNESS_POLICY,
      context: {
        ...DEFAULT_CONTEXT_POLICY,
        hashline: "v2",
        codeFormat: "flat",
      },
    };
  }

  return resolveDefaultHarnessPolicy(classification);
}

// ────────────────────────────────────────────────────────────────────────────
// Run-time model-registry overlay
// ────────────────────────────────────────────────────────────────────────────

/**
 * Runtime resolver — runs at dispatch time. Layers the per-model
 * `MODEL_HARNESS_REGISTRY` override on top of the identity
 * `resolveRunPolicy` from `@ggui-ai/ui-gen/policy`. When the registry
 * has no entry for the runtime's `modelId`, returns `harness.policy`
 * unchanged (reference-equal — see the identity in the base module).
 *
 * The registry is empty at launch; entries graduate through a scheduled
 * bench that runs the current corpus against each known model ×
 * candidate override. See `model-registry.ts`.
 */
export function resolveRunPolicy(
  harness: { readonly policy: HarnessPolicy },
  runtimeCtx: RuntimeCtx,
): ResolvedRunPolicy {
  const base = resolveIdentityRunPolicy(harness, runtimeCtx);
  const override: Partial<ContextPolicy> | undefined = resolveModelOverride(
    runtimeCtx.modelId,
  );
  if (!override) return base;
  return {
    ...base,
    context: { ...base.context, ...override },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Funnel: profile-gated runtime resolver
// ────────────────────────────────────────────────────────────────────────────
//
// Profiles let us bench provider-aware policy overrides without changing
// the default `resolveRunPolicy` semantics. A profile is opt-in: bench
// and tests pass it explicitly; production dispatch never sets one.

/**
 * Resolve the runtime policy for a given experimental profile name.
 * When no profile matches, falls through to the identity
 * `resolveRunPolicy` above.
 */
export function resolveRunPolicyForProfile(
  profile: string | undefined,
  harness: { readonly policy: HarnessPolicy },
  runtimeCtx: RuntimeCtx,
): ResolvedRunPolicy {
  // Active profiles:
  //   ctx-slice-primitives-v1 (#45) — axis-keyed primitives doc slice
  //   in the first-turn system prompt.
  if (profile === "ctx-slice-primitives-v1") {
    return {
      context: {
        ...harness.policy.context,
        primitiveDocSlice: "axis-keyed",
      },
    };
  }

  // Archived experimental profiles:
  //
  //   experiment-40-provider-asymmetric — provider-specific tier-0 labels
  //   break-dup-patch                    — dupe-fp → forced WRITE
  //   break-dup-patch-scoped             — dupe-fp → scoped tool
  //   break-dup-patch-diagnostic         — focused excerpt + DIAG
  //   break-dup-patch-diagnostic-noforce — same, no coercion
  //
  // ─── DUPE-BREAK FAMILY: RETIRED ───
  // Systematic ablations of the dupe-break family did not pass the
  // quality gates on high-risk generations. The detector, diagnostic
  // plumbing, and outcome counters remain as dormant infrastructure,
  // reusable when a different architectural attack surface is on the
  // table.
  return resolveRunPolicy(harness, runtimeCtx);
}
