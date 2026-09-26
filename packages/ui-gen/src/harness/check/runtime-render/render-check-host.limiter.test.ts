// @vitest-environment node
//
// ggui#1380 C2 — a K-slot FIFO limiter per check instance. Every admitted
// generation used to spawn a worker at once; `createRuntimeRenderCheck({
// maxConcurrent: K })` lets a serving deployment cap the live workers. The
// (K+1)th call waits in FIFO order and spawns only when a slot frees; a
// rejected check releases its slot. `runSandboxed` is mocked with one
// controllable deferred per call, so "spawned" is observable and the order
// is ours to release.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataContract } from '@ggui-ai/protocol';
import type { SandboxOptions, SandboxResult } from '@ggui-ai/sandbox';

interface Deferred {
  readonly options: SandboxOptions;
  readonly resolve: (result: SandboxResult) => void;
  readonly reject: (err: Error) => void;
}

const spawned = vi.hoisted((): { calls: Deferred[] } => ({ calls: [] }));

vi.mock('@ggui-ai/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ggui-ai/sandbox')>();
  return {
    ...actual,
    runSandboxed: (options: SandboxOptions): Promise<SandboxResult> =>
      new Promise<SandboxResult>((resolve, reject) => {
        spawned.calls.push({ options, resolve, reject });
      }),
  };
});

const { createRuntimeRenderCheck } = await import('./adapter.js');

/** Complete SandboxResult carrying a clean verdict — no type erasure. */
function cleanExit(): SandboxResult {
  return {
    outcome: 'exit',
    exitCode: 0,
    signal: null,
    stdout: JSON.stringify({ ok: true, issues: [], stats: { actionsChecked: 0, streamsChecked: 0, renderMs: 1 } }),
    stderr: '',
    durationMs: 1,
    stdoutTruncated: false,
    stderrTruncated: false,
    cwd: '/tmp',
    cwdOwnedBySandbox: true,
    nodeHeapMbApplied: true,
    errorMessage: '',
  };
}

const CONTRACT: DataContract = { propsSpec: { properties: {} } };

function source(n: number): string {
  return `export default function C${n}() { return <div>${n}</div>; }`;
}

function run(check: ReturnType<typeof createRuntimeRenderCheck>, n: number) {
  return check.run({ sourceCode: source(n), compiledCode: 'compiled', contract: CONTRACT });
}

/** Wait until exactly `n` workers have been spawned (the host is loaded lazily — a real import on first use). */
async function spawnedCount(n: number): Promise<void> {
  await vi.waitFor(() => expect(spawned.calls).toHaveLength(n), { timeout: 5_000, interval: 10 });
}

/** A real-time hold for the negative: nothing else spawned while a slot was held. */
async function hold(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 150));
}

function spawnedSource(i: number): string {
  const call = spawned.calls[i];
  if (call === undefined) throw new Error(`no spawn #${i}`);
  const stdin = call.options.stdin;
  if (typeof stdin !== 'string') throw new Error(`spawn #${i} had no string stdin`);
  const parsed: { sourceCode: string } = JSON.parse(stdin);
  return parsed.sourceCode;
}

describe('createRuntimeRenderCheck({ maxConcurrent }) — K slots, FIFO (ggui#1380 C2)', () => {
  beforeEach(() => {
    spawned.calls.length = 0;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('three concurrent runs on K=2: two spawn at once, the third only when the first resolves — in FIFO order', async () => {
    const check = createRuntimeRenderCheck({ maxConcurrent: 2 });
    const p1 = run(check, 1);
    const p2 = run(check, 2);
    const p3 = run(check, 3);
    await spawnedCount(2);
    await hold();
    expect(spawned.calls).toHaveLength(2);
    expect(spawnedSource(0)).toBe(source(1));
    expect(spawnedSource(1)).toBe(source(2));

    spawned.calls[0]?.resolve(cleanExit());
    await p1;
    await spawnedCount(3);
    expect(spawnedSource(2)).toBe(source(3));

    spawned.calls[1]?.resolve(cleanExit());
    spawned.calls[2]?.resolve(cleanExit());
    const [o1, o2, o3] = await Promise.all([p1, p2, p3]);
    expect([o1.status, o2.status, o3.status]).toEqual(['ran', 'ran', 'ran']);
  });

  it('a rejecting first check releases its slot — the third still spawns', async () => {
    const check = createRuntimeRenderCheck({ maxConcurrent: 2 });
    const p1 = run(check, 1);
    const p2 = run(check, 2);
    const p3 = run(check, 3);
    await spawnedCount(2);
    await hold();
    expect(spawned.calls).toHaveLength(2);

    spawned.calls[0]?.reject(new Error('spawn exploded'));
    const o1 = await p1;
    expect(o1.status).toBe('infra-skipped');
    await spawnedCount(3);
    expect(spawnedSource(2)).toBe(source(3));

    spawned.calls[1]?.resolve(cleanExit());
    spawned.calls[2]?.resolve(cleanExit());
    await Promise.all([p2, p3]);
  });

  it('no maxConcurrent ⇒ unbounded, as today: three runs spawn three workers at once', async () => {
    const check = createRuntimeRenderCheck();
    const ps = [run(check, 1), run(check, 2), run(check, 3)];
    await spawnedCount(3);
    for (const call of spawned.calls) call.resolve(cleanExit());
    await Promise.all(ps);
  });

  it('maxConcurrent must be a positive integer — a zero-slot limiter would never spawn', () => {
    expect(() => createRuntimeRenderCheck({ maxConcurrent: 0 })).toThrow(RangeError);
    expect(() => createRuntimeRenderCheck({ maxConcurrent: 1.5 })).toThrow(RangeError);
  });

  it('a check that waited for a slot reports the wait as queuedMs, apart from its own elapsedMs; one that did not wait has no queuedMs key', async () => {
    const check = createRuntimeRenderCheck({ maxConcurrent: 1 });
    const p1 = run(check, 1);
    const p2 = run(check, 2);
    await spawnedCount(1);
    await new Promise<void>((r) => setTimeout(r, 120));
    spawned.calls[0]?.resolve(cleanExit());
    const o1 = await p1;
    await spawnedCount(2);
    spawned.calls[1]?.resolve(cleanExit());
    const o2 = await p2;
    expect(o1.status).toBe('ran');
    expect(o1).not.toHaveProperty('queuedMs');
    expect(o2.status).toBe('ran');
    expect(o2.queuedMs).toBeGreaterThanOrEqual(100);
    // the second check's own clock starts when its slot is acquired — the wait is not inside elapsedMs
    expect(o2.elapsedMs).toBeLessThan(o2.queuedMs ?? 0);
  });
});
