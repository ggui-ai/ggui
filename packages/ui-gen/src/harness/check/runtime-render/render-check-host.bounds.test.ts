// @vitest-environment node
//
// ggui#1380 C2 — the isolated check's subprocess bounds are INPUTS of the
// host, not module constants. A serving deployment runs the probe under its
// own memory and latency budget; the evaluation lane keeps today's values
// byte-for-byte as the defaults. `runSandboxed` is mocked at the package
// seam and its options captured — nothing is spawned here.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxOptions, SandboxResult } from '@ggui-ai/sandbox';

const captured = vi.hoisted((): { options: SandboxOptions[] } => ({ options: [] }));

vi.mock('@ggui-ai/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ggui-ai/sandbox')>();
  return {
    ...actual,
    runSandboxed: async (opts: SandboxOptions): Promise<SandboxResult> => {
      captured.options.push(opts);
      return {
        outcome: 'exit',
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify({
          ok: true,
          issues: [],
          stats: { actionsChecked: 0, streamsChecked: 0, renderMs: 1 },
        }),
        stderr: '',
        durationMs: 1,
        stdoutTruncated: false,
        stderrTruncated: false,
        cwd: '/tmp',
        cwdOwnedBySandbox: true,
        nodeHeapMbApplied: true,
        errorMessage: '',
      };
    },
  };
});

const { DEFAULT_RENDER_CHECK_HOST_BOUNDS, runRenderCheckViaWorker } = await import(
  './render-check-host.js'
);

const INPUT = {
  sourceCode: 'export default function C() { return <div>c</div>; }',
  mockupProps: {},
};

function lastOptions(): SandboxOptions {
  const last = captured.options.at(-1);
  if (last === undefined) throw new Error('runSandboxed was not called');
  return last;
}

describe('runRenderCheckViaWorker — subprocess bounds as inputs (ggui#1380 C2)', () => {
  beforeEach(() => {
    captured.options.length = 0;
  });

  it("no options ⇒ today's values: 30 000 ms, 512 MB heap, 2 000 ms grace", async () => {
    expect(DEFAULT_RENDER_CHECK_HOST_BOUNDS).toEqual({ timeoutMs: 30_000, heapMb: 512, gracePeriodMs: 2_000 });
    await runRenderCheckViaWorker(INPUT);
    expect(captured.options).toHaveLength(1);
    const opts = lastOptions();
    expect(opts.timeoutMs).toBe(30_000);
    expect(opts.nodeHeapMb).toBe(512);
    expect(opts.gracePeriodMs).toBe(2_000);
  });

  it('{ bounds: { timeoutMs: 10 000, heapMb: 256 } } ⇒ threaded; grace stays at 2 000', async () => {
    await runRenderCheckViaWorker(INPUT, { bounds: { timeoutMs: 10_000, heapMb: 256 } });
    const opts = lastOptions();
    expect(opts.timeoutMs).toBe(10_000);
    expect(opts.nodeHeapMb).toBe(256);
    expect(opts.gracePeriodMs).toBe(2_000);
  });

  it('{ timeoutMs: 1 500 } ⇒ grace is floor(timeoutMs / 2) = 750 — never ≥ timeoutMs, no RangeError', async () => {
    await runRenderCheckViaWorker(INPUT, { bounds: { timeoutMs: 1_500 } });
    const opts = lastOptions();
    expect(opts.timeoutMs).toBe(1_500);
    expect(opts.gracePeriodMs).toBe(750);
    expect(opts.gracePeriodMs).toBeLessThan(opts.timeoutMs);
  });

  it('the bound the verdict reports on a timeout is the bound that was passed', async () => {
    const result = await runRenderCheckViaWorker(INPUT, { bounds: { timeoutMs: 4_000 } });
    // A clean verdict carries no `incomplete`; the mapping is pinned in the
    // kill-path test with a real timeout. Here only the threading is pinned.
    expect(result.incomplete).toBeUndefined();
    expect(lastOptions().timeoutMs).toBe(4_000);
  });
});
