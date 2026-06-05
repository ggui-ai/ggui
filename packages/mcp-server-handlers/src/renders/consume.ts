/**
 * `createGguiConsumeHandler` — long-poll fetch-and-clear for buffered
 * agent-bound events on a render.
 *
 * Lifted from cloud pod's parallel `consume.ts` so OSS gets parity:
 * `ggui_consume` is now real on `@ggui-ai/mcp-server`, completing
 * the FF nextStep → consume hint chain end-to-end.
 *
 * Architecture:
 *   - `pendingEventConsumer` (the {@link PendingEventConsumer} seam
 *     from `@ggui-ai/mcp-server-core`) owns the atomic fetch-and-clear
 *     contract. The standalone server uses in-memory / SQLite; a
 *     cloud deployment wraps an atomic-read-and-clear datastore op.
 *   - `renderStore.get(sessionId)` resolves the render, tenancy-checks
 *     via `ctx.appId`, and reads TTL for the activity heartbeat.
 *   - Long-poll is server-side (1-900s, default cap 900s). The
 *     original 25s ceiling assumed an API Gateway 30s kill in front
 *     of the handler; that constraint went away when cloud migrated
 *     to ECS Fargate pods (no gateway) and OSS has always been
 *     gateway-free. Deployments that still front the handler with a
 *     short-killing proxy can lower the cap via `maxTimeoutSeconds`.
 *
 * Output schema mirrors the cloud handler verbatim:
 * `{events: ConsumeEventEntry[], status: GguiSessionStatus}`. Each row is
 * normalized to canonical `PendingEvent` then unwrapped to its
 * `envelope` payload via `parsePendingEnvelope` so SDK consumers
 * read the per-gesture entry shape directly.
 *
 * Post-Phase-B (flatten-render-identity): collapsed from the prior
 * `{stackItemId}` input + session/stack-item double-resolution into a
 * single `{sessionId}` input + one render lookup. The pending-events
 * pipe is keyed by `sessionId` (was `stackItemId`); the value is the
 * same.
 */

import { z } from 'zod';
import { clientObservationsSchema } from './client-observations.js';
import {
  parsePendingEnvelope,
  type ConsumeEventEntry,
  type GguiConsumeOutput,
  type PendingEvent,
  type GguiSessionStatus,
} from '@ggui-ai/protocol';
import {
  type ActiveConsumerRegistry,
  type PendingEventConsumer,
  type GguiSessionStore,
} from '@ggui-ai/mcp-server-core';
import type { HandlerContext, SharedHandler } from '../types.js';
import { GguiSessionNotFoundError } from './errors.js';

/**
 * Default server-side cap on the actual inline long-poll wait —
 * silently truncates requests above this value. Lowered to 120s on
 * 2026-05-13 after live claude.ai smoke: a 300s long-poll completed
 * server-side (`elapsedMs:300516, outcome:success`) but the host's
 * MCP client + LLM-session timer had both aborted the conversation
 * before the response reached the model, surfacing as opaque
 * "Error occurred during tool execution". 120s is empirically
 * tolerated end-to-end (the user's own observation post-fix: a 120s
 * poll AND its subsequent request both succeeded).
 *
 * The schema-level cap (`timeout.max`) is set higher (600s) so the
 * agent CAN request more on deployments that override
 * `maxTimeoutSeconds` upward — but the default OSS posture caps to
 * 120s.
 *
 * Operators with stricter gateways override lower; operators with
 * looser transports (CLI agents, websocket) override higher.
 */
const DEFAULT_MAX_TIMEOUT_SECONDS = 120;
/** Polling interval inside the long-poll loop. 1.5s balances
 *  perceived latency against read cost on cloud. OSS is in-memory
 *  but the same value keeps tests + behavior identical. */
const POLL_INTERVAL_MS = 1500;

const inputSchema = {
  sessionId: z
    .string()
    .min(1)
    .describe(
      'Globally-unique sessionId to consume events from. Cross-tenant access surfaces uniformly as session_not_found.',
    ),
  timeout: z
    .number()
    .int()
    .min(0)
    .max(600)
    .optional()
    .describe(
      'Inline long-poll seconds. 0 = immediate. **Recommended 60-120s.** Server caps at 120s by default (silently truncated). Values 300+ are empirically unsafe — host MCP clients (claude.ai, Claude Desktop) abort longer tool calls. Returns on first event OR timeout; re-call on empty to keep waiting.',
    ),
} as const;

