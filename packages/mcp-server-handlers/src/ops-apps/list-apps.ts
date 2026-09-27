/**
 * `ggui_ops_list_apps` — enumerate the calling user's `GguiApp` rows.
 *
 * The MCP door onto the same data an app-management UI lists. Pure over
 * the {@link AppsSource} seam; a production deployment binds its own
 * implementation, tests bind an in-memory Map.
 *
 * Identity scope: the caller's owner id from `ctx.userId` (or
 * `ctx.appId` in single-app mode). Cross-user list is impossible
 * by construction — `AppsSource.list` only returns rows whose
 * `ownerSub` matches.
 */
import { z } from 'zod';
import { defineHandler, type HandlerContext, type ShapeOutput } from '../types.js';
import { resolveOwnerSub } from './identity.js';
import type { AppsSource } from './types.js';

const inputSchema = {} satisfies Record<string, never>;

const outputSchema = {
  apps: z.array(
    z.object({
      appId: z.string(),
      displayName: z.string(),
      systemPrompt: z.string().optional(),
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
  ),
} as const;

/** The wire shape — derived from `outputSchema`, the one source of truth (#817). */
export type ListAppsOutput = ShapeOutput<typeof outputSchema>;

export interface ListAppsDeps {
  readonly apps: AppsSource;
}

export function createListAppsHandler(deps: ListAppsDeps) {
  return defineHandler({
    name: 'ggui_ops_list_apps',
    title: 'List apps',
    audience: ['ops'],
    description:
      "Enumerate every `GguiApp` row owned by the calling user. Returns metadata only (appId, displayName, optional systemPrompt, createdAt, updatedAt). Use to discover ids before calling `ggui_ops_update_app` / `ggui_ops_set_default_app` / `ggui_ops_delete_app`.",
    inputSchema,
    outputSchema,
    async handler(
      _input: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<ListAppsOutput> {
      const ownerSub = resolveOwnerSub('ggui_ops_list_apps', ctx);
      const rows = await deps.apps.list(ownerSub);
      // Project the seam rows onto the wire shape — exactly the fields
      // `outputSchema` declares, the way the sibling factories already do.
      return {
        apps: rows.map((app) => ({
          appId: app.appId,
          displayName: app.displayName,
          ...(app.systemPrompt !== undefined ? { systemPrompt: app.systemPrompt } : {}),
          createdAt: app.createdAt,
          updatedAt: app.updatedAt,
        })),
      };
    },
  });
}
