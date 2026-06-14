/**
 * Shared render-tenancy predicate (Federation B1, Task 6).
 *
 * Single source of truth for "is this stored render visible to the
 * caller?" — imported by every read gate (`consume`, `get-session`)
 * and the `render` reuse gate, so the isolation rule can't drift apart
 * across handlers.
 */
import type { StoredGguiSession } from '@ggui-ai/mcp-server-core';

/**
 * Type-sound positive predicate: `true` when `stored` is visible to the
 * caller. Tenancy = `appId`; within an app, a row stamped with a
 * `userId` is visible only to that same `userId`. Rows without a
 * `userId` (legacy / single-user) stay visible to any ctx in the app
 * (back-compat). Narrows `stored` to non-null in the `true` branch so
 * callers can use it after the guard.
 */
export function isVisibleToCaller(
  stored: StoredGguiSession | null,
  ctx: { readonly appId: string; readonly userId?: string },
): stored is StoredGguiSession {
  if (!stored || stored.appId !== ctx.appId) return false;
  if (stored.userId !== undefined && stored.userId !== ctx.userId) return false;
  return true;
}
