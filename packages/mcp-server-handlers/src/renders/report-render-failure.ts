/**
 * `ggui_runtime_report_render_failure` — a card whose render failed tells
 * the server (ggui#1609). App-only (`_meta.ui.visibility: ['app']`): the
 * iframe runtime sends it once, when its error boundary's catch is terminal,
 * for the session it renders.
 *
 * Contract:
 *
 *   - **Recorded only for the session the call's view proof binds.** The
 *     transport verifies the proof before this handler runs (ggui#1415) and
 *     puts the verdict on `ctx.viewProof`. This handler records on a `valid`
 *     verdict alone: a report that names a session it cannot prove must
 *     never mark that session failed, because a deployment may act on the
 *     mark. Any other verdict, or none, records nothing and is named on
 *     `render_failure_unproven {appId, reason}` (the proven app, never the
 *     claimed session), so the undercount it causes is measured.
 *   - **Refuses nothing.** Every answer is `{ok: true}`, whatever the proof,
 *     except `SESSION_NOT_FOUND` for a session the caller's app does not hold
 *     (the same answer as a missing one: no ownership oracle).
 *   - **Never a turn.** A report is not a user gesture and never reaches the
 *     pending-event pipe: this handler's deps carry no pipe.
 *   - **No message, no stack.** The report carries the thrown value's class
 *     name, shaped by the protocol's pattern, and the phase and catch count.
 *
 * A deployment records a proven report through `recordRenderFailure`
 * (best-effort: a recorder that throws is named on
 * `render_failed_record_failed` and never changes the answer). Every proven
 * report is also named on `render_failed`.
 */
import type { GguiSessionStore, StoredGguiSession } from '@ggui-ai/mcp-server-core';
import {
  reportRenderFailureInputShape,
  reportRenderFailureOutputSchema,
  type GguiReportRenderFailureInput,
  type GguiReportRenderFailureOutput,
} from '@ggui-ai/protocol';
import { z } from 'zod';
import { defineHandler, readSessionRow, type HandlerContext } from '../types.js';
import { logCrossAppRefused, logOwnershipUnverified } from './cross-app-refused.js';

const TOOL = 'ggui_runtime_report_render_failure';

/** A proven report, as the deployment's recorder receives it. */
export interface RenderFailureRecord extends GguiReportRenderFailureInput {
  /** The server's clock when it accepted the report (ISO-8601). */
  readonly receivedAt: string;
}

export interface CreateGguiReportRenderFailureHandlerDeps {
  /** Where the session's row is read, to confirm the caller's app holds it. */
  readonly renderStore: GguiSessionStore;
  /**
   * Record a PROVEN report (ggui#1609). Called at most once per call, only
   * for the session the view proof bound. Best-effort: a throw is named and
   * never changes the answer. Absent: the report is named and nothing more.
   */
  readonly recordRenderFailure?: (record: RenderFailureRecord, ctx: HandlerContext) => Promise<void> | void;
  /** Clock seam for `receivedAt`. */
  readonly now?: () => Date;
}

/** One physical line: a fixed prefix then a JSON body, as the refusal lines. */
function line(level: 'info' | 'warn', event: string, fields: Record<string, string | number>): void {
  // eslint-disable-next-line no-console -- operator-visible structured line; handlers carry no logger
  console[level](`[ggui] ${event} ${JSON.stringify(fields)}`);
}

function unprovenReason(ctx: HandlerContext): string {
  const v = ctx.viewProof;
  if (v === undefined) return 'unverifiable';
  if (v.verdict === 'valid') return 'valid';
  return `${v.verdict}:${v.reason}`;
}

const sessionNotFound: GguiReportRenderFailureOutput = { ok: false, code: 'SESSION_NOT_FOUND' };

export function createGguiReportRenderFailureHandler(deps: CreateGguiReportRenderFailureHandlerDeps) {
  const now = deps.now ?? (() => new Date());
  return defineHandler({
    name: 'ggui_runtime_report_render_failure',
    title: '[runtime] Report Render Failure',
    audience: ['runtime'],
    description:
      "Reports that a card's render failed: its first paint (`mount`) or a later re-render (`update`), with the thrown value's class name and never its message or stack. Iframe-only (`_meta.ui.visibility: ['app']`). Recorded only for the session the call's view proof binds; never an agent turn. Always answers `ok` except `SESSION_NOT_FOUND` for a session the caller's app does not hold. A runtime never retries or shows an error for it.",
    inputSchema: reportRenderFailureInputShape,
    outputSchema: reportRenderFailureOutputSchema.shape,
    _meta: {
      ui: { visibility: ['app'] as const },
    },
    // ggui#1609: a report is recorded against its session, so the session
    // must be proven, never claimed.
    viewProof: 'required',
    async handler(input, ctx: HandlerContext): Promise<GguiReportRenderFailureOutput> {
      const parsed = z.object(reportRenderFailureInputShape).safeParse(input);
      if (!parsed.success) {
        line('info', 'render_failure_rejected', { appId: ctx.appId, issues: parsed.error.issues.length });
        return { ok: true };
      }
      const report = parsed.data;
      if (ctx.viewProof?.verdict !== 'valid') {
        line('info', 'render_failure_unproven', { appId: ctx.appId, reason: unprovenReason(ctx) });
        return { ok: true };
      }
      let stored: StoredGguiSession | null;
      try {
        stored = await readSessionRow(ctx, deps.renderStore, report.sessionId);
      } catch (err) {
        logOwnershipUnverified(TOOL, report.sessionId, ctx.appId, 'read-failed', err instanceof Error ? err.message : String(err));
        return sessionNotFound;
      }
      // The caller's own app decides (ggui#1479), never the declared one.
      if (!stored || stored.appId !== ctx.appId) {
        if (stored) logCrossAppRefused(TOOL, report.sessionId, ctx.appId, stored.appId);
        return sessionNotFound;
      }
      const record: RenderFailureRecord = { ...report, appId: ctx.appId, receivedAt: now().toISOString() };
      line('info', 'render_failed', {
        sessionId: record.sessionId,
        appId: record.appId,
        phase: record.phase,
        errorName: record.errorName,
        catches: record.catches,
      });
      if (deps.recordRenderFailure) {
        try {
          await deps.recordRenderFailure(record, ctx);
        } catch (err) {
          line('warn', 'render_failed_record_failed', {
            sessionId: record.sessionId,
            appId: record.appId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return { ok: true };
    },
  });
}
