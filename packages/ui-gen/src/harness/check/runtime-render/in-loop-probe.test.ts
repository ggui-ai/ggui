// packages/ui-gen/src/harness/check/runtime-render/in-loop-probe.test.ts
//
// Covers the in-loop runtime-probe trigger contract (2026-04-27):
//
//   1. `isRecoverableRenderCrash(reason)` recognizes class-specific crash
//      strings (matches the same patterns `classifyRenderCrashFix` emits
//      class-specific advice for).
//   2. `classifyRenderCrashFix(reason)` returns class-specific advice for
//      recognized classes, generic fallback otherwise.
//   3. `runEvalRound` (the orchestrator) calls the harness's
//      `runtimeRender.run` ONCE at exit-decision time; on a probe FAIL
//      with a recoverable class, it returns control: "feedback" with a
//      `[runtime]` violation for the next coding turn. On probe PASS it
//      exits silently (control: "break", evalDone: true).
//   4. The probe runs exactly ONCE per call to `runEvalRound` (no
//      re-fire on the same compiled-code / same turn).

import { describe, expect, it, vi } from "vitest";

import {
  classifyRenderCrashFix,
  isRecoverableRenderCrash,
} from "./adapter.js";
import type { EvalIssue } from "../../../evaluation/types-public.js";
import type { Harness, RuntimeRenderCheck } from "../../types-public.js";
import type {
  EvalRoundContext,
  EvalRoundInput,
} from "../../coding/run-eval-round.js";
import { runEvalRound } from "../../coding/run-eval-round.js";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Recoverable-class recognition
// ─────────────────────────────────────────────────────────────────────────────

describe("isRecoverableRenderCrash", () => {
  it("recognizes 'function is not iterable' (Google × onboarding-wizard)", () => {
    expect(
      isRecoverableRenderCrash(
        "Render threw: TypeError: function is not iterable",
      ),
    ).toBe(true);
  });

  it("recognizes 'number 0 is not iterable' (Google × stock-ticker)", () => {
    expect(
      isRecoverableRenderCrash(
        "Render threw: TypeError: number 0 is not iterable",
      ),
    ).toBe(true);
  });

  it("recognizes spread/array-iteration crashes including `[...someFn]`-style", () => {
    expect(
      isRecoverableRenderCrash("TypeError: items is not iterable (cannot read property Symbol(Symbol.iterator) of undefined)"),
    ).toBe(true);
  });

  it("recognizes 'Maximum update depth exceeded' (re-render loop)", () => {
    expect(
      isRecoverableRenderCrash(
        "Infinite render loop (max-update-depth) — Maximum update depth exceeded",
      ),
    ).toBe(true);
  });

  it("recognizes 'Cannot access X before initialization' (TDZ)", () => {
    expect(
      isRecoverableRenderCrash(
        "Render threw: ReferenceError: Cannot access 'foo' before initialization",
      ),
    ).toBe(true);
  });

  it("recognizes 'X is not defined' (typo / missing destructure)", () => {
    expect(
      isRecoverableRenderCrash(
        "Render threw: ReferenceError: handleSubmit is not defined",
      ),
    ).toBe(true);
  });

  it("recognizes 'Cannot read property … of undefined'", () => {
    expect(
      isRecoverableRenderCrash(
        "Render threw: TypeError: Cannot read properties of undefined (reading 'name')",
      ),
    ).toBe(true);
  });

  it("returns false on unrecognized crash classes", () => {
    expect(isRecoverableRenderCrash("something completely unrelated")).toBe(false);
    expect(isRecoverableRenderCrash("RangeError: invalid array length")).toBe(false);
  });
});

