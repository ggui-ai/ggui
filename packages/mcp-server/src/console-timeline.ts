/**
 * Console timeline routes — `GET /ggui/console/timeline/*`.
 *
 * Read-only event-log inspector. Lists rendered surfaces (renders) the
 * server has materialized, drills into the per-render event ledger for
 * a single id, and exposes the live-channel outbound cursor alongside
 * for diagnostic context.
 *
 * Post-Phase-B (flatten-render-identity): renamed from the prior
 * "sessions" terminology; the canonical addressable unit is now the
 * render. The on-wire `renderId` path param replaces `sessionId`.
 *
 * Memory: bounded by whatever the underlying RenderStore retains.
 * `InMemoryRenderStore` keeps everything for the process lifetime —
 * fine for OSS dev. A hosted closed runtime's persistent store is the
 * durability surface.
 */
import type { Request, Response, Express } from 'express';
import type {
  RenderEvent,
  RenderStore,
  SessionStreamBuffer,
} from '@ggui-ai/mcp-server-core';
import { applyDevtoolSecurityHeaders } from './console-headers.js';
import { singleParam } from './route-param.js';

/** One row in `GET /ggui/console/timeline/renders`. */
interface TimelineRenderSummary {
  readonly renderId: string;
  readonly appId: string;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly status: 'active' | 'completed' | 'expired';
  /**
   * Outbound stream cursor — number of envelopes the buffer has seen
   * for this render. 0 when the render never produced live-channel
   * traffic. Used in the picker's row-meta so an operator can pick the
   * busiest render at a glance.
   */
  readonly streamSeq: number;
}

/** Body of `GET /ggui/console/timeline/renders`. */
interface TimelineRendersResponse {
  readonly renders: readonly TimelineRenderSummary[];
  readonly total: number;
}

/** Body of `GET /ggui/console/timeline/:renderId/events`. */
interface TimelineEventsResponse {
  readonly renderId: string;
  readonly events: readonly RenderEvent[];
  /**
   * Latest live-channel outbound seq for this render. Reported alongside
   * the inbound event log so the operator UI can hint "this render
   * also produced N outbound stream frames" without a second fetch.
   * 0 when the render never produced live-channel traffic.
   */
  readonly streamSeq: number;
  /**
   * `'unknown'` when the render has no events recorded (the store
   * returned nothing). Otherwise mirrors the render's status as the
   * store reports it. Helpful so the UI can render a "render expired"
   * pill on the detail pane without a second list-fetch.
   */
  readonly status: 'active' | 'completed' | 'expired' | 'unknown';
}

/**
 * Drain {@link RenderStore.observe} into an array. The observe iterator
 * with `{ tail: false }` resolves cleanly after replaying every stored
 * event, so this is a plain `for await`. Bound by the store's per-
 * render retention (in-memory: full history; hosted: store-defined).
 */
async function drainRenderEvents(
  renderStore: RenderStore,
  renderId: string,
): Promise<RenderEvent[]> {
  const out: RenderEvent[] = [];
  for await (const event of renderStore.observe(renderId, {
    fromSeq: 1,
    tail: false,
  })) {
    out.push(event);
  }
  return out;
}

/**
 * Mount `/ggui/console/timeline/*` routes on `app`. Caller is
 * responsible for admin-gating the path prefix beforehand — this
 * function does not re-implement auth (matches the
 * `mountConsoleLlmTraceRoutes` shape in console-llm-trace.ts).
 */
