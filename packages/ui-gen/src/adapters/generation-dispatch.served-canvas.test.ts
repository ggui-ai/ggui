/**
 * ggui#1117 — the served generation is judged for the canvas it renders on.
 *
 * The axis checks read `harness.canvas` (`run-coding-turn.ts` hands it to
 * `runAxisChecks`), and the harness input carried `params.canvas` ONLY. The
 * serving runtime passes no canvas and runs the default `constrained` mode, so
 * every served generation was checked without one — `universal.root_width_cap`
 * stood down on every served card (an operator's read of eight `axisCheckTrace`
 * lines on staging, 2026-09-21: no `canvas` key anywhere). The dispatch now
 * derives the check-side canvas from shell × screen in every design mode; an
 * explicit `params.canvas` still wins; the constrained system prompt ignores
 * the canvas (the design-mode pin's INVARIANT 1), so the prompt digests do not
 * move. RED before the derivation, GREEN after.
 */
import { describe, expect, it, vi } from "vitest";
import type { GenerationResult } from "../harness/result-types.js";
import { canvasForRendering } from "../design-mode.js";
import { buildSystemPrompt } from "../harness/runtime.js";

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

/** The harness each dispatch built — captured at the session seam, where the real one is handed through. */
const captured: Array<{ canvas?: string; designMode?: string }> = [];

vi.mock("../harness/coding/init-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../harness/coding/init-session.js")>();
  return {
    ...actual,
    initSession: vi.fn(async (input: Parameters<typeof actual.initSession>[0]) => {
      captured.push({ canvas: input.harness.canvas, designMode: input.harness.designMode });
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

describe("the served generation is checked for the canvas it renders on (ggui#1117)", () => {
  it("default (constrained) dispatch with shell × screen and no canvas → the harness carries the derived canvas", async () => {
    captured.length = 0;
    await dispatchGeneration({
      provider: "claude",
      model: "claude-haiku-4-5",
      userPrompt: "A dashboard for the team",
      tools: [],
      enableRuntimeRender: false,
      shellType: "fullscreen",
      screen: "desktop",
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.canvas).toBe(canvasForRendering("fullscreen", "desktop"));
    // The harness defaults the mode itself — the served path is constrained.
    expect(captured[0]!.designMode).toBe("constrained");
  });

  it("an explicit canvas still wins over the derivation", async () => {
    captured.length = 0;
    await dispatchGeneration({
      provider: "claude",
      model: "claude-haiku-4-5",
      userPrompt: "A dashboard for the team",
      tools: [],
      enableRuntimeRender: false,
      shellType: "fullscreen",
      screen: "desktop",
      canvas: "md",
    });
    expect(captured[0]!.canvas).toBe("md");
  });

  it("the constrained system prompt is byte-identical with and without the derived canvas (INVARIANT 1)", () => {
    const req = "A dashboard for the team";
    const derived = canvasForRendering("fullscreen", "desktop");
    const without = buildSystemPrompt(req, "fullscreen", "desktop");
    const withCanvas = buildSystemPrompt(req, "fullscreen", "desktop", undefined, undefined, undefined, undefined, derived);
    expect(withCanvas).toBe(without);
  });
});
