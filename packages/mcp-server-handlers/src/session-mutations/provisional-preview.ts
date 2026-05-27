/**
 * Provisional preview orchestration — seam types + pure gating.
 *
 * This module owns the protocol-neutral SEAM the `ggui_push` handler
 * uses to drive a provisional-preview stream on `_ggui:preview`. The
 * runner + cancellation plumbing land in a follow-up commit; this one
 * pins the surface so downstream callers (hosted pod, OSS dev mode)
 * can wire their own emitter + gate without further churn.
 *
 * Key design notes:
 *
 *   - **A2UI-neutral.** The `emit` sink takes a `JsonValue` payload;
 *     schema validation is the renderer's `parseServerMessage` gate,
 *     not ours. This keeps `@ggui-ai/preview-a2ui` out of this
 *     package's dep graph — hosted + OSS callers shape the payload
 *     however they want, the orchestrator just runs the lifecycle.
 *   - **Emitter-as-seam, not LLM-as-dep.** A hosted integration can
 *     inject a Haiku-backed streaming emitter; an OSS dev build can
 *     inject a deterministic skeleton emitter; tests inject a fake.
 *     The handler knows none of them.
 *   - **Fire-and-forget at the push layer.** `ggui_push` returns
 *     synchronously; the preview runs on a background task the
 *     runner owns. Gating decisions happen BEFORE the background
 *     task starts so no useless promise is allocated on skipped
 *     pushes.
 *   - **Outcomes are observable.** `onOutcome` receives every
 *     decision (skipped / started / completed / failed / cancelled)
 *     so hosts can surface timings to their metrics stack without
 *     the orchestrator taking a metrics dependency.
 *
 * Scope discipline for this package:
 *
 *   - NO LLM seams. The emitter is whatever the caller provides;
 *     this file never reaches for a model.
 *   - NO fan-out / transport. The caller-supplied `sendEnvelope`
 *     (same shape used by `handle-stream`) is the only transport.
 *   - NO A2UI types. See `@ggui-ai/preview-a2ui` for the message
 *     shapes the emitter should emit — importing them here would
 *     couple the handler to the A2UI integration package.
 */
import type { JsonValue } from '@ggui-ai/protocol';
import type { SendEnvelopeFn } from './handle-stream.js';

/**
 * Sink handed to the emitter. Writes one provisional-preview payload
 * as an outbound {@link StreamEnvelope} on the reserved preview
 * channel. The inner `sendEnvelope` lives at the caller's transport
 * boundary — OSS wraps `SessionStreamBuffer.record`, hosted wraps
 * the DDB writer.
 *
 * Return value mirrors `SendEnvelopeFn` — `{seq?}` is propagated so
 * seq-aware consumers (OSS today, hosted when it catches up) can
 * correlate emission with replay cursors.
 */
export type ProvisionalPreviewEmit = (
  payload: JsonValue,
) => Promise<{ readonly seq?: number }>;

/**
 * Minimal context handed to the emitter. Deliberately narrow:
 *
 *   - `emit` is the only I/O — no logger, no metrics, no session
 *     store. Emitters that need more pull from whatever DI they
 *     were constructed with.
 *   - `signal` fires on cancellation (handoff to final UI, external
 *     `ggui_pop`, server shutdown). Emitters MUST check it between
 *     async awaits and abort cleanly.
 *   - `now` is a clock override for tests.
 */
export interface ProvisionalPreviewContext {
  readonly renderId: string;
  readonly appId: string;
  /**
   * The `story` block from the `ggui_push` input. `intent` is
   * guaranteed non-empty (filtered in the gate); other fields are
   * passthrough so emitters can read typed hints the agent
   * supplied.
   */
  readonly story: { readonly intent: string } & Record<string, unknown>;
  /** Write a single A2UI-shaped payload to `_ggui:preview`. */
  readonly emit: ProvisionalPreviewEmit;
  /** Fires on cancellation. Emitters check before `emit` calls. */
  readonly signal: AbortSignal;
  /** Clock override. Tests pass a deterministic fn. */
  readonly now: () => number;
}

/**
 * Caller-supplied emitter. Invoked exactly once per push whose gate
 * passes. Returns when the emitter has finished producing frames;
 * the orchestrator then finalizes (deleteSurface + complete
 * envelope — future commit) regardless of normal vs aborted exit.
 */
