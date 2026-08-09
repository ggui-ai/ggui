// `HandlerContext` is not exported from `./build-mcp.js` (only imported
// there) and has no home under mcp-server-core either — its actual
// definition lives in `@ggui-ai/mcp-server-handlers`, the same package
// build-mcp.ts itself imports it from. Importing straight from there
// also sidesteps a circular import: mcp-apps-outbound.ts (which
// build-mcp.ts imports) needs `renderReadAllowed` from this module.
import type { HandlerContext } from "@ggui-ai/mcp-server-handlers";

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
   * single-tenant flows mint rows with no subject, and those still
   * pass rung 4.
   */
  readonly userId?: string;
}

/**
 * Per-session render-resource read gate (rehydration access control).
 *
 * Rungs, in order (spec §3):
 *  1. Fail closed without a request context.
 *  2. App boundary — the row's appId must equal the caller's.
 *  3. Subject binding — a caller carrying an end-user identity (kind
 *     'user', any auth source) reading a subject-bound row must BE
 *     that subject. The row's subject is its `userId`, written at
 *     commit; see {@link RenderReadRowView.userId} for why this rung
 *     only starts binding now.
 *  4. Everything else same-app passes: app credentials (tenant trust —
 *     the app is obligated to enforce its own user-ownership before
 *     fetching on a user's behalf), builder/anonymous single-tenant
 *     flows, and rows with no subject.
 *
 * Deny is surfaced by the CALLER as the loading shell, byte-identical
 * to the missing-row response — reads must not oracle which sessionIds
 * exist.
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