export function mountConsoleTimelineRoutes(
  app: Express,
  renderStore: RenderStore | undefined,
  streamBuffer: SessionStreamBuffer | undefined,
): void {
  // GET /ggui/console/timeline/renders?limit=<n>
  app.get(
    '/ggui/console/timeline/renders',
    async (req: Request, res: Response) => {
      applyDevtoolSecurityHeaders(res);

      const limitRaw = req.query['limit'];
      let limit = 50;
      if (typeof limitRaw === 'string') {
        const parsed = Number.parseInt(limitRaw, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          limit = Math.min(200, parsed);
        }
      }

      // Zero-config shape: no store wired (pure-MCP boot) → empty list.
      if (!renderStore) {
        const body: TimelineRendersResponse = { renders: [], total: 0 };
        res.json(body);
        return;
      }

      try {
        // No status filter — operators want to debug completed +
        // expired renders, not just live ones. Limit is post-filter
        // so the response stays bounded.
        const stored = await renderStore.list({});
        const summaries: TimelineRenderSummary[] = [];
        const now = Date.now();
        for (const row of stored) {
          let streamSeq = 0;
          if (streamBuffer) {
            try {
              streamSeq = await streamBuffer.currentSeq(row.id);
            } catch {
              // Stream-cursor lookup is best-effort metadata; an
              // adapter error must not blank the picker.
            }
          }
          // Compute status from render state (the store doesn't
          // surface its private `closed` flag uniformly across impls).
          // We mirror the InMemoryRenderStore's rule:
          // expired = expiresAt <= now, otherwise active. The
          // 'completed' state needs the closed flag to disambiguate;
          // we report 'active' until eviction. Operators reading the
          // detail pane get the authoritative status from the store.
          const status: TimelineRenderSummary['status'] =
            row.expiresAt <= now ? 'expired' : 'active';
          summaries.push({
            renderId: row.id,
            appId: row.appId,
            createdAt: row.createdAt,
            lastActivityAt: row.lastActivityAt,
            status,
            streamSeq,
          });
        }
        // Most-recent activity first. Tiebreak on renderId for
        // stable ordering across reloads.
        summaries.sort((a, b) => {
          const byRecency = b.lastActivityAt - a.lastActivityAt;
          if (byRecency !== 0) return byRecency;
          return a.renderId.localeCompare(b.renderId);
        });
        const trimmed = summaries.slice(0, limit);
        const body: TimelineRendersResponse = {
          renders: trimmed,
          total: summaries.length,
        };
        res.json(body);
      } catch (err) {
        res.status(500).json({
          error: 'timeline_renders_list_failed',
          message:
            err instanceof Error
              ? `Render store failed to list — ${err.message}`
              : `Render store failed to list — ${String(err)}`,
        });
      }
    },
  );

  // GET /ggui/console/timeline/:renderId/events
  app.get(
    '/ggui/console/timeline/:renderId/events',
    async (req: Request, res: Response) => {
      applyDevtoolSecurityHeaders(res);

      const renderId = singleParam(req.params['renderId']);
      if (!renderId || renderId.length === 0) {
        res.status(400).json({
          error: 'invalid_render_id',
          message: 'renderId path parameter is required',
        });
        return;
      }

      // Zero-config shape: no store wired → empty events.
      if (!renderStore) {
        const body: TimelineEventsResponse = {
          renderId,
          events: [],
          streamSeq: 0,
          status: 'unknown',
        };
        res.json(body);
        return;
      }

      try {
        const stored = await renderStore.get(renderId);
        if (!stored) {
          // 404 is the right status — but we still return a well-
          // formed body so the SPA can render an "expired/dropped"
          // notice without a special-case branch. Body matches the
          // schema; status code disambiguates.
          const body: TimelineEventsResponse = {
            renderId,
            events: [],
            streamSeq: 0,
            status: 'unknown',
          };
          res.status(404).json(body);
          return;
        }

        const events = await drainRenderEvents(renderStore, renderId);
        let streamSeq = 0;
        if (streamBuffer) {
          try {
            streamSeq = await streamBuffer.currentSeq(renderId);
          } catch {
            // Best-effort. Inbound events stand on their own.
          }
        }
        const now = Date.now();
        const status: TimelineEventsResponse['status'] =
          stored.expiresAt <= now ? 'expired' : 'active';
        const body: TimelineEventsResponse = {
          renderId,
          events,
          streamSeq,
          status,
        };
        res.json(body);
      } catch (err) {
        res.status(500).json({
          error: 'timeline_events_drain_failed',
          message:
            err instanceof Error
              ? `Render store failed to drain — ${err.message}`
              : `Render store failed to drain — ${String(err)}`,
        });
      }
    },
  );
}
