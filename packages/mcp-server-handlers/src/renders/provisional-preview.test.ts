/**
 * Provisional preview orchestration — focused tests covering the
 * four seam contracts landed in this slice:
 *
 *   1. `evaluateProvisionalPreviewGate` — pure gating decision,
 *      every skip reason pinned, no side effects.
 *   2. `runProvisionalPreview` — started / completed / failed /
 *      cancelled outcomes, emit→sendEnvelope wrapping, frames
 *      counter, terminal `{complete: true}` envelope on every exit.
 *   3. `kickoffProvisionalPreview` — `{controller, done}` handle
 *      shape, external abort reaches the runner.
 *   4. `createInMemoryProvisionalPreviewRegistry` — register /
 *      has / clear / cancel / cancelAll semantics, duplicate
 *      kickoff supersedes previous, natural completion auto-clears.
 *
 * Tests are transport-agnostic — the fake `sendEnvelope` records
 * envelopes in-memory. Real transport plumbing (OSS
 * `GguiSessionStreamBuffer`, hosted DDB writer) is exercised separately
 * in their own suites; these tests pin the orchestrator's contract.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createInMemoryProvisionalPreviewRegistry,
  evaluateProvisionalPreviewGate,
  finalizeProvisionalPreview,
  kickoffProvisionalPreview,
  PreviewAbortError,
  PROVISIONAL_PREVIEW_CHANNEL,
  runProvisionalPreview,
  type ProvisionalPreviewConfig,
  type ProvisionalPreviewContext,
  type ProvisionalPreviewDeps,
  type ProvisionalPreviewEmitter,
  type ProvisionalPreviewOutcome,
  type ProvisionalPreviewRunContext,
} from './provisional-preview.js';
import type { HandleStreamEnvelope } from './handle-stream.js';

// ─── Helpers ───────────────────────────────────────────────────────────

/** Monotonic clock that advances by 1 per call — lets tests assert exact timings. */
function makeClock(start = 1000) {
  let t = start;
  return {
    now: () => t++,
    peek: () => t,
  };
}

interface RecordedEnvelope extends HandleStreamEnvelope {
  readonly seqAssigned?: number;
}

function makeFakeSendEnvelope(options?: {
  failOn?: (envelope: HandleStreamEnvelope) => boolean;
}) {
  const recorded: RecordedEnvelope[] = [];
  let nextSeq = 1;
  const fn = vi.fn(async (envelope: HandleStreamEnvelope) => {
    if (options?.failOn?.(envelope)) {
      throw new Error('transport-failed');
    }
    const seq = nextSeq++;
    recorded.push({ ...envelope, seqAssigned: seq });
    return { seq };
  });
  return { fn, recorded };
}

function makeRunContext(
  overrides: Partial<ProvisionalPreviewRunContext> = {},
): ProvisionalPreviewRunContext {
  return {
    renderId: 'sess-1',
    appId: 'app-1',
    story: { intent: 'build a dashboard' },
    ...overrides,
  };
}

function makeConfig(
  overrides: Partial<ProvisionalPreviewConfig> = {},
): ProvisionalPreviewConfig {
  return { enabled: true, ...overrides };
}

function makeDeps(overrides: {
  emitter: ProvisionalPreviewEmitter;
  config?: Partial<ProvisionalPreviewConfig>;
  onOutcome?: (o: ProvisionalPreviewOutcome) => void;
  failOn?: (e: HandleStreamEnvelope) => boolean;
  now?: () => number;
}): { deps: ProvisionalPreviewDeps; recorded: RecordedEnvelope[] } {
  const { fn, recorded } = makeFakeSendEnvelope(
    overrides.failOn ? { failOn: overrides.failOn } : undefined,
  );
  const deps: ProvisionalPreviewDeps = {
    config: makeConfig(overrides.config),
    emitter: overrides.emitter,
    sendEnvelope: fn,
    ...(overrides.onOutcome ? { onOutcome: overrides.onOutcome } : {}),
    ...(overrides.now ? { now: overrides.now } : {}),
  };
  return { deps, recorded };
}

// ─── evaluateProvisionalPreviewGate ────────────────────────────────────