const outputSchema = {
  events: z.array(z.record(z.string(), z.unknown())),
  status: z.string(),
  // same `client.hostContext` surface
  // handshake exposes. Lets the agent pick up mid-render changes
  // (window resize, user toggling fullscreen, etc.) on its next
  // consume hit without waiting for the next handshake.
  client: clientObservationsSchema,
} as const;

/**
 * Optional observer-notification seam. Cloud uses this to fan a
 * `ggui_consume` tool-call event onto its observer WebSocket so
 * builders watching a render see consume hits. OSS leaves absent
 * by default; the handler short-circuits its observer call when
 * the seam is missing.
 */
export interface ObserverNotifier {
  notifyToolCall(args: {
    readonly appId: string;
    readonly tool: string;
    readonly sessionId: string;
    readonly args: Record<string, unknown>;
    readonly result: {
      readonly eventCount: number;
      readonly eventTypes: ReadonlyArray<string>;
      readonly status: string;
    };
  }): void;
}

/**
 * Drain-ack notifier. Fires once per event the consume handler pops
 * from a render's pending-events pipe — the iframe-runtime listens
 * on its existing WS connection and uses these frames to dismiss the
 * matching per-action toast.
 *
 * `mcp-server`'s `GguiSessionChannelServer.sendDrainAck` implements this
 * contract; the handler depends on the narrowed shape so the handlers
 * package doesn't take a peer dep on the full render-channel surface
 * (parallels `PropsUpdateNotifier` in `update.ts`).
 *
 * Hosts without a render channel leave this absent — the pop still
 * commits, the live frame just isn't fanned.
 */
export interface DrainAckNotifier {
  sendDrainAck(args: {
    readonly sessionId: string;
    readonly appId: string;
    readonly eventId: string;
    readonly drainedAt: string;
  }): void;
}

/**
 * Minimal structured-event logger seam. The handler emits
 * `action_consume_slow` info-events when an event sat in the pipe
 * longer than the yellow-flag threshold (>2s submit → drain). Absent
 * → no telemetry; the handler is otherwise unchanged.
 */
export interface ConsumeLogger {
  info(event: string, fields: Record<string, unknown>): void;
}

export interface GguiConsumeHandlerDeps {
  readonly pendingEventConsumer: PendingEventConsumer;
  readonly renderStore: GguiSessionStore;
  /** Default render TTL in seconds when the render row carries
   *  no explicit ttl. Cloud reads from config; OSS reads from
   *  ggui.json. Falls back to ~1 day on absence. */
  readonly defaultRenderTtlSeconds?: number;
  /**
   * Upper bound on the inline long-poll wait, in seconds. Defaults
   * to 30 (the schema's `timeout.max`, lowered from 900 on
   * 2026-05-13 after live claude.ai smoke confirmed MCP host
   * clients abort longer tool calls AND the LLM session). Override
   * to an EVEN lower value only when fronted by a proxy that kills
   * HTTP connections sooner.
   */
  readonly maxTimeoutSeconds?: number;
  /** Optional observer fan-out. Cloud-only by default. */
  readonly observerNotifier?: ObserverNotifier;
  /**
   * Optional drain-ack notifier. When bound, the handler
   * fires one `drain_ack` WS frame per drained event so the iframe-
   * runtime can resolve its per-action toast as `consumed`. Absent →
   * no frame; iframe's 10s claim timer handles the gap (cleanly
   * resolved by the server's atomic pop).
   */
  readonly drainAckNotifier?: DrainAckNotifier;
  /**
   * Optional structured-event sink. Logs
   * `action_consume_slow` info-events when submit → drain latency
   * exceeds the yellow-flag threshold. Absent → no telemetry.
   */
  readonly logger?: ConsumeLogger;
  /**
   * Optional active-consumer awareness seam. When bound, the handler
   * calls `enter(sessionId)` at the top of the long-poll and
   * `exit(sessionId)` in `finally` so a concurrent
   * `ggui_runtime_submit_action` append can query `hasActive` and
   * surface `consumerPresent: false` to the iframe when no long-poll
   * is registered for the targeted render — the iframe then emits
   * a `ui/message` queued-userAction nudge IMMEDIATELY instead of
   * waiting for a drain. Absent → submit-action omits `consumerPresent`
   * and the iframe assumes a consumer is present.
   */
  readonly activeConsumerRegistry?: ActiveConsumerRegistry;
  /**
   * Canvas-mode lifecycle emitter. Fires
   * `consume_polling:open` on the `_ggui:lifecycle` channel when the
   * handler enters its inline long-poll loop so the canvas animator
   * transitions to its `listening` state. Closing is signalled by
   * the existing `drain_ack` envelope (action consumed) — no
   * dedicated `consume_polling:closed` emission.
   *
   * Absent ⇒ no emission. Non-canvas deployments pay zero cost.
   */
  readonly canvasLifecycle?: import('./canvas-lifecycle.js').CanvasLifecycleEmitter;
}

