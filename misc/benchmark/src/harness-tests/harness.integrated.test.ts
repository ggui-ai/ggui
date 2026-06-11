// core/src/harness/harness.integration.test.ts
//
// Full-pipeline integration test. Exercises every public entry point of the
// harness module together — createHarness, override, derive, runWorkflow,
// runCheck, runHarness, applyPatch — using real fixture classifications +
// stub task runners + stub LLM evaluator. Validates that the pieces
// compose cleanly and that the architecture diagram in types.ts actually
// works end-to-end.

import { describe, expect, it } from "vitest";
import { classifyAxes } from "@ggui-ai/ui-gen/classifier";
import { weatherCard } from "../multi-sdk/fixtures/weather-card.fixture";
import { kanbanBoard } from "../multi-sdk/fixtures/kanban-board.fixture";
import {
  applyLineRanges,
  createHarness,
  defaultApplyPatch,
  hashHarness,
  runCheck,
  runHarness,
  runWorkflow,
  WORKFLOWS,
  type PatchFn,
  type TaskRunner,
  type LLMEvaluator,
} from "@ggui-ai/ui-gen/harness";

describe("harness integration — core flow", () => {
  it("createHarness → runHarness produces source via stub generate runner", async () => {
    const classification = classifyAxes({
      contract: weatherCard.contract as Parameters<typeof classifyAxes>[0]["contract"],
      prompt: weatherCard.prompt,
    });
    const h = createHarness({
      classification,
      contract: weatherCard.contract as never,
      prompt: weatherCard.prompt,
    });

    const generate: TaskRunner = async (_task, ctx) =>
      `// ${ctx.classification.riskTier} render\nexport default () => null;`;

    const result = await runHarness({
      harness: h,
      prompt: weatherCard.prompt,
      contract: weatherCard.contract as never,
      taskRunners: { generate },
      passes: () => true,
    });

    expect(result.ok).toBe(true);
    expect(result.finalSource).toContain("export default");
    expect(result.iterations[0].harnessId).toBe(h.id);
    expect(result.iterations[0].workflowId).toBe("single_pass@1");
  });
});

