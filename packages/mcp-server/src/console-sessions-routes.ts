/**
 * Console active-render list route.
 *
 *   GET /ggui/console/sessions?limit=<n> — active-render list for
 *   the console SPA's `/admin/sessions` page. Operator-facing "what's
 *   live right now?" surface, enriched with each render's current
 *   shortCode so rows can link through to `/s/<shortCode>` (the
 *   existing render viewer).
 *
 * Scope: active renders only. The `GguiSessionFilter.status`
 * taxonomy ('active' | 'completed' | 'expired') requires the
 * store's private `closed` bucket flag to disambiguate completed
 * from expired — that flag isn't on the `GguiSession` protocol type,
 * so exposing mixed-status listings honestly requires a seam
 * extension we don't need for the "live right now" use case.
 * Future slices (historical renders, closed-renders triage)
 * can opt in via query-param.
 *
 * Sources:
 *   - `renderStore.list({ status: 'active', limit })` — single
 *     page, limit default 25, clamped to [1, 100].
 *   - `shortCodeIndex.findBySessionId(render.id)` — best-effort
 *     enrichment; absent shortCode is a valid row (displays
 *     without a click-through link).
 *
 * Sort: most-recent `lastActivityAt` first — matches operator
 * intent "show me what I was just looking at."
 *
 * Zero-config shape: `{ sessions: [], total: 0 }` when no
 * renderStore is wired (e.g. pure-MCP dev boot with neither
 * renderChannel nor mcpApps enabled).
 */

import type { GguiSessionStore, ShortCodeIndex } from "@ggui-ai/mcp-server-core";
import type { Express } from "express";
import { applyDevtoolSecurityHeaders } from "./console-headers.js";
import type { Logger } from "./logger.js";

interface MountOptions {
  /** Express app to mount onto. */
  readonly app: Express;
  /** GguiSession store the list reads (absent = honest empty list). */
  readonly renderStore?: GguiSessionStore;
  /** shortCode index for best-effort row enrichment. */
  readonly shortCodeIndex?: ShortCodeIndex;
  /** Structured logger. */
  readonly logger: Logger;
}

/**
 * Mount `GET /ggui/console/sessions` onto the express app. Returns
 * nothing — the route self-registers.
 */
export function mountConsoleSessionsRoutes(opts: MountOptions): void {
  const { app, renderStore, shortCodeIndex, logger } = opts;

  app.get("/ggui/console/sessions", async (req, res) => {
    applyDevtoolSecurityHeaders(res);
    interface GguiSessionSummary {
      readonly sessionId: string;
      readonly shortCode?: string;
      readonly appId: string;
      readonly lastActivityAt: number;
      readonly createdAt: number;
      readonly status: "active";
    }

    const limitRaw = req.query["limit"];
    let limit = 25;
    if (typeof limitRaw === "string") {
      const parsed = Number.parseInt(limitRaw, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = Math.min(100, parsed);
      }
    }

    if (!renderStore) {
      res.json({ sessions: [], total: 0 });
      return;
    }

    try {
      const renders = await renderStore.list({
        status: "active",
        limit,
      });
      const summaries: GguiSessionSummary[] = [];
      for (const render of renders) {
        let shortCode: string | null = null;
        if (shortCodeIndex) {
          try {
            shortCode = await shortCodeIndex.findBySessionId(render.id);
          } catch (err) {
            // Best-effort — the render row is still honest
            // without a shortCode.
            logger.warn("console_renders_shortcode_lookup_failed", {
              sessionId: render.id,
              error: String(err),
            });
          }
        }
        summaries.push({
          sessionId: render.id,
          ...(shortCode ? { shortCode } : {}),
          appId: render.appId,
          lastActivityAt: render.lastActivityAt,
          createdAt: render.createdAt,
          status: "active",
        });
      }
      // Most-recent activity first. Tiebreak on sessionId for
      // stability when multiple rows share the same ms timestamp.
      summaries.sort((a, b) => {
        const byRecency = b.lastActivityAt - a.lastActivityAt;
        if (byRecency !== 0) return byRecency;
        return a.sessionId.localeCompare(b.sessionId);
      });
      res.json({ sessions: summaries, total: summaries.length });
    } catch (err) {
      logger.warn("console_renders_list_failed", {
        error: String(err),
      });
      res.status(500).json({
        error: "renders_unavailable",
        message:
          err instanceof Error
            ? `GguiSession store failed to list — ${err.message}`
            : `GguiSession store failed to list — ${String(err)}`,
      });
    }
  });
}
