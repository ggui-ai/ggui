/**
 * `ggui_runtime_pull` — terminal bridge-pull rung of the live-channel
 * failover ladder (WS → SSE → HTTP polling → bridge-pull).
 *
 * In a CSP-jailed MCP Apps host (claude.ai) the iframe can reach NO
 * network origin — no WS, no SSE, no HTTP polling. The one channel it
 * always has is the host's `tools/call` postMessage bridge. This tool
 * serves the GguiSessionEvent ledger over that bridge: the
 * `@ggui-ai/iframe-runtime` bridge rung pulls it on a flat interval,
 * reusing the SAME cursor-walk algorithm (and the same parse core) as
 * its HTTP `/events` polling rung, with `tools/call` as the carrier.
 *
 * **Wire shape** (what iframe-runtime postMessages via `tools/call`
 * and the host relays to the MCP server):
 *
 * ```jsonc
 * {
 *   "method": "tools/call",
 *   "params": {
 *     "name": "ggui_runtime_pull",
 *     "arguments": {
 *       "sessionId":     "rnd_…",  // bootstrap.sessionId
 *       "sinceSequence": 12,       // replay cursor; omit = 0
 *       "limit":         100       // page size; clamped to 100
 *     }
 *   }
 * }
 * ```
 *
 * **Output = EXACT `EventsResponse` parity** with
 * `GET /api/sessions/:sessionId/events` (`@ggui-ai/mcp-server`'s
 * `api-renders-routes.ts`) — both read the ledger through the same
 * `GguiSessionStore.listEventsSince` and answer with the same two
 * shapes, so the client reuses one parse core across carriers:
 *
 *   - Normal page: `{events, lastSequence, hasMore}` — events strictly
 *     ascending by seq with `seq > sinceSequence`, `lastSequence` = the
 *     render's high-water mark (advances the cursor even on an empty
 *     page), `hasMore` = the page was truncated by `limit` (client
 *     SHOULD immediately re-pull with the advanced cursor).
 *   - Horizon: `{reason: 'REPLAY_HORIZON_PASSED', currentSequence}` — a
 *     NORMAL result arm, not an error (the bridge rung is terminal;
 *     this is a re-sync instruction, mirroring the route's 410 body).
 *     Returned when the cursor fell out of the replayable window on
 *     EITHER side: `sinceSequence > lastSequence` (cursor from a
 *     different deployment / reset render) or
 *     `sinceSequence < horizonSeq` (events evicted from the bounded
 *     retention window). Client recovery: re-mount from a fresh
 *     snapshot and reset the cursor to `currentSequence`.
 *
 * **Failure modes:**
 *   - Unknown sessionId, cross-app sessionId, and a render deleted
 *     mid-read all surface uniformly as
 *     {@link GguiSessionNotFoundError} — no cross-app existence
 *     leak (app-scope gate: `renderStore.get` + `ctx.appId`).
 *   - Malformed input (empty sessionId, negative cursor, `limit < 1`)
 *     rejects at the zod boundary.
 *
 * **Visibility.** Registered with `_meta.ui.visibility: ['app']` so
 * MCP Apps hosts route iframe-issued `tools/call` to this handler per
 * spec §401 — REQUIRED: without it hosts reject view-issued calls, and
 * the terminal rung goes dark exactly where it is the only channel
 * left. Outer agents don't see the tool — ledger replay is a runtime
 * concern, not an agent gesture.
 *
 * Deliberate divergences from the `/events` route, per the bridge-pull
 * ruling: `sinceSequence` is optional (`?? 0` — the bridge rung owns
 * its cursor), and `limit` above {@link RUNTIME_PULL_MAX_LIMIT} is
 * CLAMPED, not rejected.
 */
import { z } from 'zod';
import {
  RUNTIME_PULL_MAX_LIMIT,
  RUNTIME_PULL_MAX_WAIT_SECONDS,
  runtimePullEventsPageSchema,
  runtimePullHorizonSchema,
  runtimePullInputShape,
} from '@ggui-ai/protocol';
import type { GguiSessionStore } from '@ggui-ai/mcp-server-core';
import { defineHandler, type HandlerContext, type ShapeOutput } from '../types.js';
import { GguiSessionNotFoundError } from './errors.js';

// Canonical SSoT shape — authored once in `@ggui-ai/protocol`
// (`schemas/mcp.ts`), same wiring as `ggui_get_session`.
const inputSchema = runtimePullInputShape;

// Flat raw shape for MCP tool registration — a `ZodRawShape` cannot
// express the top-level two-arm union, so every field of both arms is
// optional here and the canonical strict contract stays
// `runtimePullOutputSchema` (`@ggui-ai/protocol`). The alignment tests
// in `runtime-pull.test.ts` pin this shape to the union key-for-key —
// same posture as `ggui_update`'s input.
// The protocol owns both arms of this output (`runtimePullOutputSchema` is
// their union); the MCP tool root must be one object, so the registration
// flattens the two arms into one optional-field shape. Every field TYPE is
// the protocol's; only the optionality of the flattening is stated here.
const outputSchema = {
  /** Normal page only — ledger rows with `seq > sinceSequence`, ascending. */
  events: runtimePullEventsPageSchema.shape.events.optional(),
  /** Normal page only — the render's current high-water mark (cursor floor on empty pages). */
  lastSequence: runtimePullEventsPageSchema.shape.lastSequence.optional(),
  /** Normal page only — `true` when `limit` truncated the page; re-pull immediately. */
  hasMore: runtimePullEventsPageSchema.shape.hasMore.optional(),
  /** Horizon arm only — the cursor fell out of the replayable window (normal result, not an error). */
  reason: runtimePullHorizonSchema.shape.reason.optional(),
  /** Horizon arm only — reset the cursor here after re-mounting from a snapshot. */
  currentSequence: runtimePullHorizonSchema.shape.currentSequence.optional(),
} as const;
/** The wire shape — derived from the registered fields (#817). */
type RuntimePullOutput = ShapeOutput<typeof outputSchema>;

