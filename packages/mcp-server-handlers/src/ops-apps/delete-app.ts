/**
 * `ggui_ops_delete_app` — hard-delete an app record owned by the
 * caller.
 *
 * Tenancy: cross-tenant probes return the success shape WITHOUT
 * touching the row (uniform shape; no existence leak). Idempotent —
 * a second delete of the same id resolves cleanly.
 *
 * Default-app lock: REJECTED when the target is the caller's default
 * app. `defaultAppId` is what the universal route resolves on every
 * request, so deleting the app it names strands that route. The
 * check runs AFTER the ownership read, against the caller's OWN
 * default — a cross-tenant probe returns the uniform success shape
 * before it is ever reached, so the lock leaks nothing.
 *
 * Scope: this handler removes the APP RECORD, through
 * {@link AppsSource.delete}, and claims nothing beyond it. Whether
 * data other stores hold for the same app disappears with it is the
 * bound implementation's business, spelled out in that method's
 * contract. `{deleted: true}` means the app record is gone — read no
 * cascade into it.
 *
 * Pure over the {@link AppsSource} + {@link UserDefaultAppSource}
 * seams.
 */
import { z } from 'zod';
import type { HandlerContext, SharedHandler } from '../types.js';
import { resolveOwnerSub } from './identity.js';
import { DefaultAppDeleteBlockedError } from './types.js';
import type { AppsSource, UserDefaultAppSource } from './types.js';

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
  /** Read side only — the default-app lock reads `defaultAppId`, never writes it. */
  readonly userDefaultApp: UserDefaultAppSource;
}

export function createDeleteAppHandler(
  deps: DeleteAppDeps,
): SharedHandler<typeof inputSchema, typeof outputSchema, DeleteAppOutput> {
  return {
    name: 'ggui_ops_delete_app',
    title: 'Delete app',
    audience: ['ops'],
    description:
      "Hard-delete an app owned by the calling user. Removes the APP RECORD only — data other stores hold for that app (saved blueprints, per-app provider keys, marketplace installs, issued keys) is not removed by this call, and whether the deployment cleans it up separately is the deployment's own policy. Idempotent — a second delete returns `{deleted: true}`. Cross-tenant probes return the same shape without touching foreign rows (no existence leak). Throws `default_app_delete_blocked` when the target is the caller's default app — set a different default first.",
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
        // touching the store. Uniform across "missing" and
        // "cross-tenant" prevents id-existence leak.
        return { deleted: true };
      }
      // Ownership is established by this point, so reading the
      // caller's own default and comparing ids reveals nothing about
      // anyone else's account.
      const currentDefault = await deps.userDefaultApp.getDefault(ownerSub);
      if (currentDefault === parsed.appId) {
        throw new DefaultAppDeleteBlockedError(parsed.appId);
      }
      await deps.apps.delete({ appId: parsed.appId, ownerSub });
      return { deleted: true };
    },
  };
}
