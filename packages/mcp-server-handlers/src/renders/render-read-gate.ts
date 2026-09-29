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
 * The two caller fields the read gate consults: the app the credential
 * names and the end user it carries, when it carries one. A door with a
 * full `HandlerContext` passes it as is; the live channel's bearer
 * subscribe (ggui#1483) has no handler context and passes the two fields
 * it resolved.
 */
export type RenderReadCaller = Pick<HandlerContext, 'appId' | 'userId'>;

/**
 * Per-session render-resource read gate (rehydration access control).
 *
 * The predicate of the doors that admit a caller to an EXISTING session by
 * id with app trust: the read door (`resources/read` of
 * `ui://ggui/render/...`); the authorized refresh
 * (`ggui_runtime_refresh_ws_token`, ggui#1496 part B), which re-mints no
 * weaker and no stronger than the read door; the live channel's bearer
 * subscribe (ggui#1483), which attaches to the session's events and
 * actions no weaker than the read door reads them; and the session tools
 * whose row in the cross-subject contract suite's `NO_END_USER` table reads
 * `admitted` (ggui#1483). The suite enumerates every tool with a `sessionId`
 * from the registry, so a new one is classified there, not here. The other
 * session tools refuse a caller with no end-user identity on a
 * subject-bound row too, through `isVisibleToCaller`; which rule the two
 * families should share is ggui#1553.
 *
 * NOT held to it: the channel's token subscribe. A `wsToken` is a bearer
 * capability bound to one session (SPEC §5.5.1.1): holding it is the
 * authorization that subscribe checks, and its synthesized identity names
 * the session, not a person (ggui#446). The doors that mint one each run
 * their own gate: `ggui_render` creates the session with the caller as its
 * subject; `ggui_update` and the read door run this predicate;
 * `ggui_list_sessions` gates on the app, and on the user when set; `/state`
 * renews on possession of an unexpired token, a renewal bounded by its
 * chain's `rootIat` + the refresh window; the console's session routes mint
 * behind a cookie issued on possession of the session's shortCode.
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
 * same bytes. The live channel's subscribe cannot discharge it: an
 * unknown id there is provisioned, not refused (SPEC §12.2.3), so its
 * refusal is `SESSION_NOT_FOUND` with a fixed message — it tells a
 * caller only that the id exists and is not theirs, as the channel's
 * app-scope refusal already does.
 */
export function renderReadAllowed(row: RenderReadRowView, ctx: RenderReadCaller | undefined): boolean {
  return renderReadVerdict(row, ctx).allowed;
}

/** Which rung of {@link renderReadAllowed} decided a read. */
export type RenderReadRung = 'no-context' | 'app' | 'subject' | 'app-trust';

/** {@link renderReadAllowed}'s answer, with the rung that gave it. */
export interface RenderReadVerdict {
  readonly allowed: boolean;
  readonly rung: RenderReadRung;
  /**
   * Rung 4 admitted a caller with NO end-user identity to a row that HAS
   * one: an app credential reading a subject-bound session on app trust.
   * It is the one case where this predicate and `isVisibleToCaller` (the
   * agent doors' predicate, which refuses it) disagree, so a door that
   * admits it logs one line (ggui#1553 measures how often it happens before
   * the two are unified).
   */
  readonly appTrustOverSubject: boolean;
}

/** The read gate's answer and the rung that gave it; see {@link renderReadAllowed} for the rungs. */
export function renderReadVerdict(
  row: RenderReadRowView,
  ctx: RenderReadCaller | undefined
): RenderReadVerdict {
  if (ctx === undefined) return { allowed: false, rung: 'no-context', appTrustOverSubject: false };
  if (ctx.appId !== row.appId) return { allowed: false, rung: 'app', appTrustOverSubject: false };
  if (row.userId !== undefined && ctx.userId !== undefined) {
    return { allowed: ctx.userId === row.userId, rung: 'subject', appTrustOverSubject: false };
  }
  return { allowed: true, rung: 'app-trust', appTrustOverSubject: row.userId !== undefined };
}

/**
 * The structured line a door logs when it admits a read on
 * {@link RenderReadVerdict.appTrustOverSubject} (ggui#1553). It carries the
 * door, the app and the caller's auth source, never the session or the
 * subject.
 */
export const RENDER_READ_APP_TRUST_OVER_SUBJECT = 'render_read_app_trust_over_subject' as const;
