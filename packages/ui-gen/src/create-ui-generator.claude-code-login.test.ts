/**
 * ggui#1185 (B) — the route decision reaches the router's seam.
 *
 * `resolveRoute` (Layer 1) turns the `claude-code-login` sentinel
 * credential into `auth: 'claude-code-login'` with every provider key
 * cleared. The generator must carry that decision onto
 * `routeOverride.claudeCodeLogin`, in BOTH env modes — with the default
 * env mutation there is no key to write into `process.env`, so the flag
 * is the ONLY way the decision reaches `createAgent`/`createVisionAgent`
 * (`ClaudeCodeLoginAgent` is selected by it; every agent the harness
 * builds takes the same decision). `dispatchGeneration` is mocked, as in
 * `create-ui-generator.disable-env-mutation.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiGenerateInput } from "@ggui-ai/mcp-server-core";
import type { GenerationDispatchParams } from "./adapters/generation-dispatch.js";
import type { GenerationResult } from "./harness/result-types.js";

const dispatchMock = vi.fn<(params: GenerationDispatchParams) => Promise<GenerationResult>>();
vi.mock("./adapters/generation-dispatch.js", () => ({
  dispatchGeneration: (params: GenerationDispatchParams) => dispatchMock(params),
}));

const { createUiGenerator } = await import("./create-ui-generator.js");

function fakeResult(): GenerationResult {
  return {
    compiledCode: "export default function C(){return null;}",
    sourceCode: "export default function C(){return null;}",
    tokens: { input: 10, output: 5, total: 15 },
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
}

function loginInput(overrides: Partial<UiGenerateInput> = {}): UiGenerateInput {
  return {
    request: { sessionId: "s1", prompt: "weather card" },
    llm: { provider: "anthropic", model: "claude-opus-4-7" },
    providerKey: { provider: "anthropic", key: "claude-code-login" },
    blueprints: {
      async list() {
        return [];
      },
      async get() {
        return null;
      },
    },
    ...overrides,
  };
}

beforeEach(() => {
  dispatchMock.mockReset();
  dispatchMock.mockResolvedValue(fakeResult());
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-a-key-that-must-not-win");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createUiGenerator — the claude-code-login route decision reaches routeOverride (ggui#1185)", () => {
  it("disableEnvMutation: true — routeOverride.claudeCodeLogin is true and no apiKey rides along", async () => {
    const generator = createUiGenerator({ disableEnvMutation: true });
    await generator.generate(loginInput());
    const params = dispatchMock.mock.calls[0]?.[0];
    expect(params?.routeOverride?.claudeCodeLogin).toBe(true);
    expect(params?.routeOverride?.apiKey).toBeUndefined();
  });

  it("default env mode — the flag is the ONLY carrier (nothing is written to process.env), so it is still set", async () => {
    const generator = createUiGenerator();
    await generator.generate(loginInput());
    const params = dispatchMock.mock.calls[0]?.[0];
    expect(params?.routeOverride?.claudeCodeLogin).toBe(true);
    expect(params?.routeOverride?.apiKey).toBeUndefined();
    // The login path never leaves a key in the process for the binary to prefer.
    expect(process.env["ANTHROPIC_API_KEY"]).toBe("sk-ant-a-key-that-must-not-win");
  });

  it("a real key leaves the flag unset — BYOK stays the default path", async () => {
    const generator = createUiGenerator({ disableEnvMutation: true });
    await generator.generate(
      loginInput({ providerKey: { provider: "anthropic", key: "sk-real" } })
    );
    const params = dispatchMock.mock.calls[0]?.[0];
    expect(params?.routeOverride?.apiKey).toBe("sk-real");
    expect(params?.routeOverride?.claudeCodeLogin).toBeUndefined();
  });

  it("a non-anthropic route with the login credential is refused at route resolution, before any dispatch", async () => {
    const generator = createUiGenerator({ disableEnvMutation: true });
    const result = await generator.generate(
      loginInput({
        llm: { provider: "openai", model: "gpt-5.6" },
        providerKey: { provider: "openai", key: "claude-code-login" },
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.error.code).toBe("PRODUCTION_FAILED");
    expect(result.error.message).toMatch(/claude-code-login/);
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});