describe("harness integration — override + derive", () => {
  it("applyPatch override affects patch engine behavior and changes harness id", async () => {
    const classification = classifyAxes({
      contract: weatherCard.contract as Parameters<typeof classifyAxes>[0]["contract"],
      prompt: weatherCard.prompt,
    });

    // Strict variant: reject any multi-range patch — forces single-change patches only.
    const strictPatcher: PatchFn = async ({ sourceBefore, changes }) => {
      if (changes.length > 1) {
        return { ok: false, error: "strict: only single-change patches allowed" };
      }
      return defaultApplyPatch({ sourceBefore, changes });
    };

    const baseline = createHarness({
      classification,
      contract: weatherCard.contract as never,
      prompt: weatherCard.prompt,
    });
    const variant = createHarness({
      classification,
      contract: weatherCard.contract as never,
      prompt: weatherCard.prompt,
      overrides: {
        what: (base) => ({ ...base, applyPatch: strictPatcher }),
        label: "strict-patch",
      },
    });

    expect(baseline.id).not.toBe(variant.id);
    expect(variant.meta.overrides).toContain("what");
    expect(variant.meta.overrides).toContain("label:strict-patch");

    // Call the override directly — strict variant rejects multi-range:
    const rejected = await variant.what.applyPatch({
      sourceBefore: "a\nb\nc",
      changes: [
        { startLine: 1, endLine: 1, code: ["A"] },
        { startLine: 3, endLine: 3, code: ["C"] },
      ],
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toMatch(/strict/);

    // Baseline accepts the same input:
    const accepted = await baseline.what.applyPatch({
      sourceBefore: "a\nb\nc",
      changes: [
        { startLine: 1, endLine: 1, code: ["A"] },
        { startLine: 3, endLine: 3, code: ["C"] },
      ],
    });
    expect(accepted.ok).toBe(true);
  });

  it("derive(workflow) swaps topology and preserves classification", async () => {
    const classification = classifyAxes({
      contract: kanbanBoard.contract as Parameters<typeof classifyAxes>[0]["contract"],
      prompt: kanbanBoard.prompt,
    });
    const base = createHarness({
      classification,
      contract: kanbanBoard.contract as never,
      prompt: kanbanBoard.prompt,
    });
    const staged = base.derive({ workflow: WORKFLOWS.staged });
    expect(staged.classification).toBe(base.classification);
    expect(staged.process.workflow.id).toBe("staged@1");
    expect(staged.id).not.toBe(base.id);
    expect(hashHarness(staged)).not.toBe(hashHarness(base));
  });

  it("derive({ useFallbackTools: true }) promotes scopedTools to codingTools", () => {
    const classification = classifyAxes({
      contract: weatherCard.contract as Parameters<typeof classifyAxes>[0]["contract"],
      prompt: weatherCard.prompt,
    });
    const base = createHarness({
      classification,
      contract: weatherCard.contract as never,
      prompt: weatherCard.prompt,
    });
    expect(base.what.codingTools[0].name).toBe("apply_changes");
    expect(base.what.scopedTools?.[0].name).toBe("apply_changes");
    // Before fallback: primary tool allows multi-range
    expect(base.what.codingTools[0].parameters.properties).toBeDefined();

    const fallback = base.derive({ useFallbackTools: true });
    // After: primary tool is now the scoped variant (maxItems=1)
    expect(fallback.what.codingTools).toEqual(base.what.scopedTools);
    expect(fallback.id).not.toBe(base.id);
  });
});

describe("harness integration — runWorkflow + runCheck composition", () => {
  it("staged workflow produces source through architect + coder tasks", async () => {
    const classification = classifyAxes({
      contract: weatherCard.contract as Parameters<typeof classifyAxes>[0]["contract"],
      prompt: weatherCard.prompt,
    });
    const base = createHarness({
      classification,
      contract: weatherCard.contract as never,
      prompt: weatherCard.prompt,
    });
    const h = base.derive({ workflow: WORKFLOWS.staged });

    const architect: TaskRunner = async () => "plan: weather card with temp + unit toggle";
    const coder: TaskRunner = async (_t, ctx) =>
      `// built from plan: "${ctx.priorResults.plan}"\nexport default () => null;`;

    const wfResult = await runWorkflow({
      harness: h,
      prompt: weatherCard.prompt,
      contract: weatherCard.contract as never,
      taskRunners: { architect, coder },
    });
    expect(wfResult.phases).toHaveLength(2);
    expect(wfResult.results.plan).toMatch(/weather card/);
    expect(wfResult.results.source).toMatch(/built from plan/);

    const checkResult = await runCheck({
      harness: h,
      sourceCode: wfResult.results.source as string,
      compiledCode: wfResult.results.source as string,
      contract: weatherCard.contract as never,
      prompt: weatherCard.prompt,
    });
    expect(checkResult.issues).toBeDefined();
  });
});

describe("harness integration — LLM evaluator slot", () => {
  it("runHarness invokes harness.check.llmEvaluator on each iteration", async () => {
    const classification = classifyAxes({
      contract: weatherCard.contract as Parameters<typeof classifyAxes>[0]["contract"],
      prompt: weatherCard.prompt,
    });
    let llmCallCount = 0;
    const llmEvaluator: LLMEvaluator = {
      id: "stub.llm",
      run: async () => {
        llmCallCount++;
        return [];
      },
    };
    const h = createHarness({
      classification,
      contract: weatherCard.contract as never,
      prompt: weatherCard.prompt,
      overrides: { check: (base) => ({ ...base, llmEvaluator }) },
    });

    const generate: TaskRunner = async () => "export default () => null;";
    const result = await runHarness({
      harness: h,
      prompt: weatherCard.prompt,
      contract: weatherCard.contract as never,
      taskRunners: { generate },
      passes: () => false,
      maxIterations: 3,
    });

    expect(result.reason).toBe("max-iterations");
    expect(llmCallCount).toBe(3);
  });
});

describe("harness integration — purity guarantees", () => {
  it("applyLineRanges is deterministic — same inputs → same output", () => {
    const src = "a\nb\nc\nd\ne";
    const changes = [{ startLine: 2, endLine: 3, code: ["X", "Y"] }];
    const a = applyLineRanges(src, changes);
    const b = applyLineRanges(src, changes);
    expect(a).toEqual(b);
    expect(a.ok && a.sourceAfter).toBe(b.ok && b.sourceAfter);
  });

  it("createHarness is deterministic — same inputs → same id", () => {
    const classification = classifyAxes({
      contract: weatherCard.contract as Parameters<typeof classifyAxes>[0]["contract"],
      prompt: weatherCard.prompt,
    });
    const input = {
      classification,
      contract: weatherCard.contract as never,
      prompt: weatherCard.prompt,
    };
    const a = createHarness(input);
    const b = createHarness(input);
    expect(a.id).toBe(b.id);
    expect(a.name).toBe(b.name);
    expect(hashHarness(a)).toBe(hashHarness(b));
  });
});
