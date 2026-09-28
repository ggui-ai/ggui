/**
 * ggui#1513 — `createUiGenerator` hands the harness the same evaluation
 * switches its options carry, at every effort level. The effort dials
 * rewrite `maxRounds` and `passThreshold`, never `enabled`, so
 * `runsInLoopEvaluation(generatorOptions)` answers what the harness
 * decides for every generation of that generator. A dial that ever set
 * `enabled` would split a host's reading from the harness's gate, and
 * this pin fails first. `dispatchGeneration` is mocked and its params
 * captured.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { APP_GENERATION_PROFILE_EFFORTS, type AppGenerationProfileEffort } from '@ggui-ai/protocol';
import type { UiGenerateInput } from '@ggui-ai/mcp-server-core';
import type { GenerationResult } from './harness/result-types.js';
import type { GenerationDispatchParams } from './adapters/generation-dispatch.js';
import type { CreateUiGeneratorOptions } from './create-ui-generator.js';
import { inLoopEvaluation } from './harness/in-loop-evaluation.js';

const captured: GenerationDispatchParams[] = [];
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

function input(effort: AppGenerationProfileEffort | undefined): UiGenerateInput {
  return {
    request: { sessionId: 's1', prompt: 'a welcome card' },
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
    ...(effort !== undefined ? { profile: { effort } } : {}),
  };
}

const SWITCH_SETS: ReadonlyArray<Pick<CreateUiGeneratorOptions, 'evaluation' | 'visualEvaluation' | 'qualityConfig'>> = [
  {},
  { evaluation: { enabled: true, passThreshold: 70 } },
  { evaluation: { enabled: false, passThreshold: 70 } },
  { visualEvaluation: { enabled: true } },
  { qualityConfig: { quality: 'fast', visualEval: true, maxCostPerGeneration: 3 } },
  { evaluation: { enabled: true, passThreshold: 70 }, visualEvaluation: { enabled: false } },
];

const EFFORTS: ReadonlyArray<AppGenerationProfileEffort | undefined> = [undefined, ...APP_GENERATION_PROFILE_EFFORTS];

describe('createUiGenerator — the evaluation switches reach the harness unchanged (ggui#1513)', () => {
  beforeEach(() => {
    captured.length = 0;
  });

  it('at every effort level, including none, the dispatched params turn on exactly the legs the options do', async () => {
    let checked = 0;
    for (const switches of SWITCH_SETS) {
      const gen = createUiGenerator({ disableEnvMutation: true, ...switches });
      for (const effort of EFFORTS) {
        await gen.generate(input(effort));
        const dispatched = captured.at(-1);
        if (dispatched === undefined) throw new Error('dispatchGeneration was not called');
        expect(inLoopEvaluation(dispatched)).toEqual(inLoopEvaluation(switches));
        checked += 1;
      }
    }
    expect(checked).toBe(SWITCH_SETS.length * EFFORTS.length);
  });
});