export interface ProvisionalPreviewEmitter {
  readonly run: (ctx: ProvisionalPreviewContext) => Promise<void>;
}

/**
 * Feature-flag-shaped gate. `enabled` is the top switch;
 * `isEnabledFor` is an optional per-push predicate hosts wire to
 * their traffic-slice / app-config / budget checks.
 */
export interface ProvisionalPreviewConfig {
  /**
   * Global kill-switch. When `false`, every push skips regardless
   * of predicate. Default: false (no surprises in new deployments).
   */
  readonly enabled: boolean;
  /**
   * Per-push override. Receives `appId`, `renderId`, and the
   * resolved `story`. Returning `false` skips with reason
   * `'predicate'`. When omitted, gate passes as long as `enabled`
   * is true and the push shape qualifies.
   */
  readonly isEnabledFor?: (ctx: {
    readonly appId: string;
    readonly renderId: string;
    readonly story: { readonly intent: string } & Record<string, unknown>;
  }) => boolean;
}

/**
 * Every observable outcome of the preview decision + run.
 *
 * Ordering for a qualifying push:
 *
 *   started → (first-frame)? → (completed | failed | cancelled)
 *
 * `first-frame` fires exactly once, only after the first successful
 * `emit`. A run cancelled or failed before the emitter lands a frame
 * never emits `first-frame`; consumers read `firstFrameAt === null`
 * on the terminal outcome to derive the "cancelled before visible
 * output" case.
 *
 * Skipped pushes emit only the `skipped` variant — no other
 * lifecycle events.
 */
export type ProvisionalPreviewOutcome =
  | {
      readonly status: 'skipped';
      readonly reason: ProvisionalPreviewSkipReason;
      readonly renderId: string;
      readonly appId: string;
    }
  | {
      readonly status: 'started';
      readonly renderId: string;
      readonly appId: string;
      readonly startedAt: number;
    }
  | {
      readonly status: 'first-frame';
      readonly renderId: string;
      readonly appId: string;
      readonly startedAt: number;
      /**
       * Clock timestamp at the moment the first accepted emit
       * returned. `firstFrameAt - startedAt` = time-to-first-frame.
       */
      readonly firstFrameAt: number;
    }
  | {
      readonly status: 'completed';
      readonly renderId: string;
      readonly appId: string;
      readonly startedAt: number;
      readonly finishedAt: number;
      readonly frames: number;
      /**
       * Clock timestamp of the first accepted emit, or `null` when
       * the runner completed without ever landing a frame
       * (non-emitting emitter). Propagated through so consumers
       * can compute time-to-first-frame from a single outcome
       * event without tracking state themselves.
       */
      readonly firstFrameAt: number | null;
    }
  | {
      readonly status: 'failed';
      readonly renderId: string;
      readonly appId: string;
      readonly startedAt: number;
      readonly finishedAt: number;
      readonly frames: number;
      readonly firstFrameAt: number | null;
      readonly error: string;
    }
  | {
      readonly status: 'cancelled';
      readonly renderId: string;
      readonly appId: string;
      readonly startedAt: number;
      readonly finishedAt: number;
      readonly frames: number;
      /**
       * `null` when the run was cancelled BEFORE any frame was
       * accepted — consumers read this as "cancelled before
       * visible output", the strongest signal that the push was
       * aborted before the user saw anything.
       */
      readonly firstFrameAt: number | null;
      readonly reason: string;
    };

/**
 * Reasons the gate skips a push. `'disabled'` covers the global
 * kill-switch. The other reasons are per-push structural
 * disqualifications.
 */
export type ProvisionalPreviewSkipReason =
  | 'disabled'
  | 'mcp-apps-push'
  | 'no-story'
  | 'predicate';

/**
 * Deps the `ggui_push` handler accepts when provisional preview is
 * wired in. Absence of this dep is itself the "preview off" signal —
 * no code path in the handler ever surfaces preview without it.
 */
