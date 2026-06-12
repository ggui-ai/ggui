/**
 * Runner → dispatch seam tests.
 *
 * Mocks `dispatchGeneration` and asserts the runner forwards the
 * config it claims to honor — most importantly `visualEvaluation`
 * (the `--visual` flag), which pre-fix was accepted, printed in the
 * config banner, and then silently dropped before dispatch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeneratorAdapter, type GenerateParams } from '@ggui-ai/ui-gen/adapters';
import type {
  AdapterResult,
  AdapterMode,
  ProviderName,
} from '@ggui-ai/ui-gen/adapters/types';

vi.mock('@ggui-ai/ui-gen/adapters/generation-dispatch', () => ({
  dispatchGeneration: vi.fn(async (): Promise<AdapterResult> => ({
    compiledCode: 'export default function C(){}',
    sourceCode: 'export default function C(){}',
    tokens: { input: 10, output: 5, total: 15 },
    generationTimeMs: 42,
    turnsUsed: 1,
  })),
}));

import { dispatchGeneration } from '@ggui-ai/ui-gen/adapters/generation-dispatch';
import { BenchmarkRunner } from './runner';
import type { BenchmarkCommit, BenchmarkVariant } from './types';

class MockAdapter extends GeneratorAdapter {
  readonly provider: ProviderName = 'claude';
  readonly mode: AdapterMode = 'raw';
  readonly displayName = 'Mock';
  isAvailable(): boolean {
    return true;
  }
  async generate(_params: GenerateParams): Promise<AdapterResult> {
    throw new Error('not used — the runner routes through dispatchGeneration');
  }
}

const commit: BenchmarkCommit = {
  id: 'weather-card',
  name: 'Weather Card',
  description: '',
  complexity: 'simple',
  prompt: 'Build a weather card.',
  contract: { intent: 'test' } as BenchmarkCommit['contract'],
  props: { city: 'Berlin' },
};

const variant: BenchmarkVariant = {
  id: 'claude-fast',
  sdkName: 'claude',
  tier: 'fast',
  modelId: 'anthropic/claude-haiku-4-5',
};

beforeEach(() => {
  vi.mocked(dispatchGeneration).mockClear();
});

describe('BenchmarkRunner → dispatchGeneration forwarding', () => {
  it('forwards visualEvaluation (with the commit props as sampleProps) when configured', async () => {
    const runner = new BenchmarkRunner({
      skipEvaluation: true,
      visualEvaluation: {
        enabled: true,
        passThreshold: 60,
        viewport: { width: 800, height: 600 },
      },
    });
    runner.registerAdapter(new MockAdapter({}));

    const report = await runner.run({ variants: [variant], commits: [commit] });
    expect(report.results).toHaveLength(1);
    expect(report.results[0]!.error).toBeUndefined();

    expect(dispatchGeneration).toHaveBeenCalledTimes(1);
    const params = vi.mocked(dispatchGeneration).mock.calls[0]![0];
    expect(params.visualEvaluation).toEqual({
      enabled: true,
      passThreshold: 60,
      viewport: { width: 800, height: 600 },
      sampleProps: { city: 'Berlin' },
    });
  });

  it('omits visualEvaluation when not configured', async () => {
    const runner = new BenchmarkRunner({ skipEvaluation: true });
    runner.registerAdapter(new MockAdapter({}));

    await runner.run({ variants: [variant], commits: [commit] });

    expect(dispatchGeneration).toHaveBeenCalledTimes(1);
    const params = vi.mocked(dispatchGeneration).mock.calls[0]![0];
    expect(params.visualEvaluation).toBeUndefined();
  });
});
