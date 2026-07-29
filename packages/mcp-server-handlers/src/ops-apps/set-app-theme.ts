/**
 * `ggui_ops_set_app_theme` — replace the theme on a `GguiApp` row the
 * caller owns.
 *
 * The theme payload is validated with the protocol's canonical
 * {@link appThemeSchema} — the SAME validator every other write
 * surface for `GguiApp.theme` runs — so no surface can persist a
 * theme another surface would reject: `--ggui-*` CSS-variable keys
 * only, value-level breakout characters forbidden, ≤200 variables.
 *
 * Tenancy: `AppsSource.get` first (scoped by `ownerSub`); cross-user
 * probes return the uniform "not found" shape. The store scopes the
 * write itself to the owner as well.
 *
 * Pure over the {@link AppsSource} seam.
 */
import { appThemeSchema } from '@ggui-ai/protocol';
import { z } from 'zod';
import type { HandlerContext, SharedHandler } from '../types.js';
import { resolveOwnerSub } from './identity.js';
import { AppNotFoundError } from './types.js';
import type { AppsSource } from './types.js';

const inputSchema = {
  appId: z
    .string()
    .min(1)
    .describe(
      'Target `GguiApp.appId` — must be one the calling user owns. Discover via `ggui_ops_list_apps`.',
    ),
  theme: appThemeSchema.describe(
    'Theme envelope `{mode, cssVariables, name?}`. `mode` is `light` or `dark`; `cssVariables` maps `--ggui-*` keys to CSS values (≤200 entries, breakout characters rejected); `name` is an optional 1-64 char label.',
  ),
} as const;

const outputSchema = {
  appId: z.string(),
  theme: appThemeSchema,
  updatedAt: z.string(),
} as const;

export interface SetAppThemeOutput {
  readonly appId: string;
  readonly theme: z.infer<typeof appThemeSchema>;
  readonly updatedAt: string;
}

export interface SetAppThemeDeps {
  readonly apps: AppsSource;
}

export function createSetAppThemeHandler(
  deps: SetAppThemeDeps,
): SharedHandler<typeof inputSchema, typeof outputSchema, SetAppThemeOutput> {
  return {
    name: 'ggui_ops_set_app_theme',
    title: 'Set app theme',
    audience: ['ops'],
    description:
      "Replace the theme on an app the caller owns. The `theme` payload is validated with the protocol's `appThemeSchema` (only `--ggui-*` CSS-variable keys, safe values, ≤200 entries) — the same validator every theme write surface enforces. Cross-tenant targets throw `app_not_found` (uniform shape; no existence leak). Returns the persisted theme.",
    inputSchema,
    outputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<SetAppThemeOutput> {
      const ownerSub = resolveOwnerSub('ggui_ops_set_app_theme', ctx);
      const parsed = z.object(inputSchema).parse(rawInput);
      const existing = await deps.apps.get({
        appId: parsed.appId,
        ownerSub,
      });
      if (!existing) {
        throw new AppNotFoundError(parsed.appId);
      }
      const written = await deps.apps.setTheme({
        appId: parsed.appId,
        ownerSub,
        theme: parsed.theme,
      });
      return {
        appId: written.appId,
        theme: parsed.theme,
        updatedAt: written.updatedAt,
      };
    },
  };
}
