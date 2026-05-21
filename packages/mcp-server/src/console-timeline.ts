/**
 * Console-facing session-event timeline endpoints powering
 * `/devtools/timeline` in the @ggui-ai/console SPA.
 *
 * Unlike `/devtools/llm-trace`, the timeline does NOT introduce a new
 * sink — every event the operator wants to step through already
 * exists in the {@link SessionStore} (inbound user
 * actions + tool calls + UI mutations) and the
 * {@link SessionStreamBuffer} (outbound stream cursor). This module is
 * a thin read-only window over both.
 *
 * **Two surfaces, both admin-gated:**
 *
 *   - `GET /ggui/console/timeline/sessions` — list of sessions visible
 *     to the timeline picker. All statuses (active / completed /
 *     expired) — operators frequently want to debug a session AFTER it
 *     terminated. Sorted most-recent-`lastActivityAt` first; defaults
 *     to 50 rows, clamped to [1, 200] via `?limit=`.
 *
 *   - `GET /ggui/console/timeline/:sessionId/events` — the full event
 *     log for one session, oldest-first, drained from
 *     `sessionStore.observe(id, { tail: false })`. Also reports the
 *     outbound stream cursor (`streamBuffer.currentSeq`) so the
 *     operator can see live-channel progress without a separate fetch.
 *
 * Why REST-only (no SSE): replay is a snapshot. The operator picks a
 * session and steps through what happened — they want a stable frozen
 * view, not a live tail. SSE would force the scrubber to keep chasing
 * a moving end-of-stream and complicate the UI without paying for it.
 *
 * Memory: bounded by whatever the underlying SessionStore retains.
 * `InMemorySessionStore` keeps everything for the process lifetime —
 * fine for OSS dev. A hosted closed runtime's persistent store is the
 * durability surface.
 */
import type { Request, Response, Express } from 'express';
import type {
  SessionEvent,
  SessionStore,
  SessionStreamBuffer,
} from '@ggui-ai/mcp-server-core';
import { applyDevtoolSecurityHeaders } from './console-headers.js';

/** One row in `GET /ggui/console/timeline/sessions`. */
interface TimelineSessionSummary {
  readonly sessionId: string;
  readonly appId: string;
  readonly stackSize: number;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly status: 'active' | 'completed' | 'expired';
  /**
   * Outbound stream cursor — number of envelopes the buffer has seen
   * for this session. 0 when the session never produced live-channel
   * traffic. Used in the picker's row-meta so an operator can pick the
   * busiest session at a glance.
   */
  readonly streamSeq: number;
}

/** Body of `GET /ggui/console/timeline/sessions`. */
interface TimelineSessionsResponse {
  readonly sessions: readonly TimelineSessionSummary[];
  readonly total: number;
}

/** Body of `GET /ggui/console/timeline/:sessionId/events`. */
interface TimelineEventsResponse {
  readonly sessionId: string;
  readonly events: readonly SessionEvent[];
  /**
   * Latest live-channel outbound seq for this session. Reported alongside
   * the inbound event log so the operator UI can hint "this session
   * also produced N outbound stream frames" without a second fetch.
   * 0 when the session never produced live-channel traffic.
   */
  readonly streamSeq: number;
  /**
   * `'unknown'` when the session has no events recorded (the store
   * returned nothing). Otherwise mirrors the session's status as the
   * store reports it. Helpful so the UI can render a "session expired"
   * pill on the detail pane without a second list-fetch.
   */
  readonly status: 'active' | 'completed' | 'expired' | 'unknown';
}

/**
 * Drain {@link SessionStore.observe} into an array. The observe iterator
 * with `{ tail: false }` resolves cleanly after replaying every stored
 * event, so this is a plain `for await`. Bound by the store's per-
 * session retention (in-memory: full history; hosted: store-defined).
 */
async function drainSessionEvents(
  sessionStore: SessionStore,
  sessionId: string,
): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const event of sessionStore.observe(sessionId, {
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
  sessionStore: SessionStore | undefined,
  streamBuffer: SessionStreamBuffer | undefined,
): void {
  // GET /ggui/console/timeline/sessions?limit=<n>
  app.get(
    '/ggui/console/timeline/sessions',
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
      if (!sessionStore) {
        const body: TimelineSessionsResponse = { sessions: [], total: 0 };
        res.json(body);
        return;
      }

      try {
        // No status filter — operators want to debug completed +
        // expired sessions, not just live ones. Limit is post-filter
        // so the response stays bounded.
        const sessions = await sessionStore.list({});
        const summaries: TimelineSessionSummary[] = [];
        const now = Date.now();
        for (const session of sessions) {
          let streamSeq = 0;
          if (streamBuffer) {
            try {
              streamSeq = await streamBuffer.currentSeq(session.id);
            } catch {
              // Stream-cursor lookup is best-effort metadata; an
              // adapter error must not blank the picker.
            }
          }
          // Compute status from session state (the store doesn't
          // surface its private `closed` flag on the Session type).
          // We mirror the InMemorySessionStore's `computeStatus` rule:
          // expired = expiresAt <= now, otherwise active. The
          // 'completed' state needs the closed flag to disambiguate;
          // we report 'active' until eviction. Operators reading the
          // detail pane get the authoritative status from the store.
          const status: TimelineSessionSummary['status'] =
            session.expiresAt <= now ? 'expired' : 'active';
          summaries.push({
            sessionId: session.id,
            appId: session.appId,
            stackSize: session.stack.length,
            createdAt: session.createdAt,
            lastActivityAt: session.lastActivityAt,
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
        const body: TimelineSessionsResponse = {
          sessions: trimmed,
          total: summaries.length,
        };
        res.json(body);
      } catch (err) {
        res.status(500).json({
          error: 'timeline_sessions_list_failed',
          message:
            err instanceof Error
              ? `Session store failed to list — ${err.message}`
              : `Session store failed to list — ${String(err)}`,
        });
      }
    },
  );

  // GET /ggui/console/timeline/:sessionId/events
  app.get(
    '/ggui/console/timeline/:sessionId/events',
    async (req: Request, res: Response) => {
      applyDevtoolSecurityHeaders(res);

      const sessionId = req.params['sessionId'];
      if (!sessionId || sessionId.length === 0) {
        res.status(400).json({
          error: 'invalid_session_id',
          message: 'sessionId path parameter is required',
        });
        return;
      }

      // Zero-config shape: no store wired → empty events.
      if (!sessionStore) {
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
        const session = await sessionStore.get(sessionId);
        if (!session) {
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

        const events = await drainSessionEvents(sessionStore, sessionId);
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
          session.expiresAt <= now ? 'expired' : 'active';
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
              ? `Session store failed to drain — ${err.message}`
              : `Session store failed to drain — ${String(err)}`,
        });
      }
    },
  );
}
