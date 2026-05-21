/**
 * `ggui_ops_rename_app` — update the `displayName` of an existing
 * `GguiApp` row owned by the caller.
 *
 * Tenancy: the handler reads `AppsSource.get` first (which scopes by
 * `ownerSub`), then dispatches the rename. Cross-user probes return
 * a uniform "not found" shape so an attacker can't learn whether an
 * `appId` exists in another tenant.
 *
 * Pure over the {@link AppsSource} seam — the cloud pod binds an
 * AppSync-backed `update({ appId, displayName })` implementation that
 * adds a ConditionExpression on `userId == :sub` to make the tenancy
 * guard atomic at the DDB layer too.
 */
import { z } from 'zod';
import type { HandlerContext, SharedHandler } from '../types.js';
import { resolveOwnerSub } from './identity.js';
import type { AppRecord, AppsSource } from './types.js';

const inputSchema = {
  appId: z
    .string()
    .min(1)
    .describe(
      'Target `GguiApp.appId` — must be one the calling user owns. Discover via `ggui_ops_list_apps`.',
    ),
  displayName: z
    .string()
    .min(1)
    .max(120)
    .describe(
      'New display name. Cap 120 chars — matches the cloud provisioning Lambda.',
    ),
} as const;

const outputSchema = {
  appId: z.string(),
  displayName: z.string(),
  systemPrompt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
} as const;

export interface RenameAppOutput {
  readonly appId: string;
  readonly displayName: string;
  readonly systemPrompt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class AppNotFoundError extends Error {
  readonly code = 'app_not_found' as const;
  constructor(appId: string) {
    super(`app_not_found: no app ${JSON.stringify(appId)} for the calling user`);
    this.name = 'AppNotFoundError';
  }
}

export interface RenameAppDeps {
  readonly apps: AppsSource;
}

export function createRenameAppHandler(
  deps: RenameAppDeps,
): SharedHandler<typeof inputSchema, typeof outputSchema, RenameAppOutput> {
  return {
    name: 'ggui_ops_rename_app',
    title: 'Rename app',
    audience: ['ops'],
    description:
      "Update an existing app's `displayName`. The target app MUST be owned by the calling user — cross-tenant probes return `app_not_found` (uniform shape; no existence leak). Cap 120 chars on the new label. Returns the updated row.",
    inputSchema,
    outputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<RenameAppOutput> {
      const ownerSub = resolveOwnerSub('ggui_ops_rename_app', ctx);
      const parsed = z.object(inputSchema).parse(rawInput);
      const existing = await deps.apps.get({
        appId: parsed.appId,
        ownerSub,
      });
      if (!existing) {
        throw new AppNotFoundError(parsed.appId);
      }
      const updated: AppRecord = await deps.apps.rename({
        appId: parsed.appId,
        ownerSub,
        displayName: parsed.displayName,
      });
      return {
        appId: updated.appId,
        displayName: updated.displayName,
        ...(updated.systemPrompt !== undefined
          ? { systemPrompt: updated.systemPrompt }
          : {}),
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      };
    },
  };
}
