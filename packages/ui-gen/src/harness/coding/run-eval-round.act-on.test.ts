// ggui#1542 — `visualEvaluation.actOn`: which of the VISUAL leg's own findings may start another eval round in
// `fast` quality mode. Exp 015 found the in-loop visual judge's majors were tier-2 warns in a fast-mode loop, so a
// judge that saw the bar's failure class never bought a fix turn. Pinned here:
//   - unset (today) and 'critical': a visual major alone does not continue the loop, byte-for-byte today's decision;
//   - 'major': the visual JUDGE's major warn continues it, and the fix turn is fed that finding;
//   - the text evaluator's warns never count, even one in the `visual` category (it has a tier-2 visual criterion);
//   - the fit measurement's warn-level overflow never counts (fit is its own feedback source, judge or no judge);
//   - the other quality modes are unchanged (every warn already continues there).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentWorkspace } from "../../coding-agent/workspace.js";
import { CostTracker } from "../../evaluation/cost-tracker.js";
import { classifyAxes } from "../../classifier/classifier.js";
import { createHarness } from "../../create-harness.js";
import * as realLlmEvaluator from "../../evaluation/llm-evaluator.js";
import * as realVisualEvaluator from "../../evaluation/visual-evaluator.js";
import type { VisualEvalOutcome } from "../../evaluation/visual-evaluator.js";
import type { EvalIssue } from "../../evaluation/types-public.js";
import type { RuntimeRenderCheck } from "../types-public.js";
import type { AgentSpec, SingleComponentParams } from "../runtime.js";
import type { EvalRoundContext, EvalRoundInput } from "./run-eval-round.js";

const mockRunCheck = vi.fn();
vi.mock("../index.js", () => ({
  runCheck: (...args: unknown[]) => mockRunCheck(...args),
}));
const { runEvalRound } = await import("./run-eval-round.js");

const SOURCE = "export default function C() { return null; }";
const cleanProbe: RuntimeRenderCheck = {
  id: "fake-runtime-render",
  run: () => Promise.resolve({ status: "ran", issues: [] }),
};

const judgeMajor: EvalIssue = {
  tier: 2,
  result: "warn",
  category: "visual",
  subcategory: "layout",
  severity: "major",
  origin: "judge",
  description: "The chips sit in a sparse lower section with blank space below.",
  fix: "Group the header, message and chips as one compact unit.",
};
const fitMajor: EvalIssue = {
  tier: 2,
  result: "warn",
  category: "visual",
  subcategory: "canvas-overflow",
  severity: "major",
  origin: "instrument",
  description: "The content runs a few pixels past the box.",
  fix: "Tighten the vertical spacing.",
};
const textVisualWarn: EvalIssue = {
  tier: 2,
  result: "warn",
  category: "visual",
  subcategory: "aesthetics",
  severity: "major",
  description: "The text evaluator finds the palette flat.",
  fix: "Add one accent.",
};

type ActOn = NonNullable<SingleComponentParams["visualEvaluation"]>["actOn"];

async function buildCtx(opts: {
  readonly visualIssues: readonly EvalIssue[];
  readonly textIssues?: readonly EvalIssue[];
  readonly actOn?: ActOn;
  readonly qualityMode?: EvalRoundContext["qualityMode"];
}): Promise<{ ctx: EvalRoundContext; input: EvalRoundInput }> {
  const classification = {
    ...classifyAxes({ contract: {}, prompt: "a welcome card" }),
    riskTier: "medium" as const,
  };
  const base = createHarness({ classification, contract: {}, prompt: "a welcome card" });
  const harness = { ...base, check: { ...base.check, runtimeRender: cleanProbe } };
  const workspace = new AgentWorkspace();
  await workspace.init();
  workspace.write(SOURCE);
  const agent: AgentSpec = { provider: "anthropic", model: "claude-haiku-4-5" };
  const fakeLlmEvalMod: typeof realLlmEvaluator = {
    ...realLlmEvaluator,
    runLLMEvaluation: () =>
      Promise.resolve({
        issues: [...(opts.textIssues ?? [])],
        pass: [],
        inputTokens: 500,
        outputTokens: 100,
      }),
  };
  const outcome: VisualEvalOutcome = {
    issues: [...opts.visualIssues],
    coverage: { status: "ran" },
  };
  const fakeVisualMod: typeof realVisualEvaluator = {
    ...realVisualEvaluator,
    runVisualEval: () => Promise.resolve(outcome),
  };
  const ctx: EvalRoundContext = {
    workspace,
    harness,
    contract: undefined,
    userPrompt: "a welcome card",
    fixtureProps: {},
    classification,
    evaluationAgent: agent,
    visualEvalAgent: agent,
    visualEvaluation: { enabled: true, ...(opts.actOn !== undefined ? { actOn: opts.actOn } : {}) },
    visualThreshold: 70,
    qualityMode: opts.qualityMode ?? "fast",
    maxEvalRounds: 3,
    costTracker: new CostTracker(null),
    llmEvalMod: fakeLlmEvalMod,
    visualMod: fakeVisualMod,
    preWarmPromise: undefined,
    probeOnly: false,
    probeRepairUsed: false,
  };
  const input: EvalRoundInput = {
    compiledCode: SOURCE,
    evalRoundsUsed: 0,
    preWarmedContext: undefined,
    prevModeSubcats: new Set(),
    prevFailFingerprints: new Set(),
  };
  return { ctx, input };
}