describe('evaluateProvisionalPreviewGate', () => {
  const ctx = { appId: 'app-1', renderId: 'sess-1' };
  const storyInput = { story: { intent: 'go' }, isMcpAppsGguiSession: false };

  it('skips when deps undefined (preview not wired)', () => {
    expect(evaluateProvisionalPreviewGate(undefined, storyInput, ctx)).toEqual({
      kind: 'skip',
      reason: 'disabled',
    });
  });

  it('skips with reason disabled when config.enabled is false', () => {
    const { deps } = makeDeps({
      emitter: { run: async () => {} },
      config: { enabled: false },
    });
    expect(evaluateProvisionalPreviewGate(deps, storyInput, ctx)).toEqual({
      kind: 'skip',
      reason: 'disabled',
    });
  });

  it('skips with reason mcp-apps-render when the render is MCP Apps delivery', () => {
    const { deps } = makeDeps({ emitter: { run: async () => {} } });
    const result = evaluateProvisionalPreviewGate(
      deps,
      { story: { intent: 'go' }, isMcpAppsGguiSession: true },
      ctx,
    );
    expect(result).toEqual({ kind: 'skip', reason: 'mcp-apps-render' });
  });

  it('skips with reason no-story when story is absent', () => {
    const { deps } = makeDeps({ emitter: { run: async () => {} } });
    expect(
      evaluateProvisionalPreviewGate(
        deps,
        { story: undefined, isMcpAppsGguiSession: false },
        ctx,
      ),
    ).toEqual({ kind: 'skip', reason: 'no-story' });
  });

  it('honors an isEnabledFor predicate that returns false', () => {
    const { deps } = makeDeps({
      emitter: { run: async () => {} },
      config: { enabled: true, isEnabledFor: () => false },
    });
    expect(evaluateProvisionalPreviewGate(deps, storyInput, ctx)).toEqual({
      kind: 'skip',
      reason: 'predicate',
    });
  });

  it('proceeds when enabled + story + not-mcp-apps + predicate passes', () => {
    const { deps } = makeDeps({
      emitter: { run: async () => {} },
      config: { enabled: true, isEnabledFor: () => true },
    });
    expect(evaluateProvisionalPreviewGate(deps, storyInput, ctx)).toEqual({
      kind: 'proceed',
    });
  });

  it('proceeds when enabled + story + no predicate configured', () => {
    const { deps } = makeDeps({ emitter: { run: async () => {} } });
    expect(evaluateProvisionalPreviewGate(deps, storyInput, ctx)).toEqual({
      kind: 'proceed',
    });
  });

  it('predicate receives the actual story + render identifiers', () => {
    const predicate = vi.fn(() => true);
    const { deps } = makeDeps({
      emitter: { run: async () => {} },
      config: { enabled: true, isEnabledFor: predicate },
    });
    evaluateProvisionalPreviewGate(
      deps,
      { story: { intent: 'specific' }, isMcpAppsGguiSession: false },
      ctx,
    );
    expect(predicate).toHaveBeenCalledWith({
      appId: 'app-1',
      renderId: 'sess-1',
      story: { intent: 'specific' },
    });
  });
});

// ─── runProvisionalPreview ─────────────────────────────────────────────

