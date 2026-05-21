/**
 * `ggui_ops_list_apps` — enumerate the calling user's `GguiApp` rows.
 *
 * Sibling of the console's Apps section (`apps/console/src/.../apps/`)
 * — same data, MCP surface. Pure over the {@link AppsSource} seam; the
 * cloud pod binds an AppSync-backed implementation, tests bind an
 * in-memory Map.
 *
 * Identity scope: caller's Cognito sub from `ctx.userId` (or
 * `ctx.appId` in OSS single-tenant mode). Cross-user list is impossible
 * by construction — `AppsSource.list` only returns rows whose
 * `ownerSub` matches.
 */
import { z } from 'zod';
import type { HandlerContext, SharedHandler } from '../types.js';
import { resolveOwnerSub } from './identity.js';
import type { AppRecord, AppsSource } from './types.js';

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

export interface ListAppsOutput {
  readonly apps: readonly AppRecord[];
}

export interface ListAppsDeps {
  readonly apps: AppsSource;
}

export function createListAppsHandler(
  deps: ListAppsDeps,
): SharedHandler<typeof inputSchema, typeof outputSchema, ListAppsOutput> {
  return {
    name: 'ggui_ops_list_apps',
    title: 'List apps',
    audience: ['ops'],
    description:
      "Enumerate every `GguiApp` row owned by the calling user. Returns metadata only (appId, displayName, optional systemPrompt, createdAt, updatedAt). Same data the console's Apps section renders. Use to discover ids before calling `ggui_ops_rename_app` / `ggui_ops_set_default_app` / `ggui_ops_delete_app`.",
    inputSchema,
    outputSchema,
    async handler(
      _input: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<ListAppsOutput> {
      const ownerSub = resolveOwnerSub('ggui_ops_list_apps', ctx);
      const apps = await deps.apps.list(ownerSub);
      return { apps };
    },
  };
}
