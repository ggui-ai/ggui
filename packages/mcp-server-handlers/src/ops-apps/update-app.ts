/**
 * `ggui_ops_update_app` — consolidated partial update of a `GguiApp`
 * row the caller owns: `displayName`, `systemPrompt`, and
 * `rateLimitPerMinute` in one tool. At least one field must be
 * supplied — an empty update is rejected before any store work.
 *
 * Clearing sentinels (one per field, normalized by the store so the
 * persisted row keeps a single "unset" representation):
 *   - `systemPrompt: ''` clears the per-app override.
 *   - `rateLimitPerMinute: 0` clears the limit (unlimited).
 *
 * Ownership: the handler reads `AppsSource.get` first (which scopes by
 * `ownerSub`), then dispatches the update. Cross-user probes return
 * a uniform "not found" shape so an attacker can't learn whether an
 * `appId` belongs to another owner. Store implementations
 * additionally scope the write itself to the owner, so the ownership
 * guard holds even without the pre-read.
 *
 * Pure over the {@link AppsSource} seam.
 */
import { z } from 'zod';
import { defineHandler, type HandlerContext } from '../types.js';
import { resolveOwnerSub } from './identity.js';
import { AppNotFoundError } from './types.js';
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
    .describe('New display name. Cap 120 chars.')
    .optional(),
  systemPrompt: z
    .string()
    .max(10_000)
    .describe(
      'Replacement system-prompt text. Pass an empty string to clear the per-app override (renders then use the universal default). Cap 10k chars.',
    )
    .optional(),
  rateLimitPerMinute: z
    .number()
    .int()
    .min(0)
    .describe(
      'Per-API-key render rate limit (renders/minute). Pass 0 to clear the limit (unlimited).',
    )
    .optional(),
} as const;

const outputSchema = {
  appId: z.string(),
  displayName: z.string(),
  systemPrompt: z.string().optional(),
  rateLimitPerMinute: z
    .number()
    .int()
    .optional()
    .describe('Absent when no limit is set (unlimited).'),
  createdAt: z.string(),
  updatedAt: z.string(),
} as const;

export interface UpdateAppOutput {
  readonly appId: string;
  readonly displayName: string;
  readonly systemPrompt?: string;
  readonly rateLimitPerMinute?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpdateAppDeps {
  readonly apps: AppsSource;
}

export function createUpdateAppHandler(
  deps: UpdateAppDeps,
) {
  return defineHandler({
    name: 'ggui_ops_update_app',
    title: 'Update app',
    audience: ['ops'],
    description:
      "Partially update an app the caller owns — `displayName`, `systemPrompt`, and/or `rateLimitPerMinute` in one call; at least one field is required. Clearing sentinels: empty-string `systemPrompt` clears the per-app override; `rateLimitPerMinute: 0` clears the limit (unlimited). Targets owned by another user throw `app_not_found` (uniform shape; no existence leak). Returns the updated row.",
    inputSchema,
    outputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<UpdateAppOutput> {
      const ownerSub = resolveOwnerSub('ggui_ops_update_app', ctx);
      const parsed = z.object(inputSchema).parse(rawInput);
      if (
        parsed.displayName === undefined &&
        parsed.systemPrompt === undefined &&
        parsed.rateLimitPerMinute === undefined
      ) {
        throw new Error(
          'ggui_ops_update_app: at least one of displayName, systemPrompt, rateLimitPerMinute must be provided',
        );
      }
      const existing = await deps.apps.get({
        appId: parsed.appId,
        ownerSub,
      });
      if (!existing) {
        throw new AppNotFoundError(parsed.appId);
      }
      const updated: AppRecord = await deps.apps.update({
        appId: parsed.appId,
        ownerSub,
        patch: {
          ...(parsed.displayName !== undefined
            ? { displayName: parsed.displayName }
            : {}),
          ...(parsed.systemPrompt !== undefined
            ? { systemPrompt: parsed.systemPrompt }
            : {}),
          ...(parsed.rateLimitPerMinute !== undefined
            ? { rateLimitPerMinute: parsed.rateLimitPerMinute }
            : {}),
        },
      });
      return {
        appId: updated.appId,
        displayName: updated.displayName,
        ...(updated.systemPrompt !== undefined && updated.systemPrompt !== ''
          ? { systemPrompt: updated.systemPrompt }
          : {}),
        ...(updated.rateLimitPerMinute !== undefined &&
        updated.rateLimitPerMinute > 0
          ? { rateLimitPerMinute: updated.rateLimitPerMinute }
          : {}),
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      };
    },
  });
}