describe('runProvisionalPreview — happy path', () => {
  it('fires started then completed, with monotonic timings + frame count', async () => {
    const outcomes: ProvisionalPreviewOutcome[] = [];
    const clock = makeClock();
    const { deps, recorded } = makeDeps({
      emitter: {
        run: async ({ emit }) => {
          await emit({ op: 'a' });
          await emit({ op: 'b' });
          await emit({ op: 'c' });
        },
      },
      onOutcome: (o) => outcomes.push(o),
      now: clock.now,
    });

    const ctl = new AbortController();
    await runProvisionalPreview(deps, makeRunContext(), ctl.signal);

    expect(outcomes.map((o) => o.status)).toEqual([
      'started',
      'first-frame',
      'completed',
    ]);
    const [started, firstFrame, completed] = outcomes;
    expect(started).toMatchObject({ status: 'started', startedAt: 1000 });
    if (firstFrame.status !== 'first-frame') throw new Error('type narrow');
    // `first-frame` fires after the first accepted emit; its
    // `firstFrameAt` propagates into the terminal `completed`.
    expect(firstFrame.firstFrameAt).toBeGreaterThan(firstFrame.startedAt);
    expect(completed).toMatchObject({
      status: 'completed',
      startedAt: 1000,
      frames: 3,
    });
    if (completed.status !== 'completed') throw new Error('type narrow');
    expect(completed.finishedAt).toBeGreaterThan(completed.startedAt);
    expect(completed.firstFrameAt).toBe(firstFrame.firstFrameAt);

    // 3 emitter frames + 1 terminal complete-true envelope.
    expect(recorded).toHaveLength(4);
    for (const env of recorded) {
      expect(env.channel).toBe(PROVISIONAL_PREVIEW_CHANNEL);
      expect(env.mode).toBe('append');
    }
    expect(recorded[3].complete).toBe(true);
    expect(recorded[3].payload).toBe(null);
  });

  it('wraps emit so the emitter never touches sendEnvelope directly', async () => {
    const seen: unknown[] = [];
    const { deps } = makeDeps({
      emitter: {
        run: async ({ emit }) => {
          const res1 = await emit({ createSurface: { surfaceId: 's1' } });
          seen.push(res1);
          const res2 = await emit({ updateComponents: { surfaceId: 's1' } });
          seen.push(res2);
        },
      },
    });
    await runProvisionalPreview(deps, makeRunContext(), new AbortController().signal);
    expect(seen).toEqual([{ seq: 1 }, { seq: 2 }]);
  });
});

describe('runProvisionalPreview — failure path', () => {
  it('fires failed with the emitter error message', async () => {
    const outcomes: ProvisionalPreviewOutcome[] = [];
    const { deps, recorded } = makeDeps({
      emitter: {
        run: async ({ emit }) => {
          await emit({ op: 'ok' });
          throw new Error('emitter blew up');
        },
      },
      onOutcome: (o) => outcomes.push(o),
    });

    await runProvisionalPreview(deps, makeRunContext(), new AbortController().signal);
    const failed = outcomes.find((o) => o.status === 'failed');
    expect(failed).toBeDefined();
    if (failed?.status !== 'failed') throw new Error('narrow');
    expect(failed.error).toBe('emitter blew up');
    expect(failed.frames).toBe(1);

    // Terminal envelope still sent even on failure path.
    expect(recorded.at(-1)?.complete).toBe(true);
  });

  it('stringifies non-Error rejections sensibly', async () => {
    const outcomes: ProvisionalPreviewOutcome[] = [];
    const { deps } = makeDeps({
      emitter: {
        run: async () => {
          throw 'raw-string';
        },
      },
      onOutcome: (o) => outcomes.push(o),
    });
    await runProvisionalPreview(deps, makeRunContext(), new AbortController().signal);
    const failed = outcomes.find((o) => o.status === 'failed');
    if (failed?.status !== 'failed') throw new Error('narrow');
    expect(failed.error).toBe('raw-string');
  });

  it('does NOT reclassify completed as failed when the terminal envelope send errors', async () => {
    const outcomes: ProvisionalPreviewOutcome[] = [];
    const { deps } = makeDeps({
      emitter: {
        run: async ({ emit }) => {
          await emit({ op: 'ok' });
        },
      },
      // The terminal frame has payload: null, complete: true — fail exactly that.
      failOn: (env) => env.complete === true && env.payload === null,
      onOutcome: (o) => outcomes.push(o),
    });
    await runProvisionalPreview(deps, makeRunContext(), new AbortController().signal);
    expect(outcomes.map((o) => o.status)).toEqual([
      'started',
      'first-frame',
      'completed',
    ]);
  });

  it('never throws — rejections surface only via onOutcome', async () => {
    const { deps } = makeDeps({
      emitter: {
        run: async () => {
          throw new Error('boom');
        },
      },
    });
    // If the runner threw, this await would reject.
    await expect(
      runProvisionalPreview(deps, makeRunContext(), new AbortController().signal),
    ).resolves.toBeUndefined();
  });
});