/**
 * Yellow-flag threshold for the `action_consume_slow` signal. Events
 * that sat in the pipe longer than this between submit and drain
 * fire an info-level telemetry event so operators can spot agents
 * with sluggish long-poll cadence (healthy: <100ms).
 */
const CONSUME_SLOW_THRESHOLD_MS = 2000;

interface ConsumeResultRaw {
  readonly events: ReadonlyArray<Record<string, unknown>>;
  readonly status: GguiSessionStatus;
}

const DEFAULT_TTL_SECONDS = 24 * 60 * 60; // 1 day

export function createGguiConsumeHandler(
  deps: GguiConsumeHandlerDeps,
): SharedHandler<typeof inputSchema, typeof outputSchema, GguiConsumeOutput> {
  return {
    name: 'ggui_consume',
    title: 'Consume',
    audience: ['agent'],
    description:
      'Long-poll for buffered events on a render. CALL THIS RIGHT AFTER EVERY `ggui_render` THAT RETURNS `nextStep.tool === "ggui_consume"` — that hint is your cue to start listening for the user\'s gesture. Keyed by sessionId (global UUID); tenancy-checked via ctx.appId. Inline long-poll supported up to a deployment cap (default 30s — host MCP clients abort longer tool calls; pick 5-15s typical, 30s max). Returns `{events, status}` — each event carries `{intent, actionData, uiContext, actionId, firedAt}`: `actionData` is WHAT the user did, `uiContext` is the iframe-local snapshot of the contract\'s contextSpec slots AT THE MOMENT they did it. Both inform your reaction without a second round trip. Returns immediately when an action event arrives OR the render completes OR the timeout elapses. On timeout with no event, re-call ggui_consume to keep waiting.  THE LOOP: when `events` is non-empty, REACT, then re-call `ggui_consume` to wait for the next event. Exit only when status:"expired".  IMPORTANT — the iframe state is independent of your backend state: after you mutate via domain tools (todo_toggle, cart_add, etc.), the UI still shows the OLD props until you call `ggui_update`. If the events caused observable state changes the user is looking at, your reaction MUST include `ggui_update` somewhere before re-consuming; otherwise the user sees stale props (the #1 wire compliance bug). Pure-info events that don\'t change displayed state can skip ggui_update. You decide the call order and which tools you need — the protocol just guarantees that `ggui_update` is the way to refresh the iframe.  HOSTS WITH PROGRESSIVE TOOL DISCOVERY (claude.ai-style connectors): if a call here errors with "tool not loaded yet" or "wrong parameter names," call `tool_search({query:"ggui_consume"})` once to warm the tool, then retry with the same args. DO NOT skip the consume — silent gesture drops are the worst protocol failure.',
    inputSchema,
    outputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<GguiConsumeOutput> {
      const { sessionId, timeout = 0 } = z.object(inputSchema).parse(rawInput);

      // Register this long-poll on the active-consumer registry IMMEDIATELY
      // — before the tenancy resolution awaits — so a concurrent
      // `submit-action.ts` append observes `hasActive: true` for the
      // earliest possible window. `exit` is paired in `finally` below so
      // every termination path (success, timeout, error, tenancy reject)
      // decrements the count exactly once.
      deps.activeConsumerRegistry?.enter(sessionId);
      try {
        // Resolve render. Cross-tenant + missing surface uniformly as
        // session_not_found (don't leak whether the id exists in another
        // tenant).
        const stored = await deps.renderStore.get(sessionId);
        if (!stored || stored.appId !== ctx.appId) {
          throw new GguiSessionNotFoundError(sessionId);
        }

        const maxTimeoutSeconds =
          deps.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS;
        const cappedTimeout = Math.min(
          Math.max(timeout, 0),
          maxTimeoutSeconds,
        );
        const deadline = Date.now() + cappedTimeout * 1000;
        const ttlMs = resolveTtlMs(
          stored,
          deps.defaultRenderTtlSeconds ?? DEFAULT_TTL_SECONDS,
        );

        // The pending-event pipe is keyed by sessionId. The render
        // lookup above is purely a tenancy gate; pipe reads use
        // sessionId directly.
        let result = await fetchAndClearSafe(
          deps.pendingEventConsumer,
          sessionId,
          ttlMs,
        );

        // Long-poll loop — only engages when the first read returned
        // nothing AND the pipe is still active. Expired pipes
        // short-circuit because there will never be new events.
        if (
          cappedTimeout > 0 &&
          result.events.length === 0 &&
          result.status !== 'expired'
        ) {
          // emit consume_polling:open so the canvas animator
          // transitions to its `listening` state. We only emit once
          // per consume call (not on every poll tick) because the
          // closing transition relies on the absence of further opens
          // for the same render; spamming would mask the close signal.
          // Fire-and-forget — absent emitter no-ops.
          deps.canvasLifecycle?.emit(sessionId, {
            kind: 'consume_polling',
            state: 'open',
            sessionId,
          });
          while (Date.now() < deadline) {
            // Abort-awareness. `ctx.signal` fires when the inbound
            // `tools/call` is cancelled — the agent SDK aborting its
            // loop (browser reload → agent-server SSE abort → SDK
            // abort) surfaces here as a `notifications/cancelled` OR a
            // transport close. Breaking promptly lets `finally` run
            // `activeConsumerRegistry.exit(sessionId)` NOW, so a
            // concurrent post-reload `ggui_runtime_submit_action`
            // reads `hasActive: false` and the iframe rings the
            // recovery doorbell instead of suppressing it against a
            // zombie consumer that would only drain into the void.
            //
            // Check at the top of each tick (catches an abort that
            // landed during the prior `fetchAndClearSafe`) and again by
            // racing the sleep below (catches a mid-sleep abort without
            // waiting out the full 1.5s tick).
            if (ctx.signal?.aborted) {
              break;
            }
            await sleepUntilAbort(POLL_INTERVAL_MS, ctx.signal);
            if (ctx.signal?.aborted) {
              break;
            }
            result = await fetchAndClearSafe(
              deps.pendingEventConsumer,
              sessionId,
              ttlMs,
            );
            if (result.events.length > 0 || result.status === 'expired') {
              break;
            }
          }
        }

        // Normalize each row to canonical PendingEvent shape, then emit
        // the stored ConsumeEventEntry directly — the pipe IS the source
        // of truth for the {intent, actionData, uiContext, ...} shape
        // (see submit-action.ts kind:'dispatch' branch).
        const parsed: PendingEvent[] = result.events.map((raw) =>
          normalizeEvent(raw),
        );
        const events: ConsumeEventEntry[] = parsed.map((pe) =>
          parsePendingEnvelope(pe.envelope),
        );

        // drain_ack fan-out + slow-consume telemetry. One frame per
        // drained event so the iframe-runtime can match by `eventId`
        // and dismiss the matching toast. Yellow-flag info-event for
        // events that sat in the pipe longer than the consume_slow
        // threshold — operators see protocol-adherence degradation
        // before it hits the red-flag claim_timeout path. Both are
        // best-effort; thrown errors never fail the consume tool call.
        if (parsed.length > 0) {
          const drainedAt = new Date().toISOString();
          const drainedAtMs = Date.parse(drainedAt);
          for (const pe of parsed) {
            if (deps.logger) {
              const submittedAtMs = Date.parse(pe.createdAt);
              if (Number.isFinite(submittedAtMs)) {
                const latencyMs = drainedAtMs - submittedAtMs;
                if (latencyMs > CONSUME_SLOW_THRESHOLD_MS) {
                  try {
                    deps.logger.info('action_consume_slow', {
                      sessionId,
                      appId: ctx.appId,
                      eventId: pe.id,
                      latencyMs,
                      thresholdMs: CONSUME_SLOW_THRESHOLD_MS,
                    });
                  } catch {
                    /* logger faults must not fail the tool call */
                  }
                }
              }
            }
            if (deps.drainAckNotifier && pe.id.length > 0) {
              try {
                deps.drainAckNotifier.sendDrainAck({
                  sessionId,
                  appId: ctx.appId,
                  eventId: pe.id,
                  drainedAt,
                });
              } catch {
                /* notifier faults are absorbed; the consume tool call
                 * still returns the drained events. Missing the drain_ack
                 * frame just leaves a transient toast on the iframe. */
              }
            }
          }
        }

        // Optional observer fan-out — only when events were actually
        // returned. Firing on empty long-poll cycles would spam the
        // observer surface.
        if (events.length > 0 && deps.observerNotifier) {
          const eventTypes = events.map((e) => e.type ?? 'unknown');
          deps.observerNotifier.notifyToolCall({
            appId: ctx.appId,
            tool: 'ggui_consume',
            sessionId,
            args: { timeout: cappedTimeout },
            result: {
              eventCount: events.length,
              eventTypes,
              status: result.status,
            },
          });
        }

        // 2026-05-14 — top-level `contextSnapshot` retired. Each drained
        // event now carries its own `uiContext` snapshot captured at
        // gesture time on the iframe (see submit-action.ts), so consume's
        // output is just `{events, status}`. The pipe is the single
        // source of truth.
        //
        // `stored.hostContext` is now surfaced so the agent picks up
        // mid-render changes without waiting for the next handshake.
        // Wrapper omitted when no projection exists yet.
        return {
          events,
          status: result.status ?? ('active' as GguiSessionStatus),
          ...(stored.hostContext !== undefined
            ? { client: { hostContext: stored.hostContext } }
            : {}),
        };
      } finally {
        deps.activeConsumerRegistry?.exit(sessionId);
      }
    },
  };
}

