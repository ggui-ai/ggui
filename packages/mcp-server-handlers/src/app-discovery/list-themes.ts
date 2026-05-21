/**
 * `ggui_list_themes` — per-app theme catalog discovery tool.
 *
 * Returns the list of `ThemeEntry` records the app exposes — every
 * registered preset by default, or an operator-curated filter when
 * `App.availableThemeIds` is set. Lets the agent reason about visual
 * style ("calming" vs "urgent" vs "marketing") by reading descriptions
 * instead of guessing at preset ids.
 *
 * ## Behavior
 *
 *   1. Validates input shape (`{appId?: string}`). Cross-tenant
 *      access protected the same way as `ggui_list_gadgets`.
 *   2. Reads the global theme catalog via the bound `themes` dep
 *      (a `() => readonly ThemeCatalogEntry[]` resolver — keeps the
 *      handler design-package-agnostic).
 *   3. If `app.availableThemeIds` is set, filters the catalog to just
 *      those ids; otherwise returns the full catalog.
 *
 * ## Audience
 *
 * `['agent']` — registered on `/mcp`. Agent-callable anytime; pair
 * with `ggui_new_session({themeId})` or `ggui_push({themeId})` to
 * apply a chosen theme.
 */

import { z } from 'zod';
import type { AppMetadataStore } from '@ggui-ai/mcp-server-core';
import type { HandlerContext, SharedHandler } from '../types.js';
import { AppAccessDeniedError } from './errors.js';

const inputSchema = {
  appId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'App id whose theme catalog to return. Defaults to the caller-resolved app id from the auth header. Cross-tenant requests fail with app_access_denied.',
    ),
} as const;

/**
 * Wire shape for a single theme entry. Mirrors `@ggui-ai/design`'s
 * `ThemeEntry` but kept local so this handler doesn't pull the design
 * package as a hard dep — the caller passes the catalog via the
 * `themes` resolver and is responsible for whatever upstream shape
 * produces it.
 */
const themeEntryWireSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    description: z.string(),
    modes: z.array(z.enum(['light', 'dark'])),
  })
  .passthrough();

const outputSchema = {
  themes: z.array(themeEntryWireSchema),
} as const;

export interface ThemeCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly modes: readonly ('light' | 'dark')[];
}

export interface GguiListThemesHandlerDeps {
  /**
   * Per-app metadata source. The handler reads `app.availableThemeIds`
   * off the resolved record; when present, filters the global catalog
   * to just the allowed ids. `null` result ⇒ no filter (return all).
   */
  readonly appMetadataStore: AppMetadataStore;
  /**
   * Global theme catalog resolver. Returns every theme the runtime
   * has registered. The CLI binds this to `@ggui-ai/design`'s
   * `listThemes()`; hosted deployments may project a different shape.
   * Kept as a function so the catalog can change mid-process without
   * a server restart (future operator-defined themes).
   */
  readonly themes: () => readonly ThemeCatalogEntry[];
}

export interface GguiListThemesOutput {
  readonly themes: readonly ThemeCatalogEntry[];
}

export function createGguiListThemesHandler(
  deps: GguiListThemesHandlerDeps,
): SharedHandler<
  typeof inputSchema,
  typeof outputSchema,
  GguiListThemesOutput
> {
  return {
    name: 'ggui_list_themes',
    title: 'List themes',
    audience: ['agent'],
    description:
      "List visual themes the agent may apply to a session via `ggui_new_session({themeId})` or `ggui_push({themeId})`. Each entry carries an `id` (pass to themeId), `name` (human-readable), `description` (agent-readable: e.g. 'warm marketing palette', 'high-contrast scientific dashboard'), and `modes` (light/dark variants the theme ships). Call this when the user's intent suggests a visual style choice — pick the theme whose description best matches the requested aesthetic. Operator-scoped: returns the per-app allowlist when one is configured, otherwise the full registered catalog.",
    inputSchema,
    outputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<GguiListThemesOutput> {
      const parsed = z.object(inputSchema).parse(rawInput);
      const resolvedAppId = parsed.appId ?? ctx.appId;
      if (parsed.appId !== undefined && parsed.appId !== ctx.appId) {
        throw new AppAccessDeniedError();
      }

      const app = await deps.appMetadataStore.get(resolvedAppId);
      const catalog = deps.themes();
      // Filter when allowlist is configured. Preserves catalog order
      // (so the picker UI stays stable) and silently drops ids that
      // appear in the allowlist but aren't registered (defensive
      // against operator typos — agent still sees a working list).
      if (app?.availableThemeIds && app.availableThemeIds.length > 0) {
        const allowed = new Set(app.availableThemeIds);
        return { themes: catalog.filter((t) => allowed.has(t.id)) };
      }
      return { themes: catalog };
    },
  };
}