describe('runProvisionalPreview — cancellation', () => {
  it('fires cancelled when the signal aborts before any emit', async () => {
    const outcomes: ProvisionalPreviewOutcome[] = [];
    const ctl = new AbortController();
    ctl.abort();

    const { deps } = makeDeps({
      emitter: {
        run: async ({ emit }) => {
          // Emit guard throws PreviewAbortError because signal is already aborted.
          await emit({ op: 'attempted' });
        },
      },
      onOutcome: (o) => outcomes.push(o),
    });
    await runProvisionalPreview(deps, makeRunContext(), ctl.signal);
    const cancelled = outcomes.find((o) => o.status === 'cancelled');
    expect(cancelled).toBeDefined();
    if (cancelled?.status !== 'cancelled') throw new Error('narrow');
    expect(cancelled.frames).toBe(0);
  });

  it('fires cancelled mid-stream when the signal aborts during emission', async () => {
    const outcomes: ProvisionalPreviewOutcome[] = [];
    const ctl = new AbortController();
    const { deps, recorded } = makeDeps({
      emitter: {
        run: async ({ emit }) => {
          await emit({ op: 'before-abort' });
          ctl.abort();
          await emit({ op: 'after-abort' });
        },
      },
      onOutcome: (o) => outcomes.push(o),
    });
    await runProvisionalPreview(deps, makeRunContext(), ctl.signal);
    const cancelled = outcomes.find((o) => o.status === 'cancelled');
    expect(cancelled).toBeDefined();
    if (cancelled?.status !== 'cancelled') throw new Error('narrow');
    expect(cancelled.frames).toBe(1); // only the first emit succeeded

    // Terminal envelope still sent on cancellation.
    expect(recorded.at(-1)?.complete).toBe(true);
  });

  it('cancelled outcome carries the PreviewAbortError message as reason', async () => {
    const outcomes: ProvisionalPreviewOutcome[] = [];
    const ctl = new AbortController();
    ctl.abort();
    const { deps } = makeDeps({
      emitter: {
        run: async ({ emit }) => {
          await emit({ op: 'x' });
        },
      },
      onOutcome: (o) => outcomes.push(o),
    });
    await runProvisionalPreview(deps, makeRunContext(), ctl.signal);
    const cancelled = outcomes.find((o) => o.status === 'cancelled');
    if (cancelled?.status !== 'cancelled') throw new Error('narrow');
    expect(cancelled.reason).toContain('aborted');
  });

  it('classifies a well-behaved emitter that returns after abort as cancelled', async () => {
    // Emitter that polls signal without throwing.
    const outcomes: ProvisionalPreviewOutcome[] = [];
    const ctl = new AbortController();
    const { deps } = makeDeps({
      emitter: {
        run: async ({ signal }) => {
          ctl.abort();
          // Emitter cooperatively observes the signal itself.
          if (signal.aborted) return;
        },
      },
      onOutcome: (o) => outcomes.push(o),
    });
    await runProvisionalPreview(deps, makeRunContext(), ctl.signal);
    expect(outcomes.map((o) => o.status)).toEqual(['started', 'cancelled']);
  });
});

// ─── kickoffProvisionalPreview ─────────────────────────────────────────

describe('kickoffProvisionalPreview', () => {
  it('returns {controller, done} and the runner settles via done', async () => {
    const outcomes: ProvisionalPreviewOutcome[] = [];
    const { deps } = makeDeps({
      emitter: {
        run: async ({ emit }) => {
          await emit({ x: 1 });
        },
      },
      onOutcome: (o) => outcomes.push(o),
    });
    const handle = kickoffProvisionalPreview(deps, makeRunContext());
    expect(handle.controller).toBeInstanceOf(AbortController);
    await handle.done;
    expect(outcomes.map((o) => o.status)).toEqual([
      'started',
      'first-frame',
      'completed',
    ]);
  });

  it('external abort cancels the runner', async () => {
    const outcomes: ProvisionalPreviewOutcome[] = [];
    let emitFn: ProvisionalPreviewContext['emit'] | null = null;
    let resume!: () => void;
    const emitterPromise = new Promise<void>((r) => {
      resume = r;
    });

    const { deps } = makeDeps({
      emitter: {
        run: async (ctx) => {
          emitFn = ctx.emit;
          await emitterPromise;
          await ctx.emit({ x: 1 });
        },
      },
      onOutcome: (o) => outcomes.push(o),
    });
    const handle = kickoffProvisionalPreview(deps, makeRunContext());
    // Wait a tick so the runner enters the emitter.
    await Promise.resolve();
    expect(emitFn).not.toBeNull();

    handle.controller.abort();
    resume();
    await handle.done;
    const cancelled = outcomes.find((o) => o.status === 'cancelled');
    expect(cancelled).toBeDefined();
  });
});

