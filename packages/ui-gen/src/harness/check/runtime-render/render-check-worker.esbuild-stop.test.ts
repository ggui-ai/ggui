// @vitest-environment node
//
// ggui#1380 C2 — the isolated check worker stops esbuild's service before
// it exits. esbuild keeps a child process alive for the life of the worker;
// a worker that never calls `esbuild.stop()` leaves that child to outlive
// it whenever the worker is killed rather than exiting through the event
// loop. Pinned at the worker's `workerMain(raw)` seam: exactly one verdict
// is written, `esbuild.stop` is called exactly once and AFTER the write,
// and a check that throws still stops the service (finally). `esbuild` is
// mocked with its real surface plus a spied `stop`; the check itself is
// stubbed so nothing renders here. Importing `workerMain` must not read
// stdin — the process-entry guard is what keeps this import inert.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RenderCheckResult } from './render-check.js';

const esbuildStop = vi.hoisted(() => vi.fn(async (): Promise<void> => {}));
const check = vi.hoisted((): { next: (() => Promise<RenderCheckResult>) | undefined } => ({ next: undefined }));

vi.mock('esbuild', async (importOriginal) => {
  const actual = await importOriginal<typeof import('esbuild')>();
  return { ...actual, stop: esbuildStop };
});

vi.mock('./render-check.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./render-check.js')>();
  return {
    ...actual,
    runRenderCheckInProcess: (): Promise<RenderCheckResult> => {
      if (check.next === undefined) throw new Error('test did not script the check');
      return check.next();
    },
  };
});

const { workerMain } = await import('./render-check-worker.js');

const VERDICT: RenderCheckResult = {
  ok: true,
  issues: [],
  stats: { actionsChecked: 1, streamsChecked: 0, renderMs: 7 },
};

const INPUT = JSON.stringify({
  sourceCode: 'export default function C() { return null; }',
  mockupProps: {},
});

/** Swallow the verdict on THIS process's stdout and make the write observable. */
function spyStdoutWrite() {
  return vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
}

describe('render-check-worker — esbuild.stop() after the verdict (ggui#1380 C2)', () => {
  let write: ReturnType<typeof spyStdoutWrite>;

  beforeEach(() => {
    esbuildStop.mockClear();
    check.next = undefined;
    write = spyStdoutWrite();
  });

  it('writes exactly one verdict, then stops esbuild exactly once — in that order', async () => {
    check.next = async () => VERDICT;
    await workerMain(INPUT);

    expect(write).toHaveBeenCalledTimes(1);
    const written = write.mock.calls[0]?.[0];
    expect(typeof written).toBe('string');
    expect(JSON.parse(String(written))).toEqual(VERDICT);
    expect(esbuildStop).toHaveBeenCalledTimes(1);
    const writeOrder = write.mock.invocationCallOrder[0];
    const stopOrder = esbuildStop.mock.invocationCallOrder[0];
    expect(writeOrder).toBeDefined();
    expect(stopOrder).toBeDefined();
    expect(Number(stopOrder)).toBeGreaterThan(Number(writeOrder));
  });

  it('a throwing check still stops esbuild exactly once (finally), and writes no verdict', async () => {
    check.next = async () => {
      throw new Error('harness defect');
    };
    await expect(workerMain(INPUT)).rejects.toThrow('harness defect');
    expect(write).not.toHaveBeenCalled();
    expect(esbuildStop).toHaveBeenCalledTimes(1);
  });

  it('malformed input: no verdict, exit code 1, esbuild still stopped once', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    process.exitCode = undefined;
    await workerMain('{not json');
    expect(write).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
    expect(esbuildStop).toHaveBeenCalledTimes(1);
    process.exitCode = undefined;
  });
});
