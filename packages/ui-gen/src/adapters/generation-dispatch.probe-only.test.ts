/**
 * ggui#1380 — the serve lane through the REAL dispatch: `enableRuntimeRender`
 * with no `evaluation` config runs the probe once after the coding turns
 * and buys one repair turn on a recoverable render crash. The twin pins:
 *
 *   - `enableRuntimeRender: true` with a probe that ran clean vs `false` →
 *     the served `compiledCode` / `sourceCode` are byte-equal, and the
 *     coding agent's `callTools` ran exactly ONCE either way (the probe adds
 *     no coding turn);
 *   - a stubbed recoverable FAIL on the first probe → exactly TWO
 *     `callTools` (the repair), the re-probe's record on the result.
 *
 * Only two seams are stubbed: the coding agent (`createAgent`, answering
 * every turn with a `write` of a self-check-passing component) and the
 * runtime-render adapter (`createRuntimeRenderCheck`, spied, returning a
 * check that answers from a queue). Session init, the coding turn, tool
 * execution (real esbuild compile + self-check), the eval round and result
 * assembly all run.
 *
 * C2 (ggui#1380): `runtimeRenderProbe` reaches the check's factory verbatim;
 * absent, the factory is called with no config — the default instance.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { RuntimeRenderCheck, RuntimeRenderOutcome } from "../harness/types-public.js";
import type { RuntimeRenderProbeConfig } from "../harness/check/runtime-render/adapter.js";
import type { EvalIssue } from "../evaluation/types-public.js";
import type { LLMResponse, LLMToolCallResponse, LLMWithToolsResponse } from "../harness/llm-router.js";

const agent = vi.hoisted(() => ({ callTools: 0 }));
const probeQueue = vi.hoisted(() => ({ outcomes: [] as RuntimeRenderOutcome[], calls: 0 }));
const probeFactory = vi.hoisted(() => ({ configs: [] as (RuntimeRenderProbeConfig | undefined)[] }));

const COMPONENT = `interface Props { name: string; }
export default function Hello(props: Props) {
  return <div style={{ color: 'var(--ggui-color-onContainer)' }} aria-label="c">{props.name}</div>;
}`;

vi.mock("../harness/llm-router.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../harness/llm-router.js")>();
  /** Answers every turn with a `write` of the same self-check-passing component. */
  class ScriptedAgent extends actual.LLMAgent {
    readonly provider = "anthropic" as const;
    protected resolveModel(model: string): string {
      return model;
    }
    protected createClient(): Promise<null> {
      return Promise.resolve(null);
    }
    callText(): Promise<LLMResponse> {
      return Promise.reject(new Error("callText is not scripted in this test"));
    }
    callTools(): Promise<LLMToolCallResponse> {
      agent.callTools += 1;
      return Promise.resolve({
        toolCalls: [{ id: `c${agent.callTools}`, name: "write", input: { code: COMPONENT, commit_message: `turn ${agent.callTools}` } }],
        inputTokens: 10,
        outputTokens: 5,
      });
    }
    callWithTools(): Promise<LLMWithToolsResponse> {
      return Promise.reject(new Error("callWithTools is not scripted in this test"));
    }
  }
  return { ...actual, createAgent: () => new ScriptedAgent() };
});

vi.mock("../harness/check/runtime-render/adapter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../harness/check/runtime-render/adapter.js")>();
  const stub: RuntimeRenderCheck = {
    id: "stub-runtime-render",
    run: async () => {
      probeQueue.calls += 1;
      const next = probeQueue.outcomes.shift();
      if (next === undefined) throw new Error(`unscripted probe call #${probeQueue.calls}`);
      return next;
    },
  };
  return {
    ...actual,
    DEFAULT_RUNTIME_RENDER_CHECK: stub,
    // C2: the dispatch never builds a check itself — the instance is the
    // caller's (its lifetime is the concurrency cap's); this spy proves it.
    createRuntimeRenderCheck: (config?: RuntimeRenderProbeConfig): RuntimeRenderCheck => {
      probeFactory.configs.push(config);
      return stub;
    },
  };
});

const { dispatchGeneration } = await import("./generation-dispatch.js");

const RECOVERABLE_CRASH: EvalIssue = {
  tier: 0,
  result: "fail",
  category: "crash",
  subcategory: "runtime:render-no-throw",
  severity: "critical",
  description: "Component crashed at runtime: Render threw: TypeError: function is not iterable",
  fix: "Render iterated over a non-array. Default to [] before .map.",
};