// ─── createInMemoryProvisionalPreviewRegistry ──────────────────────────

describe('createInMemoryProvisionalPreviewRegistry', () => {
  function makeHandle(resolver?: { resolve?: () => void; abort?: (r?: string) => void }): {
    handle: { controller: AbortController; done: Promise<void> };
    resolve: () => void;
    aborted: () => boolean;
  } {
    const controller = new AbortController();
    let resolveFn!: () => void;
    const done = new Promise<void>((r) => (resolveFn = r));
    void resolver; // reserved
    return {
      handle: { controller, done },
      resolve: resolveFn,
      aborted: () => controller.signal.aborted,
    };
  }

  it('registers and reports has=true', () => {
    const reg = createInMemoryProvisionalPreviewRegistry();
    const { handle } = makeHandle();
    reg.register('page-1', handle);
    expect(reg.has('page-1')).toBe(true);
  });

  it('auto-clears when the handle settles', async () => {
    const reg = createInMemoryProvisionalPreviewRegistry();
    const { handle, resolve } = makeHandle();
    reg.register('page-1', handle);
    resolve();
    await handle.done;
    // Microtask for the finally-chain auto-clear to run.
    await Promise.resolve();
    expect(reg.has('page-1')).toBe(false);
  });

  it('cancel aborts the controller and awaits the done settle', async () => {
    const reg = createInMemoryProvisionalPreviewRegistry();
    const { handle, resolve, aborted } = makeHandle();
    reg.register('page-1', handle);
    const cancelP = reg.cancel('page-1', 'handoff');
    expect(aborted()).toBe(true);
    resolve();
    await cancelP;
    expect(reg.has('page-1')).toBe(false);
  });

  it('cancel is a no-op when no handle is registered', async () => {
    const reg = createInMemoryProvisionalPreviewRegistry();
    await expect(reg.cancel('not-there')).resolves.toBeUndefined();
  });

  it('clear removes without cancelling', () => {
    const reg = createInMemoryProvisionalPreviewRegistry();
    const { handle, aborted } = makeHandle();
    reg.register('page-1', handle);
    reg.clear('page-1');
    expect(reg.has('page-1')).toBe(false);
    expect(aborted()).toBe(false);
  });

  it('duplicate register supersedes + cancels the previous handle', async () => {
    const reg = createInMemoryProvisionalPreviewRegistry();
    const first = makeHandle();
    const second = makeHandle();
    reg.register('page-1', first.handle);
    reg.register('page-1', second.handle);
    expect(first.aborted()).toBe(true);
    expect(second.aborted()).toBe(false);
    // Resolve both to avoid open promises.
    first.resolve();
    second.resolve();
    await Promise.all([first.handle.done, second.handle.done]);
  });

  it('cancelAll aborts every active handle', async () => {
    const reg = createInMemoryProvisionalPreviewRegistry();
    const a = makeHandle();
    const b = makeHandle();
    reg.register('a', a.handle);
    reg.register('b', b.handle);
    const p = reg.cancelAll('shutdown');
    expect(a.aborted()).toBe(true);
    expect(b.aborted()).toBe(true);
    a.resolve();
    b.resolve();
    await p;
    expect(reg.has('a')).toBe(false);
    expect(reg.has('b')).toBe(false);
  });
});

// ─── First-frame instrumentation ───────────────────────────────────────

