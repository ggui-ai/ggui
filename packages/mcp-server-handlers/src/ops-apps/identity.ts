/**
 * Per-call identity resolution for `ops-apps` handlers. A deployment
 * with per-user accounts calls these tools as `kind: 'user'`
 * identities — the upstream `AuthAdapter` populates `ctx.userId`
 * directly. Single-app mode (where the auth adapter collapses
 * `appId = workspaceId ?? userId`) leaves `ctx.userId` undefined and
 * the same value sits on `ctx.appId`. Read whichever is set; fail when
 * neither is.
 */
import type { HandlerContext } from '../types.js';

/**
 * Resolve the caller's owner id (`ctx.userId`, or `ctx.appId` in
 * single-app mode). Throws
 * when neither field is set — that means an unauthenticated caller
 * slipped past the upstream auth adapter, which is a real bug worth
 * surfacing as a 5xx rather than masking as "empty list".
 */
export function resolveOwnerSub(
  toolName: string,
  ctx: HandlerContext,
): string {
  const sub = ctx.userId ?? ctx.appId;
  if (!sub) {
    throw new Error(
      `${toolName}: missing caller identity (ctx.userId and ctx.appId both empty)`,
    );
  }
  return sub;
}
