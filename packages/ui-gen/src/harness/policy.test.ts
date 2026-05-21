// R3 C1 scaffolding tests — types + default resolvers + the Codex guardrail
// that default policy doesn't churn harness identity.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_POLICY,
  DEFAULT_HARNESS_POLICY,
  isDefaultHarnessPolicy,
  resolveHarnessPolicy,
  resolveRunPolicy,
  resolveRunPolicyForProfile,
} from "./policy";
import { createHarness } from "./index.js";
import { classifyAxes } from "../classifier/index.js";
import type { Classification } from "../classifier/index.js";

function fakeClassification(): Classification {
  return classifyAxes({ contract: {}, prompt: "render a weather card" });
}

describe("policy defaults", () => {
  it("DEFAULT_CONTEXT_POLICY disables every label flag + dupe-break", () => {
    expect(DEFAULT_CONTEXT_POLICY.labeledPreflight).toBe(false);
    expect(DEFAULT_CONTEXT_POLICY.labeledTier0).toBe(false);
    expect(DEFAULT_CONTEXT_POLICY.breakDuplicatePatch).toBe(false);
  });

  it("DEFAULT_HARNESS_POLICY exposes the default context policy", () => {
    expect(DEFAULT_HARNESS_POLICY.context).toBe(DEFAULT_CONTEXT_POLICY);
  });

  it("defaults are frozen (shared constants can't be mutated downstream)", () => {
    // Freezing prevents accidental sharing bugs — a caller that thinks it's
    // building its own policy can't modify the default in place.
    expect(Object.isFrozen(DEFAULT_CONTEXT_POLICY)).toBe(true);
    expect(Object.isFrozen(DEFAULT_HARNESS_POLICY)).toBe(true);
  });
});

describe("resolveHarnessPolicy", () => {
  it("returns the default policy for any classification (v1 — no gating yet)", () => {
    const p = resolveHarnessPolicy(fakeClassification());
    expect(p).toBe(DEFAULT_HARNESS_POLICY);
  });
});

describe("resolveRunPolicy", () => {
  it("is identity when model id is absent (no registry lookup possible)", () => {
    const harness = createHarness({
      classification: fakeClassification(),
      contract: {} as never,
      prompt: "render a weather card",
    });
    const resolved = resolveRunPolicy(harness, { provider: "anthropic" });
    expect(resolved).toBe(harness.policy);
    const resolvedGoogle = resolveRunPolicy(harness, { provider: "google" });
    expect(resolvedGoogle).toBe(harness.policy);
  });

  it("is identity for unknown model ids (registry fall-through)", () => {
    const harness = createHarness({
      classification: fakeClassification(),
      contract: {} as never,
      prompt: "render a weather card",
    });
    // At launch the registry is empty, so every model id is "unknown"
    // and resolution is byte-identical to the pre-registry behavior.
    const resolved = resolveRunPolicy(harness, {
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
    });
    expect(resolved).toBe(harness.policy);
  });
});

describe("isDefaultHarnessPolicy", () => {
  it("recognizes the default constant", () => {
    expect(isDefaultHarnessPolicy(DEFAULT_HARNESS_POLICY)).toBe(true);
  });

  it("detects any flipped flag as non-default", () => {
    expect(
      isDefaultHarnessPolicy({
        context: { ...DEFAULT_CONTEXT_POLICY, labeledPreflight: true },
      }),
    ).toBe(false);
    expect(
      isDefaultHarnessPolicy({
        context: { ...DEFAULT_CONTEXT_POLICY, labeledTier0: true },
      }),
    ).toBe(false);
  });
});

describe("resolveRunPolicyForProfile (framework for future experiments)", () => {
  const harness = createHarness({
    classification: fakeClassification(),
    contract: {} as never,
    prompt: "render a weather card",
  });

  it("falls through to identity when profile is undefined", () => {
    const resolved = resolveRunPolicyForProfile(undefined, harness, { provider: "google" });
    expect(resolved).toBe(harness.policy);
  });

  it("falls through to identity for all known-archived profile names", () => {
    // Archived profile names stay handle-able (fall through safely) so
    // stale env vars don't break production.
    // Dupe-break family RETIRED on risk:high after #44 (2026-04-14) —
    // 4 systematic ablations all failed Gate 4.
    for (const profile of [
      "not-a-real-profile",
      "experiment-40-provider-asymmetric",
      "break-dup-patch",
      "break-dup-patch-scoped",
      "break-dup-patch-diagnostic",
      "break-dup-patch-diagnostic-noforce",
      "",
    ]) {
      const resolved = resolveRunPolicyForProfile(profile, harness, { provider: "google" });
      expect(resolved).toBe(harness.policy);
    }
  });

  it("#45 ctx-slice-primitives-v1 flips primitiveDocSlice to axis-keyed", () => {
    // Experiment #45: axis-keyed primitives doc slice — first fresh
    // family after dupe-break retirement. Context-shaping lever;
    // does not touch retry context, eval criteria, or tool surface.
    const resolved = resolveRunPolicyForProfile(
      "ctx-slice-primitives-v1",
      harness,
      { provider: "google" },
    );
    expect(resolved.context.primitiveDocSlice).toBe("axis-keyed");
    // Dupe-break + labeling flags stay at baseline — one-dim experiment.
    expect(resolved.context.breakDuplicatePatch).toBe(
      harness.policy.context.breakDuplicatePatch,
    );
    expect(resolved.context.labeledPreflight).toBe(
      harness.policy.context.labeledPreflight,
    );
    expect(resolved.context.labeledTier0).toBe(
      harness.policy.context.labeledTier0,
    );
  });
});

describe("createHarness + policy — identity invariant (Codex C1 guardrail)", () => {
  it("default policy does not churn harness.id", () => {
    // Build the same harness twice from the same inputs. Default policy
    // should produce byte-identical id.
    const classification = fakeClassification();
    const input = {
      classification,
      contract: {} as never,
      prompt: "render a weather card",
    };
    const h1 = createHarness(input);
    const h2 = createHarness(input);
    expect(h1.id).toBe(h2.id);
    // The singleton-identity check
    // (`toBe(DEFAULT_HARNESS_POLICY)`) was bundle-boundary-sensitive
    // after createHarness lifted to `@ggui-ai/ui-gen/harness` — tsup
    // produces self-contained entry bundles, so `dist/harness.js` and
    // `dist/policy.js` each carry their own `DEFAULT_HARNESS_POLICY`
    // singleton. The architectural guarantee is structural (default
    // policy, frozen, doesn't contribute to harness.id), which is
    // what `isDefaultHarnessPolicy()` tests — functionally equivalent,
    // not bundle-boundary-dependent.
    expect(isDefaultHarnessPolicy(h1.policy)).toBe(true);
    expect(isDefaultHarnessPolicy(h2.policy)).toBe(true);
    expect(h1.policy).toStrictEqual(DEFAULT_HARNESS_POLICY);
    // Overrides listing must NOT include "policy" on the default path.
    expect(h1.meta.overrides).not.toContain("policy");
  });

  it("attaches policy to the harness shape without breaking legs", () => {
    const harness = createHarness({
      classification: fakeClassification(),
      contract: {} as never,
      prompt: "render a weather card",
    });
    expect(harness.policy).toBeDefined();
    expect(harness.policy.context.labeledPreflight).toBe(false);
    expect(harness.policy.context.labeledTier0).toBe(false);
    // All four legs still present.
    expect(harness.how).toBeDefined();
    expect(harness.what).toBeDefined();
    expect(harness.check).toBeDefined();
    expect(harness.process).toBeDefined();
  });
});
