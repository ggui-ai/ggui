import { Console } from 'node:console';
import { PassThrough } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeneratorAdapter, type GenerateParams } from '@ggui-ai/ui-gen/adapters';
import type { AdapterMode, AdapterResult, ProviderName } from '@ggui-ai/ui-gen/adapters/types';
import { BenchmarkRunner } from './runner';
import type { BenchmarkCommit, BenchmarkVariant } from './types';
import {
  currentVariantTag,
  installVariantConsoleTag,
  runWithVariantTag,
  variantTagPrefix,
} from './variant-log-tag';

/** A real Console over two streams, so what a wrapped method wrote can be read back as text. */
function capturedConsole(): { console: Console; lines: () => string[] } {
  const out = new PassThrough();
  const chunks: string[] = [];
  out.on('data', (c: Buffer) => chunks.push(c.toString('utf8')));
  const c = new Console({ stdout: out, stderr: out });
  return { console: c, lines: () => chunks.join('').split('\n').filter((l) => l.length > 0) };
}

const restores: Array<() => void> = [];
afterEach(() => {
  for (const r of restores.splice(0)) r();
  vi.restoreAllMocks();
});

describe('variant-log-tag', () => {
  it('leaves a line written outside any variant context untouched', () => {
    const cap = capturedConsole();
    restores.push(installVariantConsoleTag(cap.console));
    cap.console.log('[simple] DONE | 100ms');
    expect(cap.lines()).toEqual(['[simple] DONE | 100ms']);
  });

  it('tags each concurrently running variant with its own id, across awaits', async () => {
    const cap = capturedConsole();
    restores.push(installVariantConsoleTag(cap.console));
    await Promise.all([
      runWithVariantTag('openai-fast', async () => {
        cap.console.log('a1');
        await sleep(15);
        cap.console.warn('a2');
      }),
      runWithVariantTag('gpt-6-luna', async () => {
        await sleep(5);
        cap.console.log('b1');
        await sleep(20);
        cap.console.error('b2');
      }),
    ]);
    const lines = cap.lines();
    expect(lines).toHaveLength(4);
    expect(lines.filter((l) => l.endsWith('a1') || l.endsWith('a2'))).toEqual([
      `${variantTagPrefix('openai-fast')}a1`,
      `${variantTagPrefix('openai-fast')}a2`,
    ]);
    expect(lines.filter((l) => l.endsWith('b1') || l.endsWith('b2'))).toEqual([
      `${variantTagPrefix('gpt-6-luna')}b1`,
      `${variantTagPrefix('gpt-6-luna')}b2`,
    ]);
    expect(currentVariantTag()).toBeUndefined();
  });

  it('tags every line of a multi-line message, so a line reader still attributes each', async () => {
    const cap = capturedConsole();
    restores.push(installVariantConsoleTag(cap.console));
    await runWithVariantTag('claude-fast', async () => {
      cap.console.log('[runtime-probe] claude-fast × chat: FAIL\n    [runtime-probe FAIL] contract:runtime:x');
    });
    expect(cap.lines()).toEqual([
      '[v:claude-fast] [runtime-probe] claude-fast × chat: FAIL',
      '[v:claude-fast]     [runtime-probe FAIL] contract:runtime:x',
    ]);
  });

  it('installs once per console — a second install does not tag twice — and restore removes it', async () => {
    const cap = capturedConsole();
    const restore = installVariantConsoleTag(cap.console);
    expect(installVariantConsoleTag(cap.console)).toBe(restore);
    await runWithVariantTag('v1', async () => cap.console.log('once'));
    restore();
    await runWithVariantTag('v1', async () => cap.console.log('after restore'));
    expect(cap.lines()).toEqual(['[v:v1] once', 'after restore']);
  });
});

/** Adapter stub: available, never generates — the unknown-slug path returns before generate(). */
class MockAdapter extends GeneratorAdapter {
  readonly provider: ProviderName = 'claude';
  readonly mode: AdapterMode = 'raw';
  readonly displayName = 'Mock';
  isAvailable(): boolean {
    return true;
  }
  async generate(_params: GenerateParams): Promise<AdapterResult> {
    throw new Error('MockAdapter.generate should not be invoked — the unknown-slug path returns first.');
  }
}

describe('BenchmarkRunner — each cell runs inside its variant tag (ggui#1282)', () => {
  it('two variants of one process, run concurrently, each write lines carrying their own tag', async () => {
    const written: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: Parameters<Console['log']>) => {
      written.push(args.map(String).join(' '));
    });
    restores.push(installVariantConsoleTag(console));
    const commit: BenchmarkCommit = {
      id: 'weather-card',
      name: 'Weather Card',
      description: '',
      complexity: 'simple',
      prompt: 'prompt',
      contract: {},
    };
    const variant = (id: string): BenchmarkVariant => ({
      id,
      sdkName: 'claude',
      tier: 'fast',
      modelId: 'anthropic/claude-haiku-4-5',
      generator: 'ui-gen-future-experimental-llm',
    });
    const runner = new BenchmarkRunner({ concurrency: 2 });
    runner.registerAdapter(new MockAdapter({}));
    await runner.run({ variants: [variant('arm-a'), variant('arm-b')], commits: [commit] });
    const skipLines = written.filter((l) => l.includes(': SKIP — '));
    expect(skipLines).toHaveLength(2);
    expect(skipLines.find((l) => l.includes('arm-a × weather-card'))?.startsWith('[v:arm-a] ')).toBe(true);
    expect(skipLines.find((l) => l.includes('arm-b × weather-card'))?.startsWith('[v:arm-b] ')).toBe(true);
  });
});