describe("classifyRenderCrashFix", () => {
  it("returns iterable-class advice for 'is not iterable'", () => {
    const fix = classifyRenderCrashFix("TypeError: number 0 is not iterable");
    expect(fix).toMatch(/iterated over a non-array/);
    expect(fix).toMatch(/\[\]/);
  });

  it("returns re-render-loop advice for 'Maximum update depth'", () => {
    const fix = classifyRenderCrashFix(
      "Infinite render loop (max-update-depth) — Maximum update depth exceeded",
    );
    expect(fix).toMatch(/setState/);
    expect(fix).toMatch(/useEffect/);
  });

  it("returns generic fallback for unrecognized classes", () => {
    const fix = classifyRenderCrashFix("RangeError: invalid array length");
    expect(fix).toMatch(/Add null guards on optional props/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Orchestrator behavior (runEvalRound at exit-decision time)
// ─────────────────────────────────────────────────────────────────────────────
//
// We build a minimal Harness skeleton, mock the runtimeRender check, and
// assert orchestrator behavior. Avoid building any real triad — only the
// runEvalRound code path under test reads `harness.check.runtimeRender`.

// Stub everything runEvalRound touches that isn't probe-related. Most of
// these are "did you call me at all?" — runEvalRound has many code paths
// gated on costTracker / preWarmPromise / evalMod presence, and we want
// the simplest path that hits the clean-exit decision point.

function buildStubHarness(probe: RuntimeRenderCheck | undefined): Harness {
  // Cast through unknown — we only fill the fields runEvalRound reads.
  return {
    id: "stub",
    name: "stub",
    classification: {
      vector: {},
      riskTier: "medium",
    },
    how: { systemPrompt: "", implPrompt: "", fragments: [], version: "v1" },
    what: {
      boilerplate: "",
      fragments: [],
      codingTools: [],
      applyPatch: async () => ({ ok: true, sourceAfter: "" }),
      version: "v1",
    },
    check: {
      axisChecks: [],
      tierChecks: [],
      runtimeRender: probe,
      version: "v1",
    },
    process: {
      mode: "single-pass",
      workflow: { name: "single_pass", phases: [] },
      version: "v1",
    },
    policy: { context: {} },
    meta: { overrides: [] },
  } as unknown as Harness;
}

function buildBaseCtx(harness: Harness): EvalRoundContext {
  // Minimal cost tracker — runEvalRound calls .canContinue() once at
  // exit-time after maxEvalRounds, .getTotal() in logging.
  const costTracker = {
    canContinue: () => true,
    getTotal: () => 0,
    record: () => {},
  } as unknown as EvalRoundContext["costTracker"];
  return {
    workspace: {
      read: () => "// stub source",
    } as unknown as EvalRoundContext["workspace"],
    harness,
    contract: {} as unknown as EvalRoundContext["contract"],
    userPrompt: "stub prompt",
    fixtureProps: undefined,
    classification: {
      vector: { state: "merge" },
      riskTier: "medium",
    } as unknown as EvalRoundContext["classification"],
    evaluationAgent: { provider: "anthropic", model: "stub" } as unknown as EvalRoundContext["evaluationAgent"],
    visualEvalAgent: { provider: "anthropic", model: "stub" } as unknown as EvalRoundContext["visualEvalAgent"],
    visualEvaluation: undefined,
    visualThreshold: 0.7,
    qualityMode: "fast",
    maxEvalRounds: 3,
    costTracker,
    // No tier-1/2 or visual eval modules — runEvalRound's Promise.all
    // simply resolves to [null, null] which yields zero issues.
    llmEvalMod: null,
    visualMod: null,
    preWarmPromise: undefined,
    onProgress: undefined,
  };
}

function buildBaseInput(): EvalRoundInput {
  return {
    compiledCode: "var Component = () => null;",
    evalRoundsUsed: 0,
    preWarmedContext: null,
    prevModeSubcats: new Set(),
    prevFailFingerprints: new Set(),
  };
}

describe("runEvalRound — in-loop runtime probe trigger", () => {
  it("probe FAIL with recoverable class triggers [runtime] violation + grants extra turn", async () => {
    const probeRun = vi.fn(async (): Promise<readonly EvalIssue[]> => [
      {
        tier: 0,
        result: "fail",
        category: "crash",
        subcategory: "runtime:render-no-throw",
        severity: "critical",
        description: "Component crashed at runtime: Render threw: TypeError: function is not iterable",
        fix: "Render iterated over a non-array. Default to [] before .map.",
      },
    ]);
    const probe: RuntimeRenderCheck = {
      id: "stub-runtime-render",
      run: probeRun,
    };
    const harness = buildStubHarness(probe);

    const result = await runEvalRound(buildBaseCtx(harness), buildBaseInput());

    // Probe fired exactly once (one-shot at exit-decision).
    expect(probeRun).toHaveBeenCalledTimes(1);

    // Recoverable fail → control flips from "break" to "feedback".
    expect(result.control).toBe("feedback");
    expect(result.evalDone).toBe(false);
    expect(result.isEvalFeedback).toBe(true);

    // Feedback text carries the `[runtime]` tag and the fix string.
    expect(result.lastResultText).toMatch(/^\[runtime\]/);
    expect(result.lastResultText).toMatch(/Default to \[\] before \.map/);
  });

  it("probe PASS skips silently — control: break, evalDone: true", async () => {
    const probeRun = vi.fn(async (): Promise<readonly EvalIssue[]> => []); // no issues
    const probe: RuntimeRenderCheck = { id: "stub-runtime-render", run: probeRun };
    const harness = buildStubHarness(probe);

    const result = await runEvalRound(buildBaseCtx(harness), buildBaseInput());

    expect(probeRun).toHaveBeenCalledTimes(1);
    expect(result.control).toBe("break");
    expect(result.evalDone).toBe(true);
    expect(result.lastResultText).toBe("");
    expect(result.isEvalFeedback).toBe(false);
  });

  it("probe FAIL with UNRECOGNIZED class falls through to silent break", async () => {
    // Pre-fix this would have erroneously granted +1 turn for any fail.
    // Post-fix: class must be recoverable (one of the recognized
    // patterns) for the orchestrator to return control: feedback.
    const probeRun = vi.fn(async (): Promise<readonly EvalIssue[]> => [
      {
        tier: 0,
        result: "fail",
        category: "crash",
        subcategory: "runtime:render-no-throw",
        severity: "critical",
        description: "Component crashed at runtime: RangeError: invalid array length",
        fix: "Add null guards on optional props…",
      },
    ]);
    const probe: RuntimeRenderCheck = { id: "stub-runtime-render", run: probeRun };
    const harness = buildStubHarness(probe);

    const result = await runEvalRound(buildBaseCtx(harness), buildBaseInput());

    expect(probeRun).toHaveBeenCalledTimes(1);
    // Generic-class failure does NOT grant an extra turn — exit clean.
    expect(result.control).toBe("break");
    // The probe issue is still folded into evalResult for telemetry.
    expect(result.evalResult?.issues.length ?? 0).toBeGreaterThan(0);
  });

  it("one-shot: probe.run is called at most ONCE per runEvalRound invocation", async () => {
    // The orchestrator has multiple potential exit decision points
    // (low-risk bypass, clean pass, max-eval-rounds, budget-exhausted).
    // For a single (compiled-code, classification, costTracker) tuple,
    // exactly ONE of those paths fires per call — so probe.run is
    // called exactly once. This regression guards against accidentally
    // probing twice (e.g., once at low-risk bypass AND once at clean
    // pass) within the same invocation.
    const probeRun = vi.fn(async (): Promise<readonly EvalIssue[]> => []);
    const probe: RuntimeRenderCheck = { id: "stub-runtime-render", run: probeRun };
    const harness = buildStubHarness(probe);

    await runEvalRound(buildBaseCtx(harness), buildBaseInput());
    expect(probeRun).toHaveBeenCalledTimes(1);
  });

  it("no harness.check.runtimeRender → orchestrator never calls probe", async () => {
    const harness = buildStubHarness(undefined);
    const result = await runEvalRound(buildBaseCtx(harness), buildBaseInput());
    // No probe wired → exits clean without firing anything.
    expect(result.control).toBe("break");
    expect(result.evalDone).toBe(true);
  });

  it("probe infra failure (run() throws) is swallowed — silent exit, no crash", async () => {
    const probeRun = vi.fn(async () => {
      throw new Error("happy-dom failed to load");
    });
    const probe: RuntimeRenderCheck = { id: "stub-runtime-render", run: probeRun };
    const harness = buildStubHarness(probe);

    const result = await runEvalRound(buildBaseCtx(harness), buildBaseInput());

    expect(probeRun).toHaveBeenCalledTimes(1);
    // Infra failure must NOT block the harness from exiting cleanly.
    expect(result.control).toBe("break");
    expect(result.evalDone).toBe(true);
  });
});
