// Pins (ggui#1059): the `effort` reader table and its application in
// `createUiGenerator` — dials only, absent ⇒ the deployment's options untouched.
import { APP_GENERATION_PROFILE_EFFORTS } from "@ggui-ai/protocol";
import type { UiGenerateInput } from "@ggui-ai/mcp-server-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationDispatchParams } from "./adapters/generation-dispatch.js";
import type { GenerationResult } from "./harness/result-types.js";
import { EFFORT_DIALS, effortDials } from "./effort.js";

const captured: GenerationDispatchParams[] = [];
vi.mock("./adapters/generation-dispatch.js", () => ({
  dispatchGeneration: (params: GenerationDispatchParams): Promise<GenerationResult> => {
    captured.push(params);
    return Promise.resolve({
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
    });
  },
}));

const { createUiGenerator } = await import("./create-ui-generator.js");

const VISUAL = { enabled: true, cssTokens: ":root{--ggui-color-onContainer:#fff}", canvases: ["xs-chat-card" as const] };
const DEPLOYMENT = { disableEnvMutation: true, maxAttempts: 6, maxEvalRounds: 2, visualEvaluation: VISUAL } as const;

function input(profile?: UiGenerateInput["profile"]): UiGenerateInput {
  return {
    request: { sessionId: "s1", prompt: "welcome card with quick replies" },
    llm: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
    providerKey: { provider: "anthropic", key: "sk-test" },
    blueprints: { async list() { return []; }, async get() { return null; } },
    ...(profile !== undefined ? { profile } : {}),
  };
}

const dialKeys = (p: GenerationDispatchParams) => ({
  maxAttempts: p.maxAttempts,
  maxEvalRounds: p.maxEvalRounds,
  evaluation: p.evaluation,
  visualEvaluation: p.visualEvaluation,
});

describe("effort reader table", () => {
  it("names every level once and is monotone: no dial weakens as the level rises", () => {
    const levels = APP_GENERATION_PROFILE_EFFORTS.map((e) => EFFORT_DIALS[e]);
    expect(Object.keys(EFFORT_DIALS).sort()).toEqual([...APP_GENERATION_PROFILE_EFFORTS].sort());
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]!.maxAttempts).toBeGreaterThanOrEqual(levels[i - 1]!.maxAttempts);
      expect(levels[i]!.maxEvalRounds).toBeGreaterThanOrEqual(levels[i - 1]!.maxEvalRounds);
      expect(levels[i]!.selfEvalPassThreshold).toBeGreaterThanOrEqual(levels[i - 1]!.selfEvalPassThreshold);
    }
    expect(effortDials(undefined)).toBeUndefined();
  });
});

describe("createUiGenerator — effort dials", () => {
  beforeEach(() => {
    captured.length = 0;
  });

  it("absent ⇒ the deployment's options reach dispatch untouched — byte-identical to a run with no profile", async () => {
    await createUiGenerator(DEPLOYMENT).generate(input());
    await createUiGenerator(DEPLOYMENT).generate(input({ styling: "dense" }));
    expect(captured).toHaveLength(2);
    expect(dialKeys(captured[1]!)).toEqual(dialKeys(captured[0]!));
    expect(dialKeys(captured[0]!)).toEqual({ maxAttempts: 6, maxEvalRounds: 2, evaluation: undefined, visualEvaluation: VISUAL });
  });

  it("a named level's dials override the deployment's options for that generation — and never touch the prompt", async () => {
    await createUiGenerator(DEPLOYMENT).generate(input());
    await createUiGenerator(DEPLOYMENT).generate(input({ effort: "high" }));
    await createUiGenerator(DEPLOYMENT).generate(input({ effort: "ultra" }));
    const [none, high, ultra] = captured;
    expect(dialKeys(high!)).toEqual({ maxAttempts: 8, maxEvalRounds: 3, evaluation: undefined, visualEvaluation: { ...VISUAL, passThreshold: 75 } });
    expect(dialKeys(ultra!)).toEqual({ maxAttempts: 12, maxEvalRounds: 4, evaluation: undefined, visualEvaluation: { ...VISUAL, passThreshold: 85 } });
    expect(high!.userPrompt).toBe(none!.userPrompt);
    expect(ultra!.userPrompt).toBe(none!.userPrompt);
  });

  it("a level does not switch on a visual round the deployment left off", async () => {
    await createUiGenerator({ disableEnvMutation: true }).generate(input({ effort: "xhigh" }));
    expect(captured[0]!.visualEvaluation).toBeUndefined();
    expect(captured[0]!.maxAttempts).toBe(10);
    expect(captured[0]!.maxEvalRounds).toBe(3);
  });
});
