/**
 * A2UI v0 runner — one run per corpus case.
 *
 * What happens on a run:
 *   1. Build `ProvisionalPreviewDeps` with:
 *        - real deterministic emitter (`@ggui-ai/preview-a2ui/emitters`)
 *        - intercepting `sendEnvelope` that runs `parseServerMessage`
 *          on every payload → counts pass/fail + captures samples
 *        - `onOutcome` sink that records firstFrame + terminal timing
 *        - injectable clock + `{enabled: true}` gate
 *   2. Fire `kickoffProvisionalPreview` (same entry point the push
 *      handler uses in production) and await `handle.done`.
 *   3. Materialize the `A2uiRunResult`. Honest null population on
 *      every absence path.
 *
 * What we DO NOT do:
 *   - No render-handler invocation — the emitter + orchestrator path
 *     is what this bench is for; going through `ggui_render` would
 *     add noise from unrelated checkpoints. SLO covers the render
 *     end-to-end.
 *   - No LLM. The deterministic emitter is the only producer wired
 *     today. When a Haiku-backed producer lands, drop it in behind
 *     the same `ProvisionalPreviewEmitter` interface and the bench
 *     runs unchanged.
 *   - No renderer. We parse frames but never render them. DOM-
 *     visible + visual delta are explicit v0.5+ work.
 */

import { randomUUID } from 'node:crypto';
import { createDeterministicPreviewEmitter } from '@ggui-ai/preview-a2ui/emitters';
import { parseServerMessage } from '@ggui-ai/preview-a2ui';
import type {
  HandleStreamEnvelope,
  ProvisionalPreviewContext,
  ProvisionalPreviewDeps,
  ProvisionalPreviewEmitter,
  ProvisionalPreviewOutcome,
  ProvisionalPreviewRunContext,
  SendEnvelopeFn,
} from '@ggui-ai/mcp-server-handlers';
import { kickoffProvisionalPreview } from '@ggui-ai/mcp-server-handlers';

import type { A2uiCase } from './corpus.js';
import {
  deriveA2uiMetrics,
  type A2uiCheckpoints,
  type A2uiFrameAccounting,
  type A2uiRunResult,
  type A2uiRunTags,
} from './types.js';

/** Maximum number of parse-fail issue snippets recorded per run. */
const PARSE_ISSUE_SAMPLE_CAP = 3;

export interface A2uiRunnerDeps {
  /**
   * Clock. Defaults to `performance.now()` for sub-ms resolution —
   * the deterministic emitter produces all 4 frames synchronously
   * in the same tick on a fast machine, so `Date.now()` would
   * collapse every timestamp to the same ms.
   */
  readonly now?: () => number;
}

