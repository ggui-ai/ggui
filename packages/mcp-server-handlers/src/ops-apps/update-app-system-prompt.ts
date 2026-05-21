/**
 * `ggui_ops_update_app_system_prompt` — set / clear the per-app
 * `systemPrompt` override.
 *
 * Sibling of the console's Apps → System Prompt editor. Same column,
 * MCP surface. Empty-string input clears the override (the pod's
 * `ggui_new_session` resolution chain falls back to the universal
 * default when this field is absent or empty).
 *
 * Tenancy: cross-tenant probes throw `app_not_found` (uniform with
 * the rename/set-default paths).
 *
 * Pure over the {@link AppsSource} seam.
 */
import { z } from 'zod';
import type { HandlerContext, SharedHandler } from '../types.js';
import { resolveOwnerSub } from './identity.js';
import { AppNotFoundError } from './rename-app.js';
import type { AppRecord, AppsSource } from './types.js';

const inputSchema = {
  appId: z
    .string()
    .min(1)
    .describe(
      'Target `GguiApp.appId` — must be owned by the calling user. Discover via `ggui_ops_list_apps`.',
    ),
  systemPrompt: z
    .string()
    .max(10_000)
    .describe(
      "Replacement system-prompt text. Pass an empty string to clear the per-app override (sessions then use the universal default). Cap 10k chars to bound the response payload + match a reasonable agent-authored prompt length.",
    ),
} as const;

const outputSchema = {
  appId: z.string(),
  displayName: z.string(),
  systemPrompt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
} as const;

export interface UpdateAppSystemPromptOutput {
  readonly appId: string;
  readonly displayName: string;
  readonly systemPrompt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpdateAppSystemPromptDeps {
  readonly apps: AppsSource;
}

export function createUpdateAppSystemPromptHandler(
  deps: UpdateAppSystemPromptDeps,
): SharedHandler<
  typeof inputSchema,
  typeof outputSchema,
  UpdateAppSystemPromptOutput
> {
  return {
    name: 'ggui_ops_update_app_system_prompt',
    title: 'Update app system prompt',
    audience: ['ops'],
    description:
      "Set or clear the per-app system-prompt override on a `GguiApp` the caller owns. Empty-string clears the field — the pod's session resolution then falls back to the universal default. Cross-tenant targets throw `app_not_found`. Returns the updated row (10k char cap on input).",
    inputSchema,
    outputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<UpdateAppSystemPromptOutput> {
      const ownerSub = resolveOwnerSub(
        'ggui_ops_update_app_system_prompt',
        ctx,
      );
      const parsed = z.object(inputSchema).parse(rawInput);
      const existing = await deps.apps.get({
        appId: parsed.appId,
        ownerSub,
      });
      if (!existing) {
        throw new AppNotFoundError(parsed.appId);
      }
      const updated: AppRecord = await deps.apps.setSystemPrompt({
        appId: parsed.appId,
        ownerSub,
        systemPrompt: parsed.systemPrompt,
      });
      return {
        appId: updated.appId,
        displayName: updated.displayName,
        ...(updated.systemPrompt !== undefined && updated.systemPrompt !== ''
          ? { systemPrompt: updated.systemPrompt }
          : {}),
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      };
    },
  };
}
