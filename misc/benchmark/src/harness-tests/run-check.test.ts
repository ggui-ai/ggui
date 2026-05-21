// core/src/harness/run-check.test.ts
//
// Tests for the post-workflow eval stage (lifted to
// `@ggui-ai/ui-gen/harness` in Phase 1.7.3). Verifies that runCheck:
//  - iterates pre-filtered axisChecks on the harness (no re-matching)
//  - respects the null-compile short-circuit
//  - runs tier checks and LLM evaluator when present
//
// Test lives in core/ (not ui-gen/) because it depends on core's
// createHarness + fixtures; the body under test is the open runCheck.

import { describe, expect, it } from "vitest";
import { classifyAxes } from "@ggui-ai/ui-gen/classifier";
import { weatherCard } from "../multi-sdk/fixtures/weather-card.fixture";
import { kanbanBoard } from "../multi-sdk/fixtures/kanban-board.fixture";
import { createHarness, runCheck } from "@ggui-ai/ui-gen/harness";
import { matches } from "@ggui-ai/ui-gen/evaluation";
import { REGISTRY } from "@ggui-ai/ui-gen/evaluation/axis-checks/registry";
import type { TierCheck, LLMEvaluator } from "@ggui-ai/ui-gen/harness/types";

// Phase 1.7.4c (2026-04-17): axis-check registry is caller-injected on
// `createHarness`. Pre-filter core's closed REGISTRY via public
// `matches()` — same pattern the production dispatch boundary uses.
function harnessFor(fx: typeof weatherCard) {
  const classification = classifyAxes({
    contract: fx.contract as Parameters<typeof classifyAxes>[0]["contract"],
    prompt: fx.prompt,
    blueprint: fx.blueprint,
  });
  return createHarness({
    classification,
    contract: fx.contract as never,
    prompt: fx.prompt,
    axisChecks: REGISTRY.filter((c) => matches(classification.vector, c)),
  });
}

describe("runCheck", () => {
  it("short-circuits on null compiled code", async () => {
    const harness = harnessFor(weatherCard);
    const result = await runCheck({
      harness,
      sourceCode: "",
      compiledCode: null,
      prompt: weatherCard.prompt,
    });
    expect(result.issues).toHaveLength(0);
    expect(result.firedCheckIds).toHaveLength(0);
  });

  it("fires every pre-gated axis check once", async () => {
    const harness = harnessFor(kanbanBoard);
    const result = await runCheck({
      harness,
      sourceCode: "export default function Component() { return null; }",
      compiledCode: "x",
      prompt: kanbanBoard.prompt,
    });
    // kanban has state=merge + realtime=merge + render=grid — multiple checks fire
    expect(result.firedCheckIds.length).toBeGreaterThan(0);
    // No duplicate firings (same id twice)
    const unique = new Set(result.firedCheckIds);
    expect(unique.size).toBe(result.firedCheckIds.length);
  });

  it("runs harness-level tierChecks when configured via override", async () => {
    const baseHarness = harnessFor(weatherCard);
    const tierCheck: TierCheck = {
      id: "test.tier-example",
      tier: 0,
      run: () => [
        {
          category: "visual",
          description: "injected tier issue",
          result: "warn",
          tier: 0,
          fix: "n/a",
        },
      ],
    };
    const harness = createHarness({
      classification: baseHarness.classification,
      contract: weatherCard.contract as never,
      prompt: weatherCard.prompt,
      overrides: {
        check: (base) => ({ ...base, tierChecks: [tierCheck] }),
      },
    });
    const result = await runCheck({
      harness,
      sourceCode: "x",
      compiledCode: "x",
      prompt: weatherCard.prompt,
    });
    expect(result.tierIssueCount).toBe(1);
    expect(result.firedCheckIds).toContain("test.tier-example");
  });

  it("runs LLM evaluator when configured", async () => {
    const baseHarness = harnessFor(weatherCard);
    const llm: LLMEvaluator = {
      id: "test.llm-evaluator",
      run: async () => [
        {
          category: "visual",
          description: "injected LLM issue",
          result: "warn",
          tier: 2,
          fix: "n/a",
        },
      ],
    };
    const harness = createHarness({
      classification: baseHarness.classification,
      contract: weatherCard.contract as never,
      prompt: weatherCard.prompt,
      overrides: {
        check: (base) => ({ ...base, llmEvaluator: llm }),
      },
    });
    const result = await runCheck({
      harness,
      sourceCode: "x",
      compiledCode: "x",
      contract: weatherCard.contract as never,
      prompt: weatherCard.prompt,
    });
    expect(result.llmIssueCount).toBe(1);
    expect(result.firedCheckIds).toContain("test.llm-evaluator");
  });

  it("skips LLM evaluator if no contract is provided", async () => {
    const baseHarness = harnessFor(weatherCard);
    let called = false;
    const llm: LLMEvaluator = {
      id: "test.llm",
      run: async () => {
        called = true;
        return [];
      },
    };
    const harness = createHarness({
      classification: baseHarness.classification,
      contract: weatherCard.contract as never,
      prompt: weatherCard.prompt,
      overrides: { check: (base) => ({ ...base, llmEvaluator: llm }) },
    });
    await runCheck({
      harness,
      sourceCode: "x",
      compiledCode: "x",
      prompt: weatherCard.prompt,
      // contract deliberately omitted
    });
    expect(called).toBe(false);
  });
});
