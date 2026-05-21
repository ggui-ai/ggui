import { describe, it, expect } from "vitest";
import {
  MODEL_HARNESS_REGISTRY,
  resolveModelOverride,
} from "./model-registry.js";

describe("MODEL_HARNESS_REGISTRY", () => {
  it("starts empty — no overrides shipped at launch", () => {
    // At launch the registry is empty by design. This test pins the
    // "empty on main" invariant: any new entry must be accompanied by
    // an experiment entry in ui-generation-experiments.md and a comment
    // block in model-registry.ts citing the experiment that validated it.
    // When intentionally seeding an entry, UPDATE this test to reflect
    // the expected registry size — don't weaken the assertion.
    expect(Object.keys(MODEL_HARNESS_REGISTRY)).toHaveLength(0);
  });

  it("is frozen (immutable at runtime)", () => {
    expect(Object.isFrozen(MODEL_HARNESS_REGISTRY)).toBe(true);
  });
});

describe("resolveModelOverride", () => {
  it("returns undefined when model id is absent", () => {
    expect(resolveModelOverride(undefined)).toBeUndefined();
    expect(resolveModelOverride("")).toBeUndefined();
  });

  it("returns undefined when model id is unknown", () => {
    expect(resolveModelOverride("no-such-model")).toBeUndefined();
    expect(resolveModelOverride("claude-haiku-4-5")).toBeUndefined();
    expect(resolveModelOverride("gpt-5.4-mini")).toBeUndefined();
    expect(resolveModelOverride("gemini-3.1-flash-lite-preview")).toBeUndefined();
  });
});
