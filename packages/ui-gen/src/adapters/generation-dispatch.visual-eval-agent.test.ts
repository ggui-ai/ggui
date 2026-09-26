/**
 * ggui#1250 — the in-loop VISUAL judge as its own agent.
 *
 * `resolveSessionAgents` chains `visualEval ← evaluation ← coding`, and the dispatch
 * filled only the first two slots, so on a lane whose coding provider has no vision
 * path (an OpenAI coding lane) the score half of every visual round was recorded as
 * skipped (#1248). The dispatch now takes an OPTIONAL
 * `visualEvalAgent` — a vision provider, a model, and that provider's own key when
 * the caller resolves keys itself — and hands it to the third slot as its own agent
 * with its own `routeOverride`, never the coding agent's. Absent, the chain is
 * byte-for-byte today's: every existing caller sees no change. Captured at the
 * session seam, where the real agents are handed through.
 */
import { describe, expect, it, vi } from "vitest";
import type { GenerationResult } from "../harness/result-types.js";
import type { SessionAgents } from "../harness/coding/init-session.js";

const ASSEMBLED: GenerationResult = {
  compiledCode: "export default function C(){return null;}",
  sourceCode: "export default function C(){return null;}",
  tokens: { input: 1, output: 1, total: 2 },
  generationTimeMs: 1,
  turnsUsed: 1,
  passesUsed: 1,
  selfCheckPassed: true,
  needsBackgroundImprovement: false,
  timing: { totalMs: 1 },
  breakdown: {
    phases: { impl: 1, patch: 0, evalFix: 0, scaffold: 0, fill: 0 },
    outcomes: { pass: 1, patchInvalid: 0, selfCheckFail: 0, diffFail: 0 },
    evalRounds: 0,
    llmMs: 1,
    evalLlmMs: 0,
    toolMs: 0,
    evalMs: 0,
    codingMs: 1,
    setupMs: 0,
  },
};

/** The agents each dispatch resolved — captured at the session seam. */
const captured: SessionAgents[] = [];

vi.mock("../harness/coding/init-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../harness/coding/init-session.js")>();
  return {
    ...actual,
    initSession: vi.fn(async (input: Parameters<typeof actual.initSession>[0]) => {
      captured.push(input.agents);
      return { harness: input.harness };
    }),
  };
});
vi.mock("../harness/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../harness/index.js")>();
  return {
    ...actual,
    runHarness: vi.fn(async () => ({ ok: true, finalSource: ASSEMBLED.sourceCode, finalCompiled: ASSEMBLED.compiledCode })),
  };
});
vi.mock("../harness/coding/assemble-result.js", () => ({
  assembleGenerationResult: vi.fn(async (): Promise<GenerationResult> => ASSEMBLED),
}));

const { dispatchGeneration } = await import("./generation-dispatch.js");

const OPENAI_LANE = {
  provider: "openai" as const,
  model: "gpt-6-luna",
  userPrompt: "A dashboard for the team",
  tools: [],
  enableRuntimeRender: false,
  shellType: "fullscreen" as const,
  screen: "desktop" as const,
};

describe("the in-loop visual judge as its own agent (ggui#1250)", () => {
  it("absent (every existing caller) → today's chain: the visual judge IS the evaluation agent, on the coding provider", async () => {
    captured.length = 0;
    await dispatchGeneration(OPENAI_LANE);
    expect(captured).toHaveLength(1);
    const agents = captured[0]!;
    expect(agents.coding.provider).toBe("openai");
    expect(agents.visualEval).toBe(agents.evaluation);
    expect(agents.visualEval.provider).toBe("openai");
  });

  it("named → the third slot is its own agent: the vision provider, the model, and its OWN key route — the coding agent's is untouched", async () => {
    captured.length = 0;
    await dispatchGeneration({
      ...OPENAI_LANE,
      routeOverride: { apiKey: "sk-openai-lane" },
      visualEvalAgent: { provider: "anthropic", model: "claude-haiku-4-5", apiKey: "sk-anthropic-pool" },
    });
    const agents = captured[0]!;
    expect(agents.coding.provider).toBe("openai");
    expect(agents.coding.routeOverride).toEqual({ apiKey: "sk-openai-lane" });
    expect(agents.evaluation.provider).toBe("openai");
    expect(agents.visualEval).not.toBe(agents.evaluation);
    expect(agents.visualEval.provider).toBe("anthropic");
    expect(agents.visualEval.model).toBe("claude-haiku-4-5");
    expect(agents.visualEval.routeOverride).toEqual({ apiKey: "sk-anthropic-pool" });
  });

  it("named without a key → the agent carries no route override (the router resolves the provider's key itself)", async () => {
    captured.length = 0;
    await dispatchGeneration({ ...OPENAI_LANE, visualEvalAgent: { provider: "google", model: "gemini-3-flash" } });
    const agents = captured[0]!;
    expect(agents.visualEval.provider).toBe("google");
    expect(agents.visualEval).not.toHaveProperty("routeOverride");
  });
});
