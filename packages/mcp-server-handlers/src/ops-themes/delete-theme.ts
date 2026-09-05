/**
 * `ggui_ops_delete_theme` — remove one runtime theme registration
 * (ggui#598-C). Idempotent-with-report: `deleted` says whether a
 * registration existed. Renders referencing a deleted theme fall back
 * per the resolution ladder — deletion never breaks a mounted frame.
 */
import { z } from 'zod';
import type { ThemeStore } from '@ggui-ai/mcp-server-core';
import { defineHandler, type ShapeOutput, type HandlerContext } from '../types.js';
import { resolveOwnerSub } from '../ops-apps/identity.js';
import { AppNotFoundError, type AppsSource } from '../ops-apps/types.js';

const inputSchema = {
  appId: z
    .string()
    .min(1)
    .describe('Target app — must be one the calling user owns.'),
  themeId: z.string().min(1).describe('The registered theme id to remove.'),
} as const;

const outputSchema = {
  themeId: z.string(),
  deleted: z
    .boolean()
    .describe('True iff a registration existed and was removed.'),
} as const;

/** The wire shape — derived from `outputSchema`, the one source of truth (#817). */
export type DeleteThemeOutput = ShapeOutput<typeof outputSchema>;

export interface DeleteThemeDeps {
  readonly apps: AppsSource;
  readonly themeStore: ThemeStore;
}

export function createDeleteThemeHandler(
  deps: DeleteThemeDeps,
) {
  return defineHandler({
    name: 'ggui_ops_delete_theme',
    title: 'Delete theme',
    audience: ['ops'],
    description:
      'Remove one registered runtime theme from an app the caller owns. Idempotent — `deleted` reports whether a registration existed. The id becomes registerable again.',
    inputSchema,
    outputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<DeleteThemeOutput> {
      const ownerSub = resolveOwnerSub('ggui_ops_delete_theme', ctx);
      const parsed = z.object(inputSchema).parse(rawInput);
      const app = await deps.apps.get({ appId: parsed.appId, ownerSub });
      if (!app) throw new AppNotFoundError(parsed.appId);
      const deleted = await deps.themeStore.delete(
        parsed.appId,
        parsed.themeId,
      );
      return { themeId: parsed.themeId, deleted };
    },
  });
}
