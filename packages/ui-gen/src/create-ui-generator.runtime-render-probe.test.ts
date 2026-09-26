/**
 * ggui#1380 C2 — the runtime-render check is built ONCE per generator from
 * `CreateUiGeneratorOptions.runtimeRenderProbe` (the probe's wall-clock
 * bound, worker heap and concurrency) and the SAME instance reaches every
 * `dispatchGeneration` the generator makes. The concurrency cap lives on
 * that instance, so it can only bound anything if the instance outlives one
 * generation — a check built per dispatch would give every generation K
 * free slots and cap nothing. `enableRuntimeRender: false` builds no check
 * and passes none. `dispatchGeneration` and the check factory are mocked
 * and their calls captured, as in create-ui-generator.fixture-props.test.ts.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { UiGenerateInput } from '@ggui-ai/mcp-server-core';
import type { GenerationResult } from './harness/result-types.js';
import type { GenerationDispatchParams } from './adapters/generation-dispatch.js';
import type { RuntimeRenderCheck } from './harness/types-public.js';
import type { RuntimeRenderProbeConfig } from './harness/check/runtime-render/adapter.js';

const captured: GenerationDispatchParams[] = [];
const factory = vi.hoisted(() => ({ configs: [] as (RuntimeRenderProbeConfig | undefined)[] }));
vi.mock('./harness/check/runtime-render/adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./harness/check/runtime-render/adapter.js')>();
  return {
    ...actual,
    createRuntimeRenderCheck: (config?: RuntimeRenderProbeConfig): RuntimeRenderCheck => {
      factory.configs.push(config);
      return { id: `stub-${factory.configs.length}`, run: async () => ({ status: 'not-applicable', issues: [] }) };
    },
  };
});
vi.mock('./adapters/generation-dispatch.js', () => ({
  dispatchGeneration: (params: GenerationDispatchParams): Promise<GenerationResult> => {
    captured.push(params);
    return Promise.resolve({
      compiledCode: 'export default function C(){return null;}',
      sourceCode: 'export default function C(){return null;}',
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

const { createUiGenerator } = await import('./create-ui-generator.js');

function fakeInput(): UiGenerateInput {
  return {
    request: { sessionId: 's1', prompt: 'welcome card' },
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
  };
}

describe('createUiGenerator — one runtime-render check per generator (ggui#1380 C2)', () => {
  beforeEach(() => {
    captured.length = 0;
    factory.configs.length = 0;
  });

  it('builds the check ONCE with runtimeRenderProbe verbatim, and the same instance reaches every dispatch', async () => {
    const probe = { timeoutMs: 10_000, heapMb: 256, maxConcurrent: 2 };
    const generator = createUiGenerator({ disableEnvMutation: true, enableRuntimeRender: true, runtimeRenderProbe: probe });
    await generator.generate(fakeInput());
    await generator.generate(fakeInput());
    expect(factory.configs).toEqual([probe]);
    expect(captured).toHaveLength(2);
    const [first, second] = captured;
    if (first === undefined || second === undefined) throw new Error('two dispatches expected');
    expect(first.runtimeRender).toBeDefined();
    expect(first.runtimeRender).toBe(second.runtimeRender);
    expect(first.enableRuntimeRender).toBe(true);
  });

  it('omitted config ⇒ still one check per generator, built with no config; enableRuntimeRender false ⇒ no check, no key', async () => {
    await createUiGenerator({ disableEnvMutation: true, enableRuntimeRender: true }).generate(fakeInput());
    await createUiGenerator({ disableEnvMutation: true, enableRuntimeRender: false }).generate(fakeInput());
    expect(factory.configs).toEqual([undefined]);
    expect(captured).toHaveLength(2);
    const [on, off] = captured;
    if (on === undefined || off === undefined) throw new Error('two dispatches expected');
    expect(on.runtimeRender).toBeDefined();
    expect('runtimeRender' in off).toBe(false);
    expect(off.enableRuntimeRender).toBe(false);
  });
});
