/**
 * SLO v0 runner — invokes `ggui_render` once for a given corpus case,
 * spies on the provisional-preview outcome stream, and materializes
 * an {@link SloRunResult} with all four active checkpoints + the
 * reserved `finalDomVisibleAt` null placeholder.
 *
 * Design notes:
 *
 *   - Runner is thin. Stats happen in `summarize.ts`; report shape
 *     happens in `reporter.ts`. This file only records one run.
 *   - Emitter behavior is driven by the corpus case's `emitterPlan`
 *     — see `./corpus.ts` for the v0 "emitter-simulated" caveat.
 *   - Clock is injectable (`deps.now`) so tests can pin timings
 *     deterministically. Default is `performance.now()` because the
 *     default `Date.now()` granularity (>= 1ms) is unsafe for the
 *     sub-millisecond differences the blueprint_hit case exercises.
 *   - Runner never throws from the happy path. Handler throws and
 *     outcome failures are captured on `result.errors`.
 *
 * What the runner does NOT do in v0:
 *
 *   - Real blueprint-finder / generator wiring — see README.
 *   - Real compile instrumentation — `finalCompiledAt` is the
 *     handler-return clock in the open-source build (see
 *     `tags.finalCompiledReliable`).
 *   - DOM-visible detection — deferred to v0.5.
 */

import { randomUUID } from 'node:crypto';
import {
  createGguiHandshakeHandler,
  createGguiRenderHandler,
  type HandleStreamEnvelope,
  type ProvisionalPreviewContext,
  type ProvisionalPreviewDeps,
  type ProvisionalPreviewEmitter,
  type ProvisionalPreviewOutcome,
} from '@ggui-ai/mcp-server-handlers';
import {
  InMemoryKeyValueStore,
  InMemoryRenderStore,
} from '@ggui-ai/mcp-server-core/in-memory';

import type { SloCase, SloEmitterPlan } from './corpus.js';
import {
  deriveMetrics,
  type SloCheckpoints,
  type SloRunResult,
  type SloRunTags,
} from './types.js';