describe('runProvisionalPreview — first-frame event', () => {
  it('fires first-frame exactly once, between started and completed', async () => {
    const outcomes: ProvisionalPreviewOutcome[] = [];
    const { deps } = makeDeps({
      emitter: {
        run: async ({ emit }) => {
          await emit({ n: 1 });
          await emit({ n: 2 });
          await emit({ n: 3 });
        },
      },
      onOutcome: (o) => outcomes.push(o),
    });
    await runProvisionalPreview(deps, makeRunContext(), new AbortController().signal);
    const statuses = outcomes.map((o) => o.status);
    expect(statuses).toEqual(['started', 'first-frame', 'completed']);
    // Idempotent — even with 3 emits, only one first-frame.
    expect(statuses.filter((s) => s === 'first-frame')).toHaveLength(1);
  });

  it('does NOT fire first-frame when the emitter never emits', async () => {
    const outcomes: ProvisionalPreviewOutcome[] = [];
    const { deps } = makeDeps({
      emitter: { run: async () => { /* no emits */ } },
      onOutcome: (o) => outcomes.push(o),
    });
    await runProvisionalPreview(deps, makeRunContext(), new AbortController().signal);
    const statuses = outcomes.map((o) => o.status);
    expect(statuses).toEqual(['started', 'completed']);
    const completed = outcomes.find((o) => o.status === 'completed');
    if (completed?.status !== 'completed') throw new Error('narrow');
    expect(completed.firstFrameAt).toBeNull();
  });

  it('cancelled-before-visible: firstFrameAt on the terminal outcome is null', async () => {
    const outcomes: ProvisionalPreviewOutcome[] = [];
    const ctl = new AbortController();
    ctl.abort();
    const { deps } = makeDeps({
      emitter: {
        run: async ({ emit }) => {
          // Signal already aborted — emit throws PreviewAbortError.
          await emit({ never: 'reached' });
        },
      },
      onOutcome: (o) => outcomes.push(o),
    });
    await runProvisionalPreview(deps, makeRunContext(), ctl.signal);
    const cancelled = outcomes.find((o) => o.status === 'cancelled');
    if (cancelled?.status !== 'cancelled') throw new Error('narrow');
    expect(cancelled.firstFrameAt).toBeNull();
    expect(cancelled.frames).toBe(0);
    // first-frame never fired.
    expect(outcomes.some((o) => o.status === 'first-frame')).toBe(false);
  });

  it('terminal outcome propagates firstFrameAt from the first-frame event', async () => {
    const outcomes: ProvisionalPreviewOutcome[] = [];
    const clock = makeClock();
    const { deps } = makeDeps({
      emitter: {
        run: async ({ emit }) => {
          await emit({ a: 1 });
          await emit({ b: 2 });
        },
      },
      onOutcome: (o) => outcomes.push(o),
      now: clock.now,
    });
    await runProvisionalPreview(deps, makeRunContext(), new AbortController().signal);
    const firstFrame = outcomes.find((o) => o.status === 'first-frame');
    const completed = outcomes.find((o) => o.status === 'completed');
    if (firstFrame?.status !== 'first-frame') throw new Error('narrow');
    if (completed?.status !== 'completed') throw new Error('narrow');
    expect(completed.firstFrameAt).toBe(firstFrame.firstFrameAt);
    // Time-to-first-frame is positive + less than total duration.
    const timeToFirstFrame = firstFrame.firstFrameAt - firstFrame.startedAt;
    const totalDuration = completed.finishedAt - completed.startedAt;
    expect(timeToFirstFrame).toBeGreaterThan(0);
    expect(timeToFirstFrame).toBeLessThanOrEqual(totalDuration);
  });

  it('failed outcome carries firstFrameAt when some frames landed before the throw', async () => {
    const outcomes: ProvisionalPreviewOutcome[] = [];
    const { deps } = makeDeps({
      emitter: {
        run: async ({ emit }) => {
          await emit({ ok: 1 });
          throw new Error('mid-stream');
        },
      },
      onOutcome: (o) => outcomes.push(o),
    });
    await runProvisionalPreview(deps, makeRunContext(), new AbortController().signal);
    const failed = outcomes.find((o) => o.status === 'failed');
    if (failed?.status !== 'failed') throw new Error('narrow');
    expect(failed.firstFrameAt).not.toBeNull();
    expect(failed.frames).toBe(1);
  });
});

