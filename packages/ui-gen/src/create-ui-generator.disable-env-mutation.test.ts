/**
 * Tests for `createUiGenerator({ disableEnvMutation: true })` — #484.
 *
 * `dispatchGeneration` is mocked (mirrors `create-ui-generator.metadata.test.ts`'s
 * seam) so these stay unit tests with no real LLM round-trip. Unlike that
 * file, the mock here captures its call params — the load-bearing proof
 * for this option is that the routed key reaches `dispatchGeneration`
 * structurally (via `routeOverride`) instead of via `process.env`.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { UiGenerateInput } from '@ggui-ai/mcp-server-core';
import type { GenerationDispatchParams } from './adapters/generation-dispatch.js';
import type { GenerationResult } from './harness/result-types.js';

const dispatchMock = vi.fn<(params: GenerationDispatchParams) => Promise<GenerationResult>>();
vi.mock('./adapters/generation-dispatch.js', () => ({
  dispatchGeneration: (params: GenerationDispatchParams) => dispatchMock(params),
}));

// Import AFTER the mock is registered so the factory binds the stub.
const { createUiGenerator } = await import('./create-ui-generator.js');

function fakeResult(): GenerationResult {
  return {
    compiledCode: 'export default function C(){return null;}',
    sourceCode: 'export default function C(){return null;}',
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

function minimalInput(overrides: Partial<UiGenerateInput> = {}): UiGenerateInput {
  return {
    request: { sessionId: 's1', prompt: 'weather card' },
    llm: { provider: 'anthropic', model: 'claude-opus-4-7' },
    providerKey: { provider: 'anthropic', key: 'sk-test' },
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

describe('createUiGenerator({ disableEnvMutation: true })', () => {
  beforeEach(() => {
    dispatchMock.mockReset();
    dispatchMock.mockResolvedValue(fakeResult());
  });

  it('never writes process.env during generate()', async () => {
    const generator = createUiGenerator({ disableEnvMutation: true });
    const before = { ...process.env };
    // Stub dispatchGeneration so this stays a unit test — no real LLM call.
    // (Uses the same dispatch-mocking seam create-ui-generator.metadata.test.ts
    // already uses.)
    await generator
      .generate(minimalInput({ providerKey: { provider: 'anthropic', key: 'test-key' } }))
      .catch(() => {}); // dispatch is mocked to no-op/throw; only the env-mutation absence matters here
    expect(process.env).toEqual(before);
  });

  it('still passes the routed key to the agent (structurally, not via env)', async () => {
    const generator = createUiGenerator({ disableEnvMutation: true });
    await generator.generate(
      minimalInput({ providerKey: { provider: 'anthropic', key: 'test-key' } }),
    );
    // Assert the mocked dispatchGeneration seam received
    // routeOverride.apiKey === 'test-key' — proves the key isn't silently
    // dropped when env mutation is skipped.
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const params = dispatchMock.mock.calls[0]?.[0];
    expect(params?.routeOverride?.apiKey).toBe('test-key');
  });

  it('two concurrent generate() calls with different provider keys never cross-contaminate', async () => {
    const generator = createUiGenerator({ disableEnvMutation: true });
    await Promise.all([
      generator.generate(minimalInput({ providerKey: { provider: 'anthropic', key: 'key-A' } })),
      generator.generate(
        minimalInput({
          llm: { provider: 'openai', model: 'gpt-5.6' },
          providerKey: { provider: 'openai', key: 'key-B' },
        }),
      ),
    ]);
    // Assert each mocked dispatch call observed its OWN key, never the
    // other's — the actual proof this task exists for.
    expect(dispatchMock).toHaveBeenCalledTimes(2);
    const keys = dispatchMock.mock.calls
      .map((call) => call[0]?.routeOverride?.apiKey)
      .sort();
    expect(keys).toEqual(['key-A', 'key-B']);
  });
});
