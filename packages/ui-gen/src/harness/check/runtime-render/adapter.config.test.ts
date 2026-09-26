// @vitest-environment node
//
// ggui#1380 C2 — `createRuntimeRenderCheck(config)` threads the probe's
// bounds to `runRenderCheck` as `{ bounds }`, and `DEFAULT_RUNTIME_RENDER_CHECK`
// threads nothing (undefined ⇒ the host's defaults) so every existing
// consumer is identical. `runRenderCheck` is stubbed at its module seam and
// its options captured.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataContract } from '@ggui-ai/protocol';
import type { RenderCheckResult, RunRenderCheckInput, RunRenderCheckOptions } from './render-check.js';

const captured = vi.hoisted((): { options: (RunRenderCheckOptions | undefined)[] } => ({ options: [] }));

vi.mock('./render-check.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./render-check.js')>();
  return {
    ...actual,
    runRenderCheck: async (
      _input: RunRenderCheckInput,
      options?: RunRenderCheckOptions,
    ): Promise<RenderCheckResult> => {
      captured.options.push(options);
      return { ok: true, issues: [], stats: { actionsChecked: 0, streamsChecked: 0, renderMs: 1 } };
    },
  };
});

const { DEFAULT_RUNTIME_RENDER_CHECK, createRuntimeRenderCheck } = await import('./adapter.js');

const CONTRACT: DataContract = { propsSpec: { properties: {} } };
const INPUT = { sourceCode: 'export default function C() { return null; }', compiledCode: 'c', contract: CONTRACT };

describe('createRuntimeRenderCheck — bounds reach runRenderCheck (ggui#1380 C2)', () => {
  beforeEach(() => {
    captured.options.length = 0;
  });

  it('{ timeoutMs: 10 000, heapMb: 256 } ⇒ runRenderCheck(input, { bounds: { timeoutMs: 10 000, heapMb: 256 } })', async () => {
    const check = createRuntimeRenderCheck({ timeoutMs: 10_000, heapMb: 256 });
    const outcome = await check.run(INPUT);
    expect(outcome.status).toBe('ran');
    expect(captured.options).toEqual([{ bounds: { timeoutMs: 10_000, heapMb: 256 } }]);
  });

  it('only one bound set ⇒ only that key is threaded', async () => {
    await createRuntimeRenderCheck({ timeoutMs: 5_000 }).run(INPUT);
    expect(captured.options).toEqual([{ bounds: { timeoutMs: 5_000 } }]);
  });

  it('DEFAULT_RUNTIME_RENDER_CHECK threads no bounds — undefined, the host decides', async () => {
    await DEFAULT_RUNTIME_RENDER_CHECK.run(INPUT);
    expect(captured.options).toEqual([undefined]);
    expect(DEFAULT_RUNTIME_RENDER_CHECK.id).toBe('runtime-render');
  });

  it('createRuntimeRenderCheck() with no config ≡ the default: no bounds, same id', async () => {
    const check = createRuntimeRenderCheck();
    await check.run(INPUT);
    expect(captured.options).toEqual([undefined]);
    expect(check.id).toBe(DEFAULT_RUNTIME_RENDER_CHECK.id);
  });

  it('maxConcurrent alone threads no bounds', async () => {
    await createRuntimeRenderCheck({ maxConcurrent: 2 }).run(INPUT);
    expect(captured.options).toEqual([undefined]);
  });

  it('a bad bound is refused at construction, not at the first probe: timeoutMs 0 / NaN, heapMb 0 → RangeError', () => {
    expect(() => createRuntimeRenderCheck({ timeoutMs: 0 })).toThrow(RangeError);
    expect(() => createRuntimeRenderCheck({ timeoutMs: NaN })).toThrow(RangeError);
    expect(() => createRuntimeRenderCheck({ heapMb: 0 })).toThrow(RangeError);
  });
});