// ─── finalizeProvisionalPreview handoff helper ─────────────────────────

describe('finalizeProvisionalPreview', () => {
  it('cancels the active handle + default reason is "handoff"', async () => {
    const outcomes: ProvisionalPreviewOutcome[] = [];
    const reg = createInMemoryProvisionalPreviewRegistry();
    let resume!: () => void;
    const emitterPromise = new Promise<void>((r) => { resume = r; });
    const { deps } = makeDeps({
      emitter: { run: () => emitterPromise },
      onOutcome: (o) => outcomes.push(o),
    });
    const handle = kickoffProvisionalPreview(deps, makeRunContext());
    reg.register('page-1', handle);
    // Let the runner enter the emitter.
    await Promise.resolve();
    const finalized = finalizeProvisionalPreview(reg, 'page-1');
    // Emitter can unblock now; the signal is already aborted.
    resume();
    await finalized;
    const cancelled = outcomes.find((o) => o.status === 'cancelled');
    if (cancelled?.status !== 'cancelled') throw new Error('narrow');
    expect(cancelled.reason).toBe('handoff');
  });

  it('honors a caller-supplied reason', async () => {
    const outcomes: ProvisionalPreviewOutcome[] = [];
    const reg = createInMemoryProvisionalPreviewRegistry();
    let resume!: () => void;
    const emitterPromise = new Promise<void>((r) => { resume = r; });
    const { deps } = makeDeps({
      emitter: { run: () => emitterPromise },
      onOutcome: (o) => outcomes.push(o),
    });
    const handle = kickoffProvisionalPreview(deps, makeRunContext());
    reg.register('page-1', handle);
    await Promise.resolve();
    const finalized = finalizeProvisionalPreview(reg, 'page-1', 'final-ready');
    resume();
    await finalized;
    const cancelled = outcomes.find((o) => o.status === 'cancelled');
    if (cancelled?.status !== 'cancelled') throw new Error('narrow');
    expect(cancelled.reason).toBe('final-ready');
  });

  it('is a no-op when no preview is registered under the renderId', async () => {
    const reg = createInMemoryProvisionalPreviewRegistry();
    await expect(
      finalizeProvisionalPreview(reg, 'never-registered'),
    ).resolves.toBeUndefined();
  });

  it('resolves only after the runner has fired its terminal outcome', async () => {
    const outcomes: ProvisionalPreviewOutcome[] = [];
    const reg = createInMemoryProvisionalPreviewRegistry();
    let resume!: () => void;
    const emitterPromise = new Promise<void>((r) => { resume = r; });
    const { deps } = makeDeps({
      emitter: { run: () => emitterPromise },
      onOutcome: (o) => outcomes.push(o),
    });
    const handle = kickoffProvisionalPreview(deps, makeRunContext());
    reg.register('page-1', handle);
    await Promise.resolve();
    const finalized = finalizeProvisionalPreview(reg, 'page-1');
    resume();
    await finalized;
    // When finalizeProvisionalPreview's awaiter wakes, the cancelled
    // outcome must already be in the outcomes array — not a future
    // microtask away.
    expect(outcomes.some((o) => o.status === 'cancelled')).toBe(true);
  });
});

// ─── Contract locks ────────────────────────────────────────────────────

describe('PROVISIONAL_PREVIEW_CHANNEL constant', () => {
  it('matches the protocol-level PREVIEW_CHANNEL literal', async () => {
    const { PREVIEW_CHANNEL } = await import('@ggui-ai/protocol');
    expect(PROVISIONAL_PREVIEW_CHANNEL).toBe(PREVIEW_CHANNEL);
  });
});

describe('PreviewAbortError', () => {
  it('carries a recognizable name so the runner can discriminate', () => {
    const err = new PreviewAbortError('x');
    expect(err.name).toBe('PreviewAbortError');
    expect(err).toBeInstanceOf(Error);
  });
});
