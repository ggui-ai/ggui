/**
 * `ggui_ops_list_themes` — the caller's registered themes for one of
 * their apps (ggui#598-C). Metadata only — the registration document
 * itself never rides a list (bounded output; fetch-by-id is a later
 * surface if a reader ever needs the bytes back).
 */
import { z } from 'zod';
import type { ThemeStore } from '@ggui-ai/mcp-server-core';
import { defineHandler, type HandlerContext, type ShapeOutput } from '../types.js';
import { resolveOwnerSub } from '../ops-apps/identity.js';
import { AppNotFoundError, type AppsSource } from '../ops-apps/types.js';

const inputSchema = {
  appId: z
    .string()
    .min(1)
    .describe('Target app — must be one the calling user owns.'),
} as const;

const outputSchema = {
  themes: z.array(
    z.object({
      themeId: z.string(),
      documentHash: z
        .string()
        .describe('sha256 over the stored registration bytes.'),
      registeredAt: z.number().describe('First-registration ms epoch.'),
      updatedAt: z.number().describe('Last-write ms epoch.'),
    }),
  ),
} as const;

/** The wire shape — derived from `outputSchema`, the one source of truth (#817). */
export type ListThemesOutput = ShapeOutput<typeof outputSchema>;

export interface ListThemesDeps {
  readonly apps: AppsSource;
  readonly themeStore: ThemeStore;
}

export function createListThemesHandler(deps: ListThemesDeps) {
  return defineHandler({
    name: 'ggui_ops_list_themes',
    title: 'List themes',
    audience: ['ops'],
    description:
      "The app's registered runtime themes — id, documentHash, and timestamps, themeId-sorted. Registration documents themselves are not included.",
    inputSchema,
    outputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<ListThemesOutput> {
      const ownerSub = resolveOwnerSub('ggui_ops_list_themes', ctx);
      const parsed = z.object(inputSchema).parse(rawInput);
      const app = await deps.apps.get({ appId: parsed.appId, ownerSub });
      if (!app) throw new AppNotFoundError(parsed.appId);
      const rows = await deps.themeStore.list(parsed.appId);
      return {
        themes: rows.map((r) => ({
          themeId: r.themeId,
          documentHash: r.documentHash,
          registeredAt: r.registeredAt,
          updatedAt: r.updatedAt,
        })),
      };
    },
  });
}
