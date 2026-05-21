/**
 * `ggui_ops_delete_app` — hard-delete a `GguiApp` row owned by the
 * caller.
 *
 * Tenancy: cross-tenant probes return the success shape WITHOUT
 * touching the row (uniform shape; no existence leak). Idempotent —
 * a second delete of the same id resolves cleanly.
 *
 * What the cloud adapter additionally does on top of this seam (NOT
 * the responsibility of the handler):
 *   - Cascade-revoke per-app `GguiUserApiKey` rows
 *   - Cascade-clean per-app provider keys, blueprints, sessions
 * The handler stays narrow; the adapter's `delete()` implementation
 * orchestrates the cascade.
 *
 * Pure over the {@link AppsSource} seam.
 */
import { z } from 'zod';
import type { HandlerContext, SharedHandler } from '../types.js';
import { resolveOwnerSub } from './identity.js';
import type { AppsSource } from './types.js';

const inputSchema = {
  appId: z
    .string()
    .min(1)
    .describe(
      'Target `GguiApp.appId` — must be owned by the calling user. Discover via `ggui_ops_list_apps`.',
    ),
} as const;

const outputSchema = {
  deleted: z.literal(true),
} as const;

export interface DeleteAppOutput {
  readonly deleted: true;
}

export interface DeleteAppDeps {
  readonly apps: AppsSource;
}

export function createDeleteAppHandler(
  deps: DeleteAppDeps,
): SharedHandler<typeof inputSchema, typeof outputSchema, DeleteAppOutput> {
  return {
    name: 'ggui_ops_delete_app',
    title: 'Delete app',
    audience: ['ops'],
    description:
      "Hard-delete an app owned by the calling user. Idempotent — a second delete returns `{deleted: true}`. Cross-tenant probes return the same shape without touching foreign rows (no existence leak). Cascades per-app keys / blueprints / sessions at the cloud adapter layer.",
    inputSchema,
    outputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<DeleteAppOutput> {
      const ownerSub = resolveOwnerSub('ggui_ops_delete_app', ctx);
      const parsed = z.object(inputSchema).parse(rawInput);
      const existing = await deps.apps.get({
        appId: parsed.appId,
        ownerSub,
      });
      if (!existing) {
        // Either the row doesn't exist or it lives under a different
        // owner. Either way: return the success shape without
        // touching DDB. Uniform across "missing" and "cross-tenant"
        // prevents id-existence leak.
        return { deleted: true };
      }
      await deps.apps.delete({ appId: parsed.appId, ownerSub });
      return { deleted: true };
    },
  };
}