/**
 * Wrap consumeAndClear to map `PendingPipeNotFoundError` (race with
 * `markDeleted` from a paired close during long-poll) to an
 * empty-events result rather than throwing. The long-poll shouldn't
 * erase the render out from under a still-listening caller — if
 * the pipe truly vanished, returning empty + a fresh ownership
 * failure on the next call is the honest wire shape.
 */
async function fetchAndClearSafe(
  consumer: PendingEventConsumer,
  sessionId: string,
  ttlMs: number,
): Promise<ConsumeResultRaw> {
  try {
    const r = await consumer.consumeAndClear(sessionId, ttlMs);
    return { events: r.events, status: r.status };
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === 'PendingPipeNotFoundError' ||
        err.name === 'GguiSessionNotFoundError')
    ) {
      // Treat mid-long-poll disappearance as 'expired' to unblock
      // callers without forcing them to handle yet another error.
      return { events: [], status: 'expired' };
    }
    throw err;
  }
}

/** Coerce raw row into canonical {@link PendingEvent} shape. */
function normalizeEvent(raw: Record<string, unknown>): PendingEvent {
  const envelope = raw.envelope as PendingEvent['envelope'];
  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    envelope,
    sequence: typeof raw.sequence === 'number' ? raw.sequence : 0,
    createdAt:
      typeof raw.createdAt === 'string'
        ? raw.createdAt
        : new Date().toISOString(),
  };
}

/** Resolve the activity-bump TTL from the render row, falling back
 *  to the configured default. Renders with infinite TTL pass
 *  Number.MAX_SAFE_INTEGER. */
function resolveTtlMs(
  stored: { readonly expiresAt?: number; readonly createdAt?: number },
  defaultTtlSeconds: number,
): number {
  if (
    stored.expiresAt !== undefined &&
    stored.createdAt !== undefined &&
    stored.expiresAt > stored.createdAt
  ) {
    return stored.expiresAt - stored.createdAt;
  }
  return defaultTtlSeconds * 1000;
}

/**
 * Sleep for `ms` OR until `signal` aborts, whichever comes first —
 * always resolving (never rejecting), so the long-poll loop's own
 * `ctx.signal?.aborted` checks own the break decision and an aborted
 * consume returns a clean empty result rather than throwing an
 * unhandled `AbortError`.
 *
 * When `signal` is already aborted on entry the timer is never armed —
 * resolves on the next microtask. The abort listener is removed on
 * resolve so a long-lived signal (one request, many poll ticks)
 * doesn't accumulate listeners across the loop.
 */
function sleepUntilAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
