// core/src/harness/run-workflow.test.ts
//
// PR3c tests. Validate that runWorkflow handles the three registered
// workflow shapes correctly:
//   - single_pass: 1 phase, 1 task
//   - staged:      2 phases, 1 task each, sequential
//   - staged_concurrent: 3 phases, middle phase has 3 parallel tasks

import { describe, expect, it } from "vitest";
import { classifyAxes } from "@ggui-ai/ui-gen/classifier";
import { weatherCard } from "../multi-sdk/fixtures/weather-card.fixture";
import { createHarness } from "@ggui-ai/ui-gen/harness";
import { WORKFLOWS } from "@ggui-ai/ui-gen/workflows";
import { runWorkflow, type TaskRunner } from "@ggui-ai/ui-gen/harness";

function harness(workflowId?: keyof typeof WORKFLOWS) {
  const classification = classifyAxes({
    contract: weatherCard.contract as Parameters<typeof classifyAxes>[0]["contract"],
    prompt: weatherCard.prompt,
  });
  const base = createHarness({
    classification,
    contract: weatherCard.contract as never,
    prompt: weatherCard.prompt,
  });
  if (!workflowId) return base;
  return base.derive({ workflow: WORKFLOWS[workflowId] });
}

describe("runWorkflow — single_pass", () => {
  it("runs one phase, one task, returns the task's output", async () => {
    const h = harness("single_pass");
    const result = await runWorkflow({
      harness: h,
      prompt: weatherCard.prompt,
      contract: weatherCard.contract as never,
      taskRunners: {
        generate: async () => "source-code-here",
      },
    });
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0].phaseId).toBe("impl");
    expect(result.phases[0].taskResults).toHaveLength(1);
    expect(result.phases[0].taskResults[0].taskId).toBe("generate");
    expect(result.results.source).toBe("source-code-here");
  });

  it("uses defaultRunner when no task-specific runner is registered", async () => {
    const h = harness("single_pass");
    const result = await runWorkflow({
      harness: h,
      prompt: weatherCard.prompt,
      contract: weatherCard.contract as never,
      defaultRunner: async (task) => `default-output-for-${task.id}`,
    });
    expect(result.results.source).toBe("default-output-for-generate");
  });
});

describe("runWorkflow — staged", () => {
  it("runs two phases sequentially; execute phase sees plan output", async () => {
    const h = harness("staged");
    const seen: string[] = [];
    const architect: TaskRunner = async () => {
      seen.push("architect");
      return "plan-text";
    };
    const coder: TaskRunner = async (_task, ctx) => {
      seen.push("coder");
      expect(ctx.priorResults.plan).toBe("plan-text");
      return "generated-source";
    };

    const result = await runWorkflow({
      harness: h,
      prompt: weatherCard.prompt,
      contract: weatherCard.contract as never,
      taskRunners: { architect, coder },
    });

    expect(seen).toEqual(["architect", "coder"]);
    expect(result.results.plan).toBe("plan-text");
    expect(result.results.source).toBe("generated-source");
    expect(result.phases.map((p) => p.phaseId)).toEqual(["plan", "execute"]);
  });
});

describe("runWorkflow — staged_concurrent", () => {
  it("runs the skeleton phase's three tasks in parallel", async () => {
    const h = harness("staged_concurrent");
    let concurrentStarts = 0;
    let concurrentPeak = 0;

    const makeConcurrent = (out: string): TaskRunner => async () => {
      concurrentStarts++;
      concurrentPeak = Math.max(concurrentPeak, concurrentStarts);
      // Let siblings also increment their start counters before resolving.
      await new Promise((r) => setTimeout(r, 10));
      concurrentStarts--;
      return out;
    };

    const result = await runWorkflow({
      harness: h,
      prompt: weatherCard.prompt,
      contract: weatherCard.contract as never,
      taskRunners: {
        architect: async () => "plan-data",
        types: makeConcurrent("types-out"),
        hooks: makeConcurrent("hooks-out"),
        jsx: makeConcurrent("jsx-out"),
        glue: async (_t, ctx) => {
          expect(ctx.priorResults.types).toBe("types-out");
          expect(ctx.priorResults.hooks).toBe("hooks-out");
          expect(ctx.priorResults.jsx).toBe("jsx-out");
          return "integrated-source";
        },
      },
    });

    expect(result.results.source).toBe("integrated-source");
    expect(concurrentPeak).toBeGreaterThanOrEqual(2);
    expect(result.phases.map((p) => p.phaseId)).toEqual(["plan", "skeleton", "integrate"]);
    expect(result.phases[1].taskResults).toHaveLength(3);
  });

  it("propagates task rejection to the caller", async () => {
    const h = harness("staged_concurrent");
    await expect(
      runWorkflow({
        harness: h,
        prompt: weatherCard.prompt,
        contract: weatherCard.contract as never,
        taskRunners: {
          architect: async () => {
            throw new Error("architect blew up");
          },
        },
      }),
    ).rejects.toThrow(/architect blew up/);
  });
});

describe("runWorkflow — metadata", () => {
  it("populates per-phase and per-task durations", async () => {
    const h = harness("single_pass");
    const result = await runWorkflow({
      harness: h,
      prompt: weatherCard.prompt,
      contract: weatherCard.contract as never,
      taskRunners: { generate: async () => "ok" },
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.phases[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(result.phases[0].taskResults[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("reports the workflow id used", async () => {
    const h = harness("staged");
    const result = await runWorkflow({
      harness: h,
      prompt: weatherCard.prompt,
      contract: weatherCard.contract as never,
      taskRunners: {
        architect: async () => "x",
        coder: async () => "y",
      },
    });
    expect(result.workflowId).toBe("staged@1");
  });
});
