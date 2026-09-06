import { describe, expect, it } from "vitest";

import { MODEL_IDS, isModelId } from "../llm.js";
import {
  isModelRef,
  modelRefOfRoute,
  parseAnyLlmRoute,
  parseModelRef,
  type ModelRef,
} from "../llm-route.js";

/**
 * ggui#924 — the blueprint record's `model` is the run's route rendered
 * in the registry's spelling (a `ModelRef`, `<prefix>/<model>`), of which
 * registry `ModelId`s are the subset. A bare model name, an unknown
 * prefix, a model the provider cannot route, or a second spelling of a
 * route (the dated wire id of an aliased model) is refused.
 */
describe("ModelRef (ggui#924)", () => {
  it("accepts every registry id — the registry is a subset of the route space", () => {
    expect(MODEL_IDS.length).toBeGreaterThan(0);
    for (const id of MODEL_IDS) expect(isModelRef(id), id).toBe(true);
  });

  it("refuses a bare model name (no provider segment)", () => {
    expect(isModelRef("claude-haiku-4-5")).toBe(false);
  });

  it("refuses an unknown provider", () => {
    expect(isModelRef("acme/claude-haiku-4-5")).toBe(false);
  });

  it("refuses the dated wire id of an aliased model — a route has ONE ref spelling", () => {
    expect(isModelRef("anthropic/claude-haiku-4-5-20251001")).toBe(false);
  });

  it("refuses the provider name where the registry spells the prefix differently", () => {
    expect(isModelRef("google/gemini-3.5-flash")).toBe(false);
  });

  it("renders the pod's resolved haiku route as the registry id (cloud's pin)", () => {
    const configured = parseAnyLlmRoute("anthropic/claude-haiku-4-5");
    expect(configured).toEqual({ provider: "anthropic", model: "claude-haiku-4-5-20251001" });
    if (configured === null) throw new Error("unreachable");
    const ref = modelRefOfRoute(configured);
    expect(ref).toBe("anthropic/claude-haiku-4-5");
    expect(isModelId(ref)).toBe(true);
    expect(parseModelRef(ref)).toEqual(configured);
  });

  it("refuses an empty model segment", () => {
    expect(isModelRef("anthropic/")).toBe(false);
  });

  it("accepts a bedrock inference profile through the bedrock escape hatch", () => {
    expect(isModelRef("bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(true);
    expect(isModelRef("bedrock/arn:aws:bedrock:us-east-1:123456789012:inference-profile/x")).toBe(
      true,
    );
  });

  it("accepts an unlisted openrouter model — split at the FIRST slash", () => {
    expect(isModelRef("openrouter/anthropic/claude-3.5-sonnet")).toBe(true);
  });

  it("modelRefOfRoute renders the route and equals the registry id when the registry lists it", () => {
    const ref: ModelRef = modelRefOfRoute({ provider: "anthropic", model: "claude-opus-5" });
    expect(ref).toBe("anthropic/claude-opus-5");
    expect(isModelId(ref)).toBe(true);
    expect(isModelRef(ref)).toBe(true);
  });

  it("modelRefOfRoute is total: an escape-hatch route renders to a ref the registry does not list", () => {
    const ref = modelRefOfRoute({
      provider: "bedrock",
      model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    });
    expect(ref).toBe("bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(isModelRef(ref)).toBe(true);
    expect(isModelId(ref)).toBe(false);
    expect(parseModelRef(ref)).toEqual({
      provider: "bedrock",
      model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    });
  });

  it("parseModelRef is null for every refused spelling", () => {
    for (const s of ["claude-haiku-4-5", "acme/x", "anthropic/", "anthropic/claude-haiku-4-5-20251001"])
      expect(parseModelRef(s), s).toBeNull();
  });
});
