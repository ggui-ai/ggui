/**
 * Gate for the 2026-09-09 RED (main `7135acc8c`, OSS E2E provider matrix:
 * every cold generation `Cannot read properties of undefined (reading
 * 'input')`; bench runner `reading 'length'`).
 *
 * Root cause: `dispatchGeneration` spread the UN-AWAITED promise returned
 * by the async `assembleGenerationResult` — `{ ...promise }` is `{}`, so
 * every consumer lost `compiledCode` / `tokens`. The sibling unit suites
 * never saw it because they mock `dispatchGeneration` wholesale
 * (`create-ui-generator.metadata.test.ts`) — the bug sat INSIDE the
 * mocked module. This test drives the REAL `dispatchGeneration` with only
 * its inner seams stubbed (session init, harness run, result assembly), so
 * a dropped `await` on the tail is caught here rather than by the E2E lane.
 *
 * Receipt: RED on the pre-fix blob (`git show origin/main:…` at
 * `7135acc8c`), GREEN after — see the ledger row.
 */
import { describe, expect, it, vi } from "vitest";
import type { GenerationResult } from "../harness/result-types.js";

const ASSEMBLED: GenerationResult = {
  compiledCode: "export default function C(){return null;}",
  sourceCode: "export default function C(){return null;}",
  tokens: { input: 4321, output: 87, total: 4408 },
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

// Session init: the only field the dispatch tail reads before the (stubbed)
// run is `session.harness.process.mode` (task-runner construction), so the
// stub carries the real harness through and nothing else.
vi.mock("../harness/coding/init-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../harness/coding/init-session.js")>();
  return {
    ...actual,
    initSession: vi.fn(async (input: Parameters<typeof actual.initSession>[0]) => ({
      harness: input.harness,
    })),
  };
});

// Harness run: no LLM round-trip — hand back a finished source.
vi.mock("../harness/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../harness/index.js")>();
  return {
    ...actual,
    runHarness: vi.fn(async () => ({
      ok: true,
      finalSource: ASSEMBLED.sourceCode,
      finalCompiled: ASSEMBLED.compiledCode,
    })),
  };
});

// Result assembly: async in production — the stub stays async on purpose;
// the property under test is that the dispatch tail resolves it.
vi.mock("../harness/coding/assemble-result.js", () => ({
  assembleGenerationResult: vi.fn(async (): Promise<GenerationResult> => ASSEMBLED),
}));

const { dispatchGeneration } = await import("./generation-dispatch.js");

describe("dispatchGeneration resolves the assembled result (never spreads the promise)", () => {
  it("default path: the awaited return carries compiledCode + tokens and is not thenable", async () => {
    const result = await dispatchGeneration({
      provider: "claude",
      model: "claude-haiku-4-5",
      userPrompt: "A weather card for Seoul",
      tools: [],
      enableRuntimeRender: false,
    });
    expect("then" in result).toBe(false);
    expect(result).toEqual(ASSEMBLED);
    if (!("compiledCode" in result)) throw new Error("adapter-result shape on the dispatch path");
    expect(result.compiledCode.length).toBeGreaterThan(0);
    expect(result.tokens.input).toBe(4321);
  });

  it("free-design path: the arm record is stamped ON the resolved result", async () => {
    const result = await dispatchGeneration({
      provider: "claude",
      model: "claude-haiku-4-5",
      userPrompt: "A weather card for Seoul",
      tools: [],
      enableRuntimeRender: false,
      designMode: "free",
      canvas: "md",
    });
    expect(result).toEqual({ ...ASSEMBLED, designMode: "free", canvas: "md" });
  });
});