export interface ProvisionalPreviewDeps {
  readonly config: ProvisionalPreviewConfig;
  readonly emitter: ProvisionalPreviewEmitter;
  /**
   * Same shape `handle-stream` takes — the orchestrator reuses the
   * caller's stream adapter so OSS + hosted stay on one transport
   * primitive per environment.
   */
  readonly sendEnvelope: SendEnvelopeFn;
  /** Observation sink. Fires synchronously; MUST not throw. */
  readonly onOutcome?: (outcome: ProvisionalPreviewOutcome) => void;
  /** Clock override. Defaults to `Date.now` inside the runner. */
  readonly now?: () => number;
  /**
   * Optional registry the push handler registers active handles
   * into. External callsites (`apply-stack-item-patch` once
   * `componentCode` lands, session teardown, shutdown) cancel by
   * `renderId` to hand off to the authoritative UI cleanly.
   *
   * Absent registry = no external cancellation site; the preamble
   * simply runs to completion. V1 OSS handoff wiring still lands
   * in a follow-up — the registry seam is in place so that wiring
   * doesn't force another handler signature change.
   */
  readonly registry?: ProvisionalPreviewRegistry;
}

/**
 * In-process registry of active preamble handles keyed by
 * {@link ProvisionalPreviewRunContext.renderId}. The push handler
 * registers on kickoff; the runner clears the entry when its
 * terminal outcome fires. External cancellation points (handoff,
 * teardown) call {@link ProvisionalPreviewRegistry.cancel} by
 * `renderId`.
 *
 * One-instance scope. Distributed deployments (Redis-backed etc.)
 * implement the same surface with their own storage — the push
 * handler doesn't care which implementation it receives.
 */
export interface ProvisionalPreviewRegistry {
  /**
   * Register a running preamble under a key. Typically the key is
   * the `renderId` — one preamble per stack slot at a time.
   * Registering a second handle under the same key cancels the
   * previous one (fire-and-forget) so a duplicate kickoff doesn't
   * leak.
   */
  register(key: string, handle: ProvisionalPreviewHandle): void;
  /**
   * Cancel + remove a preamble. Resolves when the runner has
   * settled (terminal outcome fired). No-op when no preamble is
   * registered under `key`. `reason` is surfaced on the
   * `cancelled` outcome.
   */
  cancel(key: string, reason?: string): Promise<void>;
  /** `true` iff a preamble is currently registered under the key. */
  has(key: string): boolean;
  /**
   * Remove without cancelling. Called by the runner via
   * `handle.done` once the emitter has naturally settled so
   * stale entries don't accumulate.
   */
  clear(key: string): void;
  /**
   * Cancel every active preamble. For server shutdown. Resolves
   * after all runners have settled.
   */
  cancelAll(reason?: string): Promise<void>;
}

/**
 * Pure gating decision. Returns whether to kick off the runner;
 * `skip` variants carry the reason so `onOutcome` can surface a
 * structured skip.
 */
export type ProvisionalPreviewGate =
  | { readonly kind: 'proceed' }
  | {
      readonly kind: 'skip';
      readonly reason: ProvisionalPreviewSkipReason;
    };

/**
 * Arguments the gate reads from the push shape. The handler
 * computes these synchronously before calling the gate; passing
 * them in as a small struct keeps this function pure + testable
 * without reaching into the push input parser.
 */
export interface ProvisionalPreviewGateInput {
  readonly story: { readonly intent: string } | undefined;
  /** `true` when the push is an MCP Apps delivery. */
  readonly isMcpAppsPush: boolean;
}

/**
 * Evaluate whether a push qualifies for provisional preview. Pure
 * function — no side effects, no clock, no transport. The handler
 * calls this with a synchronously-computed view of the push's shape
 * and routes to the runner accordingly.
 *
 * When `deps` is `undefined`, the result is always `{kind: 'skip',
 * reason: 'disabled'}`. That's the "preview not wired at all" case —
 * same reason code as the flag being off so callers don't have to
 * branch.
 */
export function evaluateProvisionalPreviewGate(
  deps: ProvisionalPreviewDeps | undefined,
  input: ProvisionalPreviewGateInput,
  ctx: { readonly appId: string; readonly renderId: string },
): ProvisionalPreviewGate {
  if (!deps || !deps.config.enabled) {
    return { kind: 'skip', reason: 'disabled' };
  }
  if (input.isMcpAppsPush) {
    return { kind: 'skip', reason: 'mcp-apps-push' };
  }
  if (!input.story) {
    return { kind: 'skip', reason: 'no-story' };
  }
  const predicate = deps.config.isEnabledFor;
  if (predicate !== undefined) {
    const ok = predicate({
      appId: ctx.appId,
      renderId: ctx.renderId,
      story: input.story as { readonly intent: string } & Record<string, unknown>,
    });
    if (!ok) return { kind: 'skip', reason: 'predicate' };
  }
  return { kind: 'proceed' };
}