function dispatch(enableRuntimeRender: boolean, runtimeRender?: RuntimeRenderCheck) {
  return dispatchGeneration({
    provider: "claude",
    model: "claude-haiku-4-5",
    userPrompt: "A greeting card",
    originalPrompt: "A greeting card",
    tools: [],
    enableRuntimeRender,
    maxAttempts: 4,
    ...(runtimeRender !== undefined ? { runtimeRender } : {}),
  });
}

describe("the serve lane through dispatch (ggui#1380)", () => {
  beforeEach(() => {
    agent.callTools = 0;
    probeQueue.outcomes.length = 0;
    probeQueue.calls = 0;
    probeFactory.configs.length = 0;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("enableRuntimeRender true (probe ran clean) vs false: byte-equal card, one callTools each, the probe once vs never", async () => {
    const off = await dispatch(false);
    expect(agent.callTools).toBe(1);
    expect(probeQueue.calls).toBe(0);
    expect(off.evalResult).toBeUndefined();
    expect(off.breakdown?.evalRounds).toBe(0);

    agent.callTools = 0;
    probeQueue.outcomes.push({ status: "ran", issues: [], elapsedMs: 21, renderMs: 9 });
    const on = await dispatch(true);
    expect(agent.callTools).toBe(1);
    expect(probeQueue.calls).toBe(1);
    expect(on.compiledCode).toBe(off.compiledCode);
    expect(on.sourceCode).toBe(off.sourceCode);
    expect(on.compiledCode.length).toBeGreaterThan(0);
    expect(on.evalResult?.pass).toEqual(["probe-only"]);
    expect(on.evalResult?.runtimeProbe).toEqual({ status: "ran", elapsedMs: 21, renderMs: 9 });
    expect(on.breakdown?.evalRounds).toBe(1);
    expect(on.breakdown?.phases.evalFix).toBe(0);
    expect(on.selfCheckPassed).toBe(true);
    // C2: no instance passed ⇒ the harness carries DEFAULT_RUNTIME_RENDER_CHECK;
    // the dispatch never builds one (the factory is the generator's, once).
    expect(probeFactory.configs).toEqual([]);
  }, 60_000);

  it("a passed runtimeRender instance is the check the harness runs — verbatim, never rebuilt (ggui#1380 C2)", async () => {
    let ran = 0;
    const own: RuntimeRenderCheck = {
      id: "callers-own-check",
      run: async () => {
        ran += 1;
        return { status: "ran", issues: [], elapsedMs: 5, renderMs: 2 };
      },
    };
    const result = await dispatch(true, own);
    expect(ran).toBe(1);
    expect(probeQueue.calls).toBe(0);
    expect(probeFactory.configs).toEqual([]);
    expect(result.evalResult?.runtimeProbe).toEqual({ status: "ran", elapsedMs: 5, renderMs: 2 });
  }, 60_000);

  it("a recoverable FAIL on the first probe: exactly two callTools (the repair), the re-probe's record on the result", async () => {
    probeQueue.outcomes.push(
      { status: "ran", issues: [RECOVERABLE_CRASH], elapsedMs: 40 },
      { status: "ran", issues: [], elapsedMs: 18 },
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await dispatch(true);

    expect(agent.callTools).toBe(2);
    expect(probeQueue.calls).toBe(2);
    expect(result.turnsUsed).toBe(2);
    // one definition of a turn on both lanes (rnd): the repair turn is an
    // ordinary coding turn and emits the same trace line a feedback turn does
    expect(
      log.mock.calls.some(([m]) => typeof m === "string" && /^\[simple\] turn 2 \(eval-fix\)/.test(m)),
    ).toBe(true);
    expect(result.breakdown?.evalRounds).toBe(2);
    expect(result.breakdown?.phases.evalFix).toBe(1);
    expect(result.evalResult?.pass).toEqual(["probe-only"]);
    expect(result.evalResult?.runtimeProbe).toEqual({ status: "ran", elapsedMs: 18 });
    expect(result.evalResult?.runtimeProbeRepair).toEqual({ attempted: true, afterStatus: "ran", recoverableFailAfter: false });
    expect(result.compiledCode.length).toBeGreaterThan(0);
  }, 60_000);
});