export interface GguiRuntimePullHandlerDeps {
  /**
   * The same store `ggui_render` commits to and the `/events` route
   * reads from — one ledger, two carriers. The handler needs both
   * `get` (app-scope gate) and `listEventsSince` (cursor read).
   */
  readonly renderStore: GguiSessionStore;
  /**
   * Subscription-mode hold probe cadence, in ms. During a `wait` hold
   * the handler re-reads the ledger at this interval — deliberately a
   * store poll rather than an in-process wake seam, because the
   * update that ends the hold may land on a DIFFERENT replica (the store
   * is the only cross-replica truth this package may assume). Defaults to
   * 1000. Test hook: inject a small value for deterministic hold
   * tests without fake timers.
   */
  readonly waitProbeIntervalMs?: number;
}

/**
 * Build the `ggui_runtime_pull` handler. Registers as app-visible so
 * MCP Apps hosts route iframe-issued `tools/call` to it per spec §401.
 */
export function createGguiRuntimePullHandler(deps: GguiRuntimePullHandlerDeps) {
  return defineHandler({
    name: 'ggui_runtime_pull',
    title: '[runtime] Pull Events',
    audience: ['runtime'],
    description:
      'Serves the GguiSessionEvent ledger over the host\'s tools/call postMessage bridge — the terminal failover rung for iframes whose CSP blocks every network channel. Cursor-replay semantics identical to the HTTP events endpoint: returns {events, lastSequence, hasMore} for a live cursor, or {reason: "REPLAY_HORIZON_PASSED", currentSequence} as a NORMAL result when the cursor fell out of the replayable window (client re-mounts from a snapshot and resets its cursor). Never invoked by the model directly — `_meta.ui.visibility: [\'app\']` restricts callers to MCP Apps views per spec §401; the iframe holds no auth credential so the host is the relay party.',
    inputSchema,
    outputSchema,
    _meta: {
      ui: {
        // Spec §401: only an MCP Apps view (iframe) can call.
        // Outer agent does NOT see this tool.
        visibility: ['app'] as const,
      },
    },
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<RuntimePullOutput> {
      const parsed = z.object(inputSchema).parse(rawInput);
      const { sessionId } = parsed;
      const sinceSequence = parsed.sinceSequence ?? 0;
      const limit = Math.min(
        parsed.limit ?? RUNTIME_PULL_MAX_LIMIT,
        RUNTIME_PULL_MAX_LIMIT,
      );
      // Subscription-mode hold (transport-ladder ruling 20). Clamped
      // like `limit` — a tolerant reader, and the ceiling is a hard
      // safety line: the hold MUST resolve before host-side tools/call
      // timeouts (ggui_consume's 25s holds prove ~20s is safe).
      const waitMs =
        Math.min(parsed.wait ?? 0, RUNTIME_PULL_MAX_WAIT_SECONDS) * 1000;
      const probeIntervalMs = deps.waitProbeIntervalMs ?? 1000;

      // App-scope gate — cross-app + missing surface uniformly so
      // cross-app existence is not leaked (same posture as the
      // /events route's wsToken appId check, with ctx.appId as the
      // proved identity on this carrier).
      const stored = await deps.renderStore.get(sessionId);
      if (!stored || stored.appId !== ctx.appId) {
        throw new GguiSessionNotFoundError(sessionId);
      }

      const deadline = Date.now() + waitMs;
      // Hold loop: one immediate read, then — empty page + time left —
      // probe the store at `probeIntervalMs` until an event lands or
      // the hold elapses. The probe is a STORE read on purpose: the
      // event that ends this hold may be committed by another replica, and
      // the store is the only cross-replica truth available here. Horizon
      // results and non-empty pages return immediately regardless of
      // remaining hold budget.
      for (;;) {
        const result = await deps.renderStore.listEventsSince(
          sessionId,
          sinceSequence,
          limit,
        );
        if (result === null) {
          // Render deleted between reads — same uniform not-found as
          // never-existed (also ends a hold on a mid-hold delete).
          throw new GguiSessionNotFoundError(sessionId);
        }

        // Replay-horizon gate — mirrors the /events route verbatim.
        // Two cases collapse to REPLAY_HORIZON_PASSED:
        //   (a) sinceSequence > lastSequence — cursor from a different
        //       deployment / reset render; the server cannot safely
        //       advance it.
        //   (b) sinceSequence < horizonSeq — events evicted from the
        //       bounded retention window (cloud TTL; in-mem never).
        if (
          sinceSequence > result.lastSequence ||
          sinceSequence < result.horizonSeq
        ) {
          return {
            reason: 'REPLAY_HORIZON_PASSED',
            currentSequence: result.lastSequence,
          };
        }

        if (result.events.length > 0 || Date.now() >= deadline) {
          // Events to deliver, or the hold elapsed — an empty page
          // after a full hold is a NORMAL result (the client stays
          // subscribed by immediately re-pulling).
          return {
            // The ledger's rows are the store's (immutable); the wire carries a copy.
            events: [...result.events],
            lastSequence: result.lastSequence,
            hasMore: result.hasMore,
          };
        }

        await new Promise<void>((resolve) => {
          setTimeout(resolve, probeIntervalMs);
        });
      }
    },
  });
}