describe("visualEvaluation.actOn — the visual leg’s majors may start a round in fast mode (ggui#1542)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  const reasonLines = (): string[] =>
    logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("continuing: fails="));
  beforeEach(() => {
    mockRunCheck.mockReset();
    mockRunCheck.mockResolvedValue({ issues: [] });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it("unset (today): a visual major alone does not continue, and no reason line is logged", async () => {
    const { ctx, input } = await buildCtx({ visualIssues: [judgeMajor] });
    const round = await runEvalRound(ctx, input);
    expect(round.control).toBe("break");
    expect(reasonLines()).toEqual([]);
  });

  it("'critical' decides exactly as unset: a visual major alone does not continue", async () => {
    const { ctx, input } = await buildCtx({ visualIssues: [judgeMajor], actOn: "critical" });
    const round = await runEvalRound(ctx, input);
    expect(round.control).toBe("break");
  });

  it("'major': the visual judge's major continues the loop, feeds that finding back, and names the reason", async () => {
    const { ctx, input } = await buildCtx({ visualIssues: [judgeMajor], actOn: "major" });
    const round = await runEvalRound(ctx, input);
    expect(round.control).toBe("feedback");
    expect(round.isEvalFeedback).toBe(true);
    expect(round.lastResultText).toContain(judgeMajor.description);
    expect(reasonLines()).toEqual([
      "[simple] eval round 1: continuing: fails=0, visual majors acted=1 (actOn=major)",
    ]);
  });

  it("'major' never counts the text evaluator's warns, even one in the visual category", async () => {
    const { ctx, input } = await buildCtx({
      visualIssues: [],
      textIssues: [textVisualWarn],
      actOn: "major",
    });
    const round = await runEvalRound(ctx, input);
    expect(round.control).toBe("break");
    expect(reasonLines()).toEqual([]);
  });

  it("'major' never acts on the fit measurement's warn-level overflow: fit alone does not continue", async () => {
    const { ctx, input } = await buildCtx({ visualIssues: [fitMajor], actOn: "major" });
    const round = await runEvalRound(ctx, input);
    expect(round.control).toBe("break");
    expect(reasonLines()).toEqual([]);
  });

  it("'major' with a judge major beside a fit warn: it continues on the judge's, and counts the judge's alone", async () => {
    const { ctx, input } = await buildCtx({ visualIssues: [judgeMajor, fitMajor], actOn: "major" });
    const round = await runEvalRound(ctx, input);
    expect(round.control).toBe("feedback");
    expect(reasonLines()).toEqual([
      "[simple] eval round 1: continuing: fails=0, visual majors acted=1 (actOn=major)",
    ]);
  });

  it("'major' never acts on a NEW instrument check either: selection is by origin, not by name (ggui#1545)", async () => {
    // A future deterministic check at `major`, under a dimension the old name-exclusion never listed.
    const newInstrumentMajor: EvalIssue = { ...fitMajor, subcategory: "canvas-contrast", description: "Low contrast." };
    const { ctx, input } = await buildCtx({ visualIssues: [newInstrumentMajor], actOn: "major" });
    const round = await runEvalRound(ctx, input);
    expect(round.control).toBe("break");
    expect(reasonLines()).toEqual([]);
  });

  it("'major' fails closed: a visual major with no origin is not acted on (ggui#1545)", async () => {
    const { origin: _dropped, ...unmarked } = judgeMajor;
    const { ctx, input } = await buildCtx({ visualIssues: [unmarked], actOn: "major" });
    const round = await runEvalRound(ctx, input);
    expect(round.control).toBe("break");
    expect(reasonLines()).toEqual([]);
  });

  it("the other quality modes are unchanged: every warn already continues there, with or without the setting", async () => {
    for (const actOn of [undefined, "critical", "major"] as const) {
      const { ctx, input } = await buildCtx({
        visualIssues: [],
        textIssues: [textVisualWarn],
        qualityMode: "auto-improve",
        ...(actOn !== undefined ? { actOn } : {}),
      });
      const round = await runEvalRound(ctx, input);
      expect(round.control).toBe("feedback");
    }
  });
});
