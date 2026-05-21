// core/src/harness/create-harness.test.ts
//
// PR1 tests for the Harness module. Snapshot-ish: same inputs produce
// byte-stable id + name; classification changes produce different ids;
// overrides produce different ids; derive() returns new immutable Harness.

import { describe, expect, it } from "vitest";
import { classifyAxes } from "@ggui-ai/ui-gen/classifier";
import { weatherCard } from "../multi-sdk/fixtures/weather-card.fixture";
import { kanbanBoard } from "../multi-sdk/fixtures/kanban-board.fixture";
import { createHarness } from "@ggui-ai/ui-gen/harness";
import { WORKFLOWS } from "@ggui-ai/ui-gen/workflows";
import { matches } from "@ggui-ai/ui-gen/evaluation";
import { REGISTRY } from "@ggui-ai/ui-gen/evaluation/axis-checks/registry";

function classify(fx: typeof weatherCard) {
  return classifyAxes({
    contract: fx.contract as Parameters<typeof classifyAxes>[0]["contract"],
    prompt: fx.prompt,
    blueprint: fx.blueprint,
  });
}

describe("createHarness — assembly", () => {
  it("assembles all four legs", () => {
    const h = createHarness({
      classification: classify(weatherCard),
      contract: weatherCard.contract as never,
      prompt: weatherCard.prompt,
    });
    expect(h.id).toMatch(/^[a-f0-9]{12}$/);
    expect(h.name).toContain("harness@1");
    expect(h.how.systemPrompt).toContain("ggui");
    expect(h.what.boilerplate).toContain("Component");
    expect(h.what.codingTools).toHaveLength(1);
    expect(h.what.codingTools[0].name).toBe("apply_changes");
    expect(h.what.scopedTools?.[0].name).toBe("apply_changes");
    expect(h.process.workflow.id).toBe("single_pass@1");
  });

  it("id is deterministic — same inputs → same id", () => {
    const input = {
      classification: classify(weatherCard),
      contract: weatherCard.contract as never,
      prompt: weatherCard.prompt,
    };
    const a = createHarness(input);
    const b = createHarness(input);
    expect(a.id).toBe(b.id);
  });

  it("different classifications produce different ids", () => {
    const a = createHarness({
      classification: classify(weatherCard),
      contract: weatherCard.contract as never,
      prompt: weatherCard.prompt,
    });
    const b = createHarness({
      classification: classify(kanbanBoard),
      contract: kanbanBoard.contract as never,
      prompt: kanbanBoard.prompt,
    });
    expect(a.id).not.toBe(b.id);
  });

  it("meta.fragmentIds includes every classified axis", () => {
    const h = createHarness({
      classification: classify(kanbanBoard),
      contract: kanbanBoard.contract as never,
      prompt: kanbanBoard.prompt,
    });
    // kanban-board is state=merge + realtime=merge + render=grid etc.
    expect(h.meta.fragmentIds).toContain("state=merge");
    expect(h.meta.fragmentIds).toContain("realtime=merge");
  });

  it("meta.cacheTierBreakdown counts each tier", () => {
    const h = createHarness({
      classification: classify(kanbanBoard),
      contract: kanbanBoard.contract as never,
      prompt: kanbanBoard.prompt,
    });
    const total =
      h.meta.cacheTierBreakdown.stable +
      h.meta.cacheTierBreakdown.axisDelta +
      h.meta.cacheTierBreakdown.volatile;
    expect(total).toBe(h.meta.fragmentIds.length);
  });
});

describe("createHarness — check leg gating", () => {
  // Phase 1.7.4c (2026-04-17): axis-check registry is caller-filtered
  // and passed into `createHarness`. This test covers the end-to-end
  // contract: pre-filtered low-risk classification yields fewer checks
  // than pre-filtered high-risk classification, and `createHarness`
  // puts them on `check.axisChecks` verbatim.
  it("axisChecks passed by caller land on check.axisChecks (low-risk < high-risk)", () => {
    const lowClassification = classify(weatherCard);
    const highClassification = classify(kanbanBoard);
    const lowFiltered = REGISTRY.filter((c) => matches(lowClassification.vector, c));
    const highFiltered = REGISTRY.filter((c) => matches(highClassification.vector, c));
    const low = createHarness({
      classification: lowClassification,
      contract: weatherCard.contract as never,
      prompt: weatherCard.prompt,
      axisChecks: lowFiltered,
    });
    const high = createHarness({
      classification: highClassification,
      contract: kanbanBoard.contract as never,
      prompt: kanbanBoard.prompt,
      axisChecks: highFiltered,
    });
    expect(high.check.axisChecks.length).toBeGreaterThan(low.check.axisChecks.length);
    expect(low.check.axisChecks).toEqual(lowFiltered);
    expect(high.check.axisChecks).toEqual(highFiltered);
  });
});

describe("createHarness — overrides", () => {
  it("label shows up in meta.overrides", () => {
    const h = createHarness({
      classification: classify(weatherCard),
      contract: weatherCard.contract as never,
      prompt: weatherCard.prompt,
      overrides: { label: "experiment-42" },
    });
    expect(h.meta.overrides).toContain("label:experiment-42");
  });

  it("override function receives base leg + ctx and returns a new leg", () => {
    const h = createHarness({
      classification: classify(weatherCard),
      contract: weatherCard.contract as never,
      prompt: weatherCard.prompt,
      overrides: {
        how: (base) => ({ ...base, implPrompt: "custom impl prompt" }),
      },
    });
    expect(h.how.implPrompt).toBe("custom impl prompt");
    expect(h.meta.overrides).toContain("how");
  });

  it("different overrides produce different ids (hash sensitivity)", () => {
    const a = createHarness({
      classification: classify(weatherCard),
      contract: weatherCard.contract as never,
      prompt: weatherCard.prompt,
    });
    const b = createHarness({
      classification: classify(weatherCard),
      contract: weatherCard.contract as never,
      prompt: weatherCard.prompt,
      overrides: { label: "variant-b" },
    });
    expect(a.id).not.toBe(b.id);
  });
});

describe("harness.derive()", () => {
  it("swapping to a different workflow produces a new id", () => {
    const base = createHarness({
      classification: classify(weatherCard),
      contract: weatherCard.contract as never,
      prompt: weatherCard.prompt,
    });
    const derived = base.derive({ workflow: WORKFLOWS.staged });
    expect(derived.id).not.toBe(base.id);
    expect(derived.process.workflow.id).toBe("staged@1");
  });

  it("reclassification produces a new id and updates meta.classificationHash", () => {
    const base = createHarness({
      classification: classify(weatherCard),
      contract: weatherCard.contract as never,
      prompt: weatherCard.prompt,
    });
    const derived = base.derive({ classification: classify(kanbanBoard) });
    expect(derived.id).not.toBe(base.id);
    expect(derived.meta.classificationHash).not.toBe(base.meta.classificationHash);
  });
});
