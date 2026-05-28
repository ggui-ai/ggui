/**
 * `ggui_ops_set_default_app` — write the calling user's
 * `GguiUser.defaultAppId` column.
 *
 * Sibling of the `useGguiUser` first-load hook (`apps/console/.../use-ggui-user`).
 * Same column, MCP surface. The handler chains `AppsSource.get` first
 * (verify the user owns the target appId) before writing
 * `UserDefaultAppSource.setDefault` — invariant: `defaultAppId` MUST
 * point at an app the user owns.
 *
 * Pure over two seams. The cloud pod binds AppSync-backed
 * implementations of both; tests bind in-memory fakes.
 */
import { z } from 'zod';
import type { HandlerContext, SharedHandler } from '../types.js';
import { resolveOwnerSub } from './identity.js';
import { AppNotFoundError } from './rename-app.js';
import type { AppsSource, UserDefaultAppSource } from './types.js';

const inputSchema = {
  appId: z
    .string()
    .min(1)
    .describe(
      'Target app — must be owned by the calling user. Discover via `ggui_ops_list_apps`.',
    ),
} as const;

const outputSchema = {
  defaultAppId: z.string(),
} as const;

export interface SetDefaultAppOutput {
  readonly defaultAppId: string;
}

export interface SetDefaultAppDeps {
  readonly apps: AppsSource;
  readonly userDefaultApp: UserDefaultAppSource;
}

export function createSetDefaultAppHandler(
  deps: SetDefaultAppDeps,
): SharedHandler<
  typeof inputSchema,
  typeof outputSchema,
  SetDefaultAppOutput
> {
  return {
    name: 'ggui_ops_set_default_app',
    title: 'Set default app',
    audience: ['ops'],
    description:
      "Set the calling user's `defaultAppId` — the universal MCP route resolves this on every request to scope the call. Target appId MUST be owned by the caller; cross-tenant targets throw `app_not_found`. Returns the persisted `defaultAppId`.",
    inputSchema,
    outputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<SetDefaultAppOutput> {
      const ownerSub = resolveOwnerSub('ggui_ops_set_default_app', ctx);
      const parsed = z.object(inputSchema).parse(rawInput);
      const existing = await deps.apps.get({
        appId: parsed.appId,
        ownerSub,
      });
      if (!existing) {
        throw new AppNotFoundError(parsed.appId);
      }
      await deps.userDefaultApp.setDefault({
        ownerSub,
        appId: parsed.appId,
      });
      return { defaultAppId: parsed.appId };
    },
  };
}
