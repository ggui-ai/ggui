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
  /**
   * Migration nudge (ggui#598 slice 3): present when the overlay is
   * BRAND-SHAPED — ≥3 color families over a name that resolves to no
   * registered theme. The write still succeeds (overlays stay legal);
   * the tier just stops being silent about brands living in it.
   */
  warning: z.string().optional(),
} as const;

export interface SetAppThemeOutput {
  readonly appId: string;
  readonly theme: z.infer<typeof appThemeSchema>;
  readonly updatedAt: string;
  readonly warning?: string;
}

export interface SetAppThemeDeps {
  readonly apps: AppsSource;
  /**
   * Known theme ids (built-in presets + registered) for the
   * brand-shaped-overlay WARN's name resolution. Absent = names cannot
   * be resolved, so brand-scale coverage always draws the nudge.
   */
  readonly knownThemeIds?: readonly string[];
}

/**
 * Detect a BRAND-SHAPED overlay (ggui#598 slice 3): ≥3 distinct color
 * families in the variable map while the overlay's `name` resolves to
 * no known theme. A brand living in the accent tier is the round-3
 * mechanism — the overlay inherits every unmapped token from someone
 * else's ladder. The WARN names the registration path; it never
 * blocks. Exported for its unit pins.
 *
 * @internal
 */
export function detectBrandShapedOverlay(
  theme: z.infer<typeof appThemeSchema>,
  deps: Pick<SetAppThemeDeps, 'knownThemeIds'>,
): string | undefined {
  const families = new Set<string>();
  for (const key of Object.keys(theme.cssVariables)) {
    const m = key.match(/^--ggui-color-([a-zA-Z]+)/);
    if (m) families.add(m[1]!.toLowerCase());
  }
  if (families.size < 3) return undefined;
  if (
    theme.name !== undefined &&
    deps.knownThemeIds !== undefined &&
    deps.knownThemeIds.includes(theme.name)
  ) {
    // Brand-scale accents over a COVERED registered base — legitimate.
    return undefined;
  }
  return `This overlay carries ${families.size} color families over ${
    theme.name !== undefined ? `an unregistered name ("${theme.name}")` : 'no named base'
  } — brand-scale theming belongs in a REGISTERED theme (runtime theme registration), where coverage is validated and every token is yours; overlays are accents over a covered base. The write succeeded; unmapped tokens will paint the default ladder.`;
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
      const warning = detectBrandShapedOverlay(parsed.theme, deps);
      return {
        appId: written.appId,
        theme: parsed.theme,
        ...(warning !== undefined ? { warning } : {}),
        updatedAt: written.updatedAt,
      };
    },
  };
}