export interface SloRunnerDeps {
  /**
   * Clock override. Runner defaults to `performance.now()` which
   * gives sub-millisecond resolution. `Date.now()` (>= 1ms tick)
   * is fine for coarse-grained real runs but loses signal on the
   * blueprint_hit simulation's tight budget.
   */
  readonly now?: () => number;
  /**
   * Sleep override. Runner defaults to `setTimeout`-based delay.
   * Tests inject a deterministic stub so simulated emitter timings
   * are exact.
   */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Execute a single SLO case once. Returns the result row; caller is
 * responsible for passing `runIndex` when doing n>1 iterations.
 */
export async function runSloCase(
  kase: SloCase,
  runIndex: number,
  deps: SloRunnerDeps = {},
): Promise<SloRunResult> {
  const now = deps.now ?? defaultNow;
  const sleep = deps.sleep ?? defaultSleep;
  const errors: string[] = [];

  let firstPreviewAt: number | null = null;
  let previewFinalizedAt: number | null = null;
  let previewFrames = 0;

  const onOutcome = (outcome: ProvisionalPreviewOutcome) => {
    switch (outcome.status) {
      case 'first-frame':
        // Use our own clock to keep all checkpoints on the same
        // clock domain. The outcome's `firstFrameAt` lives on the
        // runner's clock (via `deps.now` below) but reading it
        // here lets the runner stay on one code path for all
        // stamp observations.
        firstPreviewAt = outcome.firstFrameAt;
        break;
      case 'completed':
      case 'failed':
      case 'cancelled':
        previewFinalizedAt = outcome.finishedAt;
        previewFrames = outcome.frames;
        if (outcome.status === 'failed') {
          errors.push(`preview failed: ${outcome.error}`);
        }
        break;
      case 'skipped':
      case 'started':
        // No-op — neither affects the four checkpoints.
        break;
    }
  };

  // Wire provisional-preview deps iff the case has an emitter plan.
  // Null `emitterPlan` → no preview deps → render handler sees
  // `provisionalPreview: undefined` and gate skips with 'disabled'.
  // That's the 'oss_miss' case.
  const previewDeps: ProvisionalPreviewDeps | undefined =
    kase.emitterPlan === null
      ? undefined
      : buildPreviewDeps(kase.emitterPlan, { now, sleep, onOutcome });

  const renderStore = new InMemoryRenderStore();
  const kvStore = new InMemoryKeyValueStore();
  const handshakeHandler = createGguiHandshakeHandler({ kvStore });
  const handler = createGguiRenderHandler({
    renderStore,
    handshakeStore: kvStore,
    provisionalPreview: previewDeps,
  });

  const appId = `slo-${kase.id}`;
  const requestId = randomUUID();

  const startedAt = now();
  let finalCompiledAt: number | null = null;
  try {
    const hs = await handshakeHandler.handler(
      {
        intent: kase.intent,
        blueprintDraft: { contract: {} },
      },
      { appId, requestId },
    );
    await handler.handler(
      { handshakeId: hs.handshakeId, decision: { kind: 'accept' } },
      { appId, requestId },
    );
    // Open-source build: handler returns synchronously;
    // `codeReady: false` on component path. We record the
    // handler-return moment as `finalCompiledAt` with
    // `finalCompiledReliable: false` —
    // see README "honesty notes".
    finalCompiledAt = now();
  } catch (e) {
    errors.push(`handler threw: ${stringifyError(e)}`);
  }

  // The preview emitter is fire-and-forget from the handler's POV.
  // Await its terminal outcome so the run result carries accurate
  // `previewFinalizedAt` and `previewFrames`. If the case has no
  // emitter (oss_miss), nothing to wait for.
  if (kase.emitterPlan !== null) {
    await waitForPreviewTerminal(() => previewFinalizedAt !== null, now);
  }

  const checkpoints: SloCheckpoints = {
    startedAt,
    firstPreviewAt,
    previewFinalizedAt,
    finalCompiledAt,
    finalDomVisibleAt: null,
  };

  const tags: SloRunTags = {
    path: kase.path,
    previewFrames,
    usedBlueprint: kase.usedBlueprint,
    usedGeneration: kase.usedGeneration,
    previewExpected: kase.emitterPlan !== null && kase.emitterPlan.frames > 0,
    previewObserved: firstPreviewAt !== null,
    // The open-source build always defers compile on story-path
    // pushes. Flag flips true when real compile instrumentation lands.
    finalCompiledReliable: false,
  };

  return {
    caseId: kase.id,
    runIndex,
    checkpoints,
    tags,
    derived: deriveMetrics(checkpoints),
    errors,
  };
}

/** Build an in-memory emitter that follows the case's timing plan. */
function buildPreviewDeps(
  plan: SloEmitterPlan,
  ctx: {
    readonly now: () => number;
    readonly sleep: (ms: number) => Promise<void>;
    readonly onOutcome: (outcome: ProvisionalPreviewOutcome) => void;
  },
): ProvisionalPreviewDeps {
  const emitter: ProvisionalPreviewEmitter = {
    run: async (emitCtx: ProvisionalPreviewContext) => {
      if (plan.firstFrameDelayMs > 0) {
        await ctx.sleep(plan.firstFrameDelayMs);
      }
      for (let i = 0; i < plan.frames; i++) {
        if (emitCtx.signal.aborted) return;
        await emitCtx.emit({
          // Payload shape is A2UI-neutral from the orchestrator's
          // POV (schema lives in @ggui-ai/preview-a2ui). For SLO v0
          // we just need any valid JsonValue — the transport spy
          // doesn't validate shape.
          simFrame: i,
          caseFrame: i + 1,
        });
        if (i < plan.frames - 1 && plan.interFrameDelayMs > 0) {
          await ctx.sleep(plan.interFrameDelayMs);
        }
      }
    },
  };

  const sendEnvelope = async (_e: HandleStreamEnvelope) => {
    // In-process spy — we don't persist envelopes, just ack them
    // so the orchestrator's frame counter advances.
    return {};
  };

  return {
    config: { enabled: true },
    emitter,
    sendEnvelope,
    onOutcome: ctx.onOutcome,
    now: ctx.now,
  };
}

/**
 * Spin-wait (bounded) for the preview terminal outcome to arrive.
 * Kickoff is fire-and-forget from the handler's POV; the runner needs
 * to observe the terminal outcome to report accurate checkpoints.
 * Bounded so a stuck emitter doesn't hang the whole bench.
 */
async function waitForPreviewTerminal(
  done: () => boolean,
  now: () => number,
  timeoutMs = 5_000,
): Promise<void> {
  const start = now();
  while (!done()) {
    if (now() - start > timeoutMs) return; // give up; errors list stays empty-ish, null stamps surface
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Runner's default clock — sub-ms resolution. */
function defaultNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    // `performance.now()` is a DOMHighResTimeStamp — epoch-less but
    // monotonic. That's fine: SLO metrics are all deltas from
    // `startedAt`, never absolute wall-clock values.
    return performance.now();
  }
  return Date.now();
}

/** Runner's default sleep — `setTimeout`-based. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stringifyError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}
