// @vitest-environment node
//
// ggui#1380 C2 — twin of harness/check/runtime-render/
// render-check-worker.esbuild-stop.test.ts for the render SMOKE worker: one
// verdict, `esbuild.stop()` exactly once and after the write, and a run
// whose write throws (a closed pipe) still stops the service. The compile
// is real (esbuild's real `transform` under a spied `stop`); the render is
// `react-dom/server`'s.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const esbuildStop = vi.hoisted(() => vi.fn(async (): Promise<void> => {}));

vi.mock('esbuild', async (importOriginal) => {
  const actual = await importOriginal<typeof import('esbuild')>();
  return { ...actual, stop: esbuildStop };
});

const { workerMain } = await import('./render-check-worker.js');

const INPUT = JSON.stringify({
  sourceCode: 'export default function C(props: { name: string }) { return <div>{props.name}</div>; }',
  sampleProps: { name: 'smoke' },
});

/** Swallow the verdict on THIS process's stdout and make the write observable. */
function spyStdoutWrite() {
  return vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
}

describe('tools/render-check-worker — esbuild.stop() after the verdict (ggui#1380 C2)', () => {
  let write: ReturnType<typeof spyStdoutWrite>;

  beforeEach(() => {
    esbuildStop.mockClear();
    write = spyStdoutWrite();
  });

  it('writes exactly one { ok: true } verdict, then stops esbuild exactly once — in that order', async () => {
    await workerMain(INPUT);
    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toEqual({ ok: true });
    expect(esbuildStop).toHaveBeenCalledTimes(1);
    expect(Number(esbuildStop.mock.invocationCallOrder[0])).toBeGreaterThan(
      Number(write.mock.invocationCallOrder[0]),
    );
  });

  it('a component that throws at render: one { ok: false } verdict, esbuild stopped once', async () => {
    await workerMain(JSON.stringify({ sourceCode: "export default function C() { throw new Error('boom'); }" }));
    expect(write).toHaveBeenCalledTimes(1);
    const verdict: { ok: boolean; error?: string } = JSON.parse(String(write.mock.calls[0]?.[0]));
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain('boom');
    expect(esbuildStop).toHaveBeenCalledTimes(1);
  });

  it('a write that throws (closed pipe) still stops esbuild exactly once (finally)', async () => {
    write.mockImplementation(() => {
      throw new Error('EPIPE');
    });
    await expect(workerMain(INPUT)).rejects.toThrow('EPIPE');
    expect(esbuildStop).toHaveBeenCalledTimes(1);
  });
});