export async function runA2uiCase(
  kase: A2uiCase,
  runIndex: number,
  deps: A2uiRunnerDeps = {},
): Promise<A2uiRunResult> {
  const now = deps.now ?? defaultNow;
  const errors: string[] = [];

  let frameCount = 0;
  let parsePassCount = 0;
  let parseFailCount = 0;
  const parseIssueSamples: string[] = [];

  let firstFrameAt: number | null = null;
  let previewFinalizedAt: number | null = null;
  let finalizeObserved = false;

  // ── Parse-intercepting transport ─────────────────────────
  // Every payload emitted by the producer flows through here. We
  // run `parseServerMessage` BEFORE ack'ing the send so parse
  // failures are counted as authentically as the transport's own
  // accept semantics — a failed parse doesn't halt the emitter; it
  // just flags the frame. That matches the production goal:
  // "defense-in-depth at the renderer's gate, not at the wire."
  //
  // `finalizePreviewChannel` in the orchestrator sends a terminal
  // `{payload: null, complete: true}` envelope AFTER the emitter's
  // real frames. That's a channel-level teardown signal (tells
  // downstream stream readers "no more frames"), not an A2UI
  // message. Filter it out so `frameCount` is semantic — only
  // preview frames, not wire-level teardown.
  const sendEnvelope: SendEnvelopeFn = async (env: HandleStreamEnvelope) => {
    if (env.complete === true && env.payload === null) {
      // Channel teardown, not a frame. `previewFinalizedAt` fires
      // via the terminal outcome; no accounting needed here.
      return {};
    }
    const parsed = parseServerMessage(env.payload);
    if (parsed.ok) {
      parsePassCount += 1;
    } else {
      parseFailCount += 1;
      if (parseIssueSamples.length < PARSE_ISSUE_SAMPLE_CAP) {
        const first = parsed.issues[0];
        parseIssueSamples.push(
          first ? `${first.path.join('.')}: ${first.message}` : 'parse failed',
        );
      }
    }
    frameCount += 1;
    return {};
  };

  // ── Outcome sink ─────────────────────────────────────────
  const onOutcome = (outcome: ProvisionalPreviewOutcome) => {
    switch (outcome.status) {
      case 'first-frame':
        firstFrameAt = outcome.firstFrameAt;
        break;
      case 'completed':
      case 'failed':
      case 'cancelled':
        previewFinalizedAt = outcome.finishedAt;
        finalizeObserved = true;
        if (outcome.status === 'failed') {
          errors.push(`preview failed: ${outcome.error}`);
        }
        break;
      case 'skipped':
      case 'started':
        // No checkpoint impact.
        break;
    }
  };

  const startedAt = now();

  if (!kase.emitterEnabled) {
    // Reserved path — v0 corpus never sets this, but the runner
    // respects it so future "legitimately no preview" cases can
    // exercise the null-as-signal behavior without inventing new
    // orchestration.
    return buildResult(kase, runIndex, {
      startedAt,
      firstFrameAt: null,
      previewFinalizedAt: null,
      handoffGapMs: null,
    }, {
      frameCount: 0,
      parsePassCount: 0,
      parseFailCount: 0,
    }, {
      previewObserved: false,
      finalizeObserved: false,
    }, parseIssueSamples, errors);
  }

  // Adapt the deterministic emitter's context shape to the
  // orchestrator's. The two differ in `emit` variance only:
  //
  //   provisional: `(payload: JsonValue) => Promise<{seq?}>`
  //   determinstic: `(payload: unknown)   => Promise<unknown>`
  //
  // `@ggui-ai/preview-a2ui` is framework-neutral by design — it
  // deliberately avoids a `@ggui-ai/protocol` dep, so it can't
  // narrow `emit` to `JsonValue` at the source. The variance
  // mismatch is a public-boundary consequence of that decision,
  // not a workaround. The adapter below constructs a det context
  // whose `emit` widens the ProvisionalPreviewEmit signature — the
  // assertion is safe because the deterministic emitter's only
  // call-sites are the four hand-written A2UI payloads in
  // `deterministic.ts`, all of which are JsonValue by construction.
  const deterministic = createDeterministicPreviewEmitter();
  const emitter: ProvisionalPreviewEmitter = {
    run: (ctx: ProvisionalPreviewContext) =>
      deterministic.run({
        renderId: ctx.renderId,
        story: ctx.story,
        emit: ctx.emit as (payload: unknown) => Promise<unknown>,
        signal: ctx.signal,
      }),
  };

  const previewDeps: ProvisionalPreviewDeps = {
    config: { enabled: true },
    emitter,
    sendEnvelope,
    onOutcome,
    now,
  };

  const ctx: ProvisionalPreviewRunContext = {
    renderId: `bench-a2ui-${randomUUID()}`,
    appId: `app-a2ui-${kase.id}`,
    story: { intent: kase.intent },
  };

  try {
    const handle = kickoffProvisionalPreview(previewDeps, ctx);
    await handle.done;
  } catch (e) {
    // `kickoffProvisionalPreview` wraps `runProvisionalPreview` in
    // fire-and-forget form — it's not supposed to throw. If it
    // does, record it but DON'T null-out what we already captured.
    errors.push(`runner threw: ${stringifyError(e)}`);
  }

  return buildResult(
    kase,
    runIndex,
    {
      startedAt,
      firstFrameAt,
      previewFinalizedAt,
      handoffGapMs: null,
    },
    {
      frameCount,
      parsePassCount,
      parseFailCount,
    },
    {
      previewObserved: firstFrameAt !== null,
      finalizeObserved,
    },
    parseIssueSamples,
    errors,
  );
}

function buildResult(
  kase: A2uiCase,
  runIndex: number,
  checkpoints: A2uiCheckpoints,
  frames: A2uiFrameAccounting,
  observed: { previewObserved: boolean; finalizeObserved: boolean },
  parseIssueSamples: readonly string[],
  errors: readonly string[],
): A2uiRunResult {
  const tags: A2uiRunTags = {
    caseId: kase.id,
    intentShape: kase.intentShape,
    previewExpected: kase.previewExpected,
    previewObserved: observed.previewObserved,
    finalizeObserved: observed.finalizeObserved,
  };
  return {
    caseId: kase.id,
    runIndex,
    checkpoints,
    frames,
    tags,
    derived: deriveA2uiMetrics(checkpoints, frames),
    parseIssueSamples,
    errors,
  };
}

function defaultNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function stringifyError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}
