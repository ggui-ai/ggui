import type { HandlerContext } from '../types.js';

/** The two row fields the read gate consults. */
export interface RenderReadRowView {
  readonly appId: string;
  /**
   * The row's SUBJECT — the end user a render belongs to, written at
   * commit and nowhere else.
   *
   * `userId` rather than the richer `endUserIdentity` block, and that
   * is the whole of #446. The gate used to read `endUserIdentity`,
   * which no writer has populated since the repo split deleted the one
   * that did (`f99b81c28`) — so the subject rung has been reading a
   * field that is always absent, and passing every caller through as
   * "row has no subject". Reading `userId` binds the rung for the
   * first time.
   *
   * Absent stays a legitimate state: builder and anonymous
   * single-app flows mint rows with no subject, and those still
   * pass rung 4.
   */
  readonly userId?: string;
}

/**
 * Per-session render-resource read gate (rehydration access control).
 *
 * ONE predicate for the two doors that re-issue a live credential for an
 * EXISTING session by locator: the read door (`resources/read` of
 * `ui://ggui/render/...`) and the authorized refresh
 * (`ggui_runtime_refresh_ws_token`, ggui#1496 part B), which re-mints no
 * weaker and no stronger than the read door. Other doors mint under their
 * own gates (`ggui_render` creates the session; `ggui_update` and
 * `ggui_list_sessions` gate on the app, and the list on the user when set;
 * `/state` on possession of an unexpired token, a renewal bounded by its
 * chain's `rootIat` + the refresh window).
 *
 * Rungs, in order (spec §3):
 *  1. Fail closed without a request context.
 *  2. App boundary — the row's appId must equal the caller's.
 *  3. Subject binding — a caller carrying an end-user identity (kind
 *     'user', any auth source) reading a subject-bound row must BE
 *     that subject. The row's subject is its `userId`, written at
 *     commit; see {@link RenderReadRowView.userId} for why this rung
 *     only starts binding now.
 *  4. Everything else same-app passes: app credentials (app trust —
 *     the app is obligated to enforce its own user-ownership before
 *     fetching on a user's behalf), builder/anonymous single-app
 *     flows, and rows with no subject.
 *
 * Deny is surfaced by the CALLER byte-identically to a missing row —
 * reads must not oracle which sessionIds exist. This function only
 * returns the boolean; making the two indistinguishable is the caller's
 * obligation, and it is a real one, because "refused" and "never
 * existed" travel completely different code paths to get there. The
 * resource handler discharges it by collapsing a refusal to "absent"
 * and letting every downstream branch run as it would for a locator
 * that never existed, so both arrive at the same typed failure with the
 * same bytes.
 */
export function renderReadAllowed(
  row: RenderReadRowView,
  ctx: HandlerContext | undefined
): boolean {
  if (ctx === undefined) return false;
  if (ctx.appId !== row.appId) return false;
  if (row.userId !== undefined && ctx.userId !== undefined) {
    return ctx.userId === row.userId;
  }
  return true;
}
