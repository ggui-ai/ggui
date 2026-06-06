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
 * render. The on-wire `sessionId` path param replaces `sessionId`.
 *
 * Memory: bounded by whatever the underlying GguiSessionStore retains.
 * `InMemoryGguiSessionStore` keeps everything for the process lifetime —
 * fine for OSS dev. A hosted closed runtime's persistent store is the
 * durability surface.
 */
import type { Request, Response, Express } from 'express';
import type {
  GguiSessionEvent,
  GguiSessionStore,
  GguiSessionStreamBuffer,
} from '@ggui-ai/mcp-server-core';
import { applyDevtoolSecurityHeaders } from './console-headers.js';
import { singleParam } from './route-param.js';

/** One row in `GET /ggui/console/timeline/renders`. */
interface TimelineGguiSessionSummary {
  readonly sessionId: string;
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
interface TimelineGguiSessionsResponse {
  readonly sessions: readonly TimelineGguiSessionSummary[];
  readonly total: number;
}

/** Body of `GET /ggui/console/timeline/:sessionId/events`. */
interface TimelineEventsResponse {
  readonly sessionId: string;
  readonly events: readonly GguiSessionEvent[];
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
 * Drain {@link GguiSessionStore.observe} into an array. The observe iterator
 * with `{ tail: false }` resolves cleanly after replaying every stored
 * event, so this is a plain `for await`. Bound by the store's per-
 * render retention (in-memory: full history; hosted: store-defined).
 */
async function drainGguiSessionEvents(
  renderStore: GguiSessionStore,
  sessionId: string,
): Promise<GguiSessionEvent[]> {
  const out: GguiSessionEvent[] = [];
  for await (const event of renderStore.observe(sessionId, {
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
  renderStore: GguiSessionStore | undefined,
  streamBuffer: GguiSessionStreamBuffer | undefined,
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
        const body: TimelineGguiSessionsResponse = { sessions: [], total: 0 };
        res.json(body);
        return;
      }

      try {
        // No status filter — operators want to debug completed +
        // expired renders, not just live ones. Limit is post-filter
        // so the response stays bounded.
        const stored = await renderStore.list({});
        const summaries: TimelineGguiSessionSummary[] = [];
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
          // We mirror the InMemoryGguiSessionStore's rule:
          // expired = expiresAt <= now, otherwise active. The
          // 'completed' state needs the closed flag to disambiguate;
          // we report 'active' until eviction. Operators reading the
          // detail pane get the authoritative status from the store.
          const status: TimelineGguiSessionSummary['status'] =
            row.expiresAt <= now ? 'expired' : 'active';
          summaries.push({
            sessionId: row.id,
            appId: row.appId,
            createdAt: row.createdAt,
            lastActivityAt: row.lastActivityAt,
            status,
            streamSeq,
          });
        }
        // Most-recent activity first. Tiebreak on sessionId for
        // stable ordering across reloads.
        summaries.sort((a, b) => {
          const byRecency = b.lastActivityAt - a.lastActivityAt;
          if (byRecency !== 0) return byRecency;
          return a.sessionId.localeCompare(b.sessionId);
        });
        const trimmed = summaries.slice(0, limit);
        const body: TimelineGguiSessionsResponse = {
          sessions: trimmed,
          total: summaries.length,
        };
        res.json(body);
      } catch (err) {
        res.status(500).json({
          error: 'timeline_sessions_list_failed',
          message:
            err instanceof Error
              ? `GguiSession store failed to list — ${err.message}`
              : `GguiSession store failed to list — ${String(err)}`,
        });
      }
    },
  );

  // GET /ggui/console/timeline/:sessionId/events
  app.get(
    '/ggui/console/timeline/:sessionId/events',
    async (req: Request, res: Response) => {
      applyDevtoolSecurityHeaders(res);

      const sessionId = singleParam(req.params['sessionId']);
      if (!sessionId || sessionId.length === 0) {
        res.status(400).json({
          error: 'invalid_session_id',
          message: 'sessionId path parameter is required',
        });
        return;
      }

      // Zero-config shape: no store wired → empty events.
      if (!renderStore) {
        const body: TimelineEventsResponse = {
          sessionId,
          events: [],
          streamSeq: 0,
          status: 'unknown',
        };
        res.json(body);
        return;
      }

      try {
        const stored = await renderStore.get(sessionId);
        if (!stored) {
          // 404 is the right status — but we still return a well-
          // formed body so the SPA can render an "expired/dropped"
          // notice without a special-case branch. Body matches the
          // schema; status code disambiguates.
          const body: TimelineEventsResponse = {
            sessionId,
            events: [],
            streamSeq: 0,
            status: 'unknown',
          };
          res.status(404).json(body);
          return;
        }

        const events = await drainGguiSessionEvents(renderStore, sessionId);
        let streamSeq = 0;
        if (streamBuffer) {
          try {
            streamSeq = await streamBuffer.currentSeq(sessionId);
          } catch {
            // Best-effort. Inbound events stand on their own.
          }
        }
        const now = Date.now();
        const status: TimelineEventsResponse['status'] =
          stored.expiresAt <= now ? 'expired' : 'active';
        const body: TimelineEventsResponse = {
          sessionId,
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
              ? `GguiSession store failed to drain — ${err.message}`
              : `GguiSession store failed to drain — ${String(err)}`,
        });
      }
    },
  );
}