/**
 * Reserved channel the preview envelopes are emitted on. Re-exported
 * from `@ggui-ai/protocol`'s `PREVIEW_CHANNEL` would induce an
 * unnecessary import here — the constant is a stable string literal,
 * so we duplicate it with a test that locks the equality.
 */
export const PROVISIONAL_PREVIEW_CHANNEL = '_ggui:preview';

/**
 * Run-time context the runner computes synchronously from the push
 * handler's resolved state. Structurally distinct from
 * {@link ProvisionalPreviewGateInput} because the runner needs the
 * resolved `renderId` + `renderId` the gate doesn't know about.
 */
export interface ProvisionalPreviewRunContext {
  readonly renderId: string;
  readonly appId: string;
  readonly story: { readonly intent: string } & Record<string, unknown>;
}

/**
 * Handle a fire-and-forget kickoff returns. `controller` lets the
 * caller cancel externally (handoff, session teardown); `done`
 * resolves when the runner has fired its final outcome (so tests
 * can await the terminal state without racing the async runner).
 *
 * Production callers typically discard the handle — the orchestrator
 * owns its own lifetime via the outcome callback and the controller
 * captured wherever cancellation needs to happen.
 */
export interface ProvisionalPreviewHandle {
  readonly controller: AbortController;
  readonly done: Promise<void>;
}

/**
 * Run the caller-supplied emitter with the lifecycle guarantees the
 * orchestrator owns:
 *
 *   1. Fires `onOutcome({status:'started'})` before invoking the
 *      emitter.
 *   2. Wraps `sendEnvelope` into the A2UI-neutral `emit` sink the
 *      emitter consumes. Every successful `emit` increments the
 *      frame counter surfaced on the terminal outcome.
 *   3. Bridges the caller-provided `signal` into both the emit
 *      guard (attempts after abort reject with `AbortError`) and
 *      the emitter context.
 *   4. Fires exactly one terminal outcome —
 *      `completed` / `failed` / `cancelled` — depending on how the
 *      emitter exited.
 *
 * The function NEVER throws. Every thrown path inside resolves via
 * `onOutcome`; that keeps fire-and-forget callers (the push handler)
 * from having to install their own rejection handler.
 *
 * Channel-level teardown (`complete: true` terminal envelope) lands
 * in a follow-up commit once the handoff registry exists.
 */
