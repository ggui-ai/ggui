/**
 * ggui#1513 — the one predicate for "does this generation run in-loop
 * evaluation calls": the harness gates its eval rounds on it, and a host
 * that prices a generation's token counts reads it to know whether those
 * counts can include evaluation calls.
 */
import { describe, expect, it } from "vitest";
import type { CreateUiGeneratorOptions } from "../create-ui-generator.js";
import { inLoopEvaluation, runsInLoopEvaluation } from "./in-loop-evaluation.js";

describe("inLoopEvaluation (ggui#1513)", () => {
  it("is off when no switch is set", () => {
    expect(inLoopEvaluation({})).toEqual({ text: false, visual: false });
    expect(runsInLoopEvaluation({})).toBe(false);
  });

  it("turns the text evaluator on with evaluation.enabled, and only then", () => {
    expect(inLoopEvaluation({ evaluation: { enabled: true } })).toEqual({ text: true, visual: false });
    expect(inLoopEvaluation({ evaluation: { enabled: false } })).toEqual({ text: false, visual: false });
  });

  it("turns the visual judge on with visualEvaluation.enabled, or with qualityConfig.visualEval", () => {
    expect(inLoopEvaluation({ visualEvaluation: { enabled: true } })).toEqual({ text: false, visual: true });
    expect(inLoopEvaluation({ qualityConfig: { visualEval: true } })).toEqual({ text: false, visual: true });
    expect(inLoopEvaluation({ visualEvaluation: { enabled: false }, qualityConfig: { visualEval: false } })).toEqual({
      text: false,
      visual: false,
    });
  });

  it("runs when either leg is on", () => {
    expect(runsInLoopEvaluation({ evaluation: { enabled: true } })).toBe(true);
    expect(runsInLoopEvaluation({ qualityConfig: { visualEval: true } })).toBe(true);
  });

  it("takes the options a host configures createUiGenerator with, as they are", () => {
    const options: CreateUiGeneratorOptions = {
      evaluation: { enabled: true, passThreshold: 70 },
      visualEvaluation: { enabled: false },
    };
    expect(runsInLoopEvaluation(options)).toBe(true);
  });
});
