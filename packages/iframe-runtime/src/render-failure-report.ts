/**
 * The runtime's render-failure report (ggui#1679) — the emit half of
 * `ggui_runtime_report_render_failure` (ggui#1609; SPEC §4.9).
 *
 * When the card's error boundary gives up — its retry exhausted, on the first
 * paint or on a later re-render — the runtime tells the server once, for the
 * session it renders. The report carries ids and counts only: the session and
 * app ids the boot envelope named, the phase, the thrown value's class name
 * under the tool's own pattern ({@link renderFailureErrorName}: never a
 * message, a stack, props or component source) and the boundary's catch
 * count, clamped to the tool's bound.
 *
 * Obligations (SPEC §4.9, runtime side):
 *
 *   - **At most one report per session.** The first terminal failure is the
 *     one reported; a card that fails again, in the other phase or after a
 *     re-mount, sends nothing more. The flag is spent when the call is MADE,
 *     not when it is answered, so a report that fails is never resent: a
 *     relay carries no per-session limiter, and one relayed call per session
 *     is the bound.
 *   - **Nothing the visitor sees changes.** The call is fire-and-forget; a
 *     refusal, a tool-not-found from a server that predates the tool, or a
 *     network loss is dropped in silence. No toast, no doorbell, no retry.
 *
 * The call site is {@link bridgeCallToolVia}'s `tools/call` over the host
 * relay, so the request carries the view proof the server records against
 * (`_meta["ai.ggui/view"]`, ggui#1415); an unproven report is answered `ok`
 * and recorded nowhere, by the server's own rule.
 */
// The pure-const subpath, never the package root: the root would pull the
// whole zod schema module into the card runtime's bundle (ggui#1679, +34 KB).
import { RENDER_FAILURE_MAX_CATCHES, renderFailureErrorName } from '@ggui-ai/protocol/render-failure';
import type { GguiReportRenderFailureInput } from '@ggui-ai/protocol';
import type { RenderFailure } from './react-renderer.js';

/** The slice of a tool caller the reporter needs: the bridge's `(name, arguments)`. */
export type RenderFailureCallTool = (name: string, args: GguiReportRenderFailureInput) => Promise<unknown>;

export interface RenderFailureReporter {
  /** Report the boundary's give-up. Idempotent per session: the second call is a no-op. */
  readonly report: (failure: RenderFailure) => void;
  /** Whether this session's one report has been sent (or attempted). */
  readonly reported: () => boolean;
}

export function createRenderFailureReporter(opts: {
  readonly sessionId: string;
  readonly appId: string;
  readonly callTool: RenderFailureCallTool;
}): RenderFailureReporter {
  let spent = false;
  const report = (failure: RenderFailure): void => {
    if (spent) return;
    spent = true;
    const args: GguiReportRenderFailureInput = {
      sessionId: opts.sessionId,
      appId: opts.appId,
      phase: failure.phase,
      errorName: renderFailureErrorName(failure.error),
      catches: Math.min(Math.max(1, Math.trunc(failure.catches)), RENDER_FAILURE_MAX_CATCHES),
    };
    let call: Promise<unknown>;
    try {
      call = opts.callTool('ggui_runtime_report_render_failure', args);
    } catch {
      // A caller that throws synchronously (no App bridge bound) is the
      // same outcome as a refused call: not reported, nothing shown.
      return;
    }
    void call.catch(() => {
      // Dropped by design (SPEC §4.9): a report never changes what the
      // visitor sees, and a failed one is never retried.
    });
  };
  return { report, reported: () => spent };
}