export async function runProvisionalPreview(
  deps: ProvisionalPreviewDeps,
  ctx: ProvisionalPreviewRunContext,
  signal: AbortSignal,
): Promise<void> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  let frames = 0;
  let firstFrameAt: number | null = null;

  deps.onOutcome?.({
    status: 'started',
    renderId: ctx.renderId,
    appId: ctx.appId,
    startedAt,
  });

  const emit: ProvisionalPreviewEmit = async (payload) => {
    if (signal.aborted) {
      throw new PreviewAbortError('Preview emission aborted');
    }
    const result = await deps.sendEnvelope({
      renderId: ctx.renderId,
      channel: PROVISIONAL_PREVIEW_CHANNEL,
      mode: 'append',
      payload,
    });
    // Only count the frame AFTER the transport has accepted it.
    // Counting before `await` would over-report on transport
    // failures, muddying the `failed`-outcome `frames` field.
    frames += 1;
    if (firstFrameAt === null) {
      // First frame successfully accepted. Record the timing + fire
      // the intermediate `first-frame` outcome so consumers tracking
      // time-to-first-frame don't have to wait for the terminal
      // outcome. One fire per run; the `firstFrameAt === null`
      // guard keeps it idempotent.
      firstFrameAt = now();
      deps.onOutcome?.({
        status: 'first-frame',
        renderId: ctx.renderId,
        appId: ctx.appId,
        startedAt,
        firstFrameAt,
      });
    }
    return result;
  };

  try {
    await deps.emitter.run({
      renderId: ctx.renderId,
      appId: ctx.appId,
      story: ctx.story,
      emit,
      signal,
      now,
    });
    await finalizePreviewChannel(deps, ctx);
    const finishedAt = now();
    // Emitter returned normally. A signal-aborted path commonly
    // throws from `emit`, but a well-behaved emitter that checks
    // `signal.aborted` itself may also return without throwing.
    // Distinguish here so the outcome is accurate either way.
    if (signal.aborted) {
      deps.onOutcome?.({
        status: 'cancelled',
        renderId: ctx.renderId,
        appId: ctx.appId,
        startedAt,
        finishedAt,
        frames,
        firstFrameAt,
        reason: abortReason(signal),
      });
    } else {
      deps.onOutcome?.({
        status: 'completed',
        renderId: ctx.renderId,
        appId: ctx.appId,
        startedAt,
        finishedAt,
        frames,
        firstFrameAt,
      });
    }
  } catch (err) {
    // Attempt teardown regardless of how the emitter failed —
    // best-effort, secondary errors swallowed so the primary
    // failure outcome fires unambiguously.
    await finalizePreviewChannel(deps, ctx);
    const finishedAt = now();
    if (err instanceof PreviewAbortError || signal.aborted) {
      // Prefer the controller's abort reason (carries the explicit
      // caller intent — `'handoff'` / `'superseded'` / etc.) over
      // the internal `PreviewAbortError` sentinel. The sentinel is
      // an implementation detail of how the emit guard signals
      // mid-stream abort; the abort reason is the caller's story.
      deps.onOutcome?.({
        status: 'cancelled',
        renderId: ctx.renderId,
        appId: ctx.appId,
        startedAt,
        finishedAt,
        frames,
        firstFrameAt,
        reason: signal.aborted
          ? abortReason(signal)
          : err instanceof PreviewAbortError
            ? err.message
            : 'signal-aborted',
      });
      return;
    }
    deps.onOutcome?.({
      status: 'failed',
      renderId: ctx.renderId,
      appId: ctx.appId,
      startedAt,
      finishedAt,
      frames,
      firstFrameAt,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Emit the terminal channel-close envelope: `{payload: null,
 * complete: true}`. Clients consuming `_ggui:preview` observe the
 * `complete` latch flip and know the server will emit no further
 * frames on this channel.
 *
 * Emitter-level surface teardown (`deleteSurface`) is the
 * emitter's responsibility on its happy path — the runner can't
 * synthesise a matching `deleteSurface` without knowing the
 * surfaceId the emitter chose, and reaching into the A2UI message
 * shape would couple the orchestrator to preview-a2ui. V1
 * convention: emitters emit their own `deleteSurface`; the runner
 * guarantees the channel-level close regardless of emitter
 * behaviour.
 *
 * Best-effort — secondary transport failures during teardown are
 * swallowed so the primary outcome callback (`completed` /
 * `failed` / `cancelled`) remains the single source of truth.
 */
async function finalizePreviewChannel(
  deps: ProvisionalPreviewDeps,
  ctx: ProvisionalPreviewRunContext,
): Promise<void> {
  try {
    await deps.sendEnvelope({
      renderId: ctx.renderId,
      channel: PROVISIONAL_PREVIEW_CHANNEL,
      mode: 'append',
      payload: null,
      complete: true,
    });
  } catch {
    // Swallow. The primary outcome tells the story; a secondary
    // transport failure on the teardown frame isn't worth
    // reclassifying a `completed` run as `failed`.
  }
}

/**
 * Kick off {@link runProvisionalPreview} as a background task. Call
 * from within `ggui_push` after the gate passes; the caller can
 * then return the push response without awaiting the preview.
 *
 * Returns a {@link ProvisionalPreviewHandle} carrying the
 * `AbortController` (for external cancellation) and a `done`
 * Promise tests can `await` to synchronize on the terminal outcome.
 * Production callers typically ignore both fields.
 */
export function kickoffProvisionalPreview(
  deps: ProvisionalPreviewDeps,
  ctx: ProvisionalPreviewRunContext,
): ProvisionalPreviewHandle {
  const controller = new AbortController();
  const done = runProvisionalPreview(deps, ctx, controller.signal);
  return { controller, done };
}

/**
 * Internal sentinel so the runner can distinguish its own abort
 * from an unrelated emitter exception that happens to read
 * `signal.aborted` after the fact. `DOMException` isn't available
 * on every Node runtime we target; a dedicated class keeps the
 * check ergonomic and platform-independent.
 */
export class PreviewAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreviewAbortError';
  }
}

/**
 * Read the abort reason off a signal as a plain string. Prefers the
 * explicit `controller.abort(reason)` value; falls back to
 * `'signal-aborted'` when the abort was triggered without a reason.
 * Non-string reasons (Error instances, symbols, etc.) coerce via
 * `String(...)` so the outcome field stays a `string`.
 */
function abortReason(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  if (reason === undefined || reason === null) return 'signal-aborted';
  if (typeof reason === 'string') return reason;
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

/**
 * Authoritative-handoff helper. Call from the handler that commits
 * final component code (hosted pod's generation-complete path, any
 * future OSS final-code handler) to tear down the in-flight
 * provisional preview cleanly.
 *
 * Semantics:
 *   - Cancels the preview registered under `renderId` on the supplied
 *     registry. The registry's own `cancel` aborts the runner and
 *     awaits settle, so this helper resolves only once the
 *     `cancelled` outcome has fired with the supplied reason.
 *   - No-op when no preview is registered (e.g., preview was off
 *     for this push, or the preamble already completed naturally
 *     before the final code arrived).
 *   - Default `reason` is `'handoff'` so consumers reading the
 *     `cancelled.reason` field can distinguish authoritative
 *     handoff from session teardown (`'cancel-all'` / shutdown) or
 *     duplicate-push supersession (`'superseded'`).
 *
 * This is deliberately a thin wrapper. Future work (metrics on
 * handoff, structured logging, observer notifications) lands here
 * without forcing every call site to rewrite. Callers always
 * express the intent via `finalizeProvisionalPreview`, not direct
 * `registry.cancel` calls.
 */
export async function finalizeProvisionalPreview(
  registry: ProvisionalPreviewRegistry,
  renderId: string,
  reason: string = 'handoff',
): Promise<void> {
  await registry.cancel(renderId, reason);
}

/**
 * Reference in-memory implementation of
 * {@link ProvisionalPreviewRegistry}. Single-instance scope —
 * suitable for OSS dev, hosted pods, and tests; multi-replica
 * deployments bring their own distributed implementation.
 *
 * Behaviour:
 *   - `register` replaces any existing handle under the same key,
 *     cancelling the previous one via its controller. Prevents
 *     duplicate kickoffs on the same renderId from leaking.
 *   - Auto-clears entries when the handle's `done` settles, so
 *     natural completions don't accumulate stale keys.
 *   - `cancel` aborts + awaits settlement. `cancelAll` fans out
 *     in parallel.
 */
export function createInMemoryProvisionalPreviewRegistry(): ProvisionalPreviewRegistry {
  const active = new Map<string, ProvisionalPreviewHandle>();

  return {
    register(key, handle) {
      const previous = active.get(key);
      if (previous && previous !== handle) {
        // Duplicate kickoff. Cancel the old one but don't await —
        // register() must return synchronously for push.ts's
        // fire-and-forget path.
        previous.controller.abort('superseded');
      }
      active.set(key, handle);
      // Auto-clean on natural settle. Guard against late-arriving
      // settlement after a `clear()` / new `register()` so we
      // don't delete a successor entry.
      void handle.done.finally(() => {
        if (active.get(key) === handle) active.delete(key);
      });
    },
    has(key) {
      return active.has(key);
    },
    async cancel(key, reason) {
      const handle = active.get(key);
      if (!handle) return;
      active.delete(key);
      handle.controller.abort(reason ?? 'cancelled');
      try {
        await handle.done;
      } catch {
        // `done` shouldn't reject — the runner swallows into
        // `onOutcome` — but be defensive.
      }
    },
    clear(key) {
      active.delete(key);
    },
    async cancelAll(reason) {
      const pairs = Array.from(active.entries());
      active.clear();
      await Promise.all(
        pairs.map(async ([, h]) => {
          h.controller.abort(reason ?? 'cancel-all');
          try {
            await h.done;
          } catch {
            // Defensive — see `cancel` above.
          }
        }),
      );
    },
  };
}
