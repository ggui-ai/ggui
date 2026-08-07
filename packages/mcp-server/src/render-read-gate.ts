import type { EndUserIdentity } from "@ggui-ai/protocol";
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
  readonly endUserIdentity?: EndUserIdentity;
}

/**
 * Per-session render-resource read gate (rehydration access control).
 *
 * Rungs, in order (spec §3):
 *  1. Fail closed without a request context.
 *  2. App boundary — the row's appId must equal the caller's.
 *  3. Subject binding — a federated end user (source 'oidc') reading a
 *     subject-bound row must BE that subject.
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
  if (row.endUserIdentity !== undefined && ctx.authSource === "oidc" && ctx.userId !== undefined) {
    return ctx.userId === row.endUserIdentity.userId;
  }
  return true;
}
