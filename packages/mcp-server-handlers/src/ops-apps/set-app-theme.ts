/**
 * `ggui_ops_set_app_theme` — replace the theme on a `GguiApp` row the
 * caller owns. The MCP write door for the per-app theme (ggui#987
 * §3.4).
 *
 * A theme is the PROJECTION: both modes' derived `--ggui-*` sets plus
 * the attestation that names them. The door admits it in three
 * checks, the SAME three every other write door for `GguiApp.theme`
 * runs, so no surface can persist a theme another surface would
 * refuse:
 *
 *   1. shape — protocol's `appThemeSchema` (v2, `.strict()`); the
 *      retired one-palette body is named as such (`refused: 'v1
 *      shape'`) rather than failing as a pile of missing fields;
 *   2. attestation — `overlayHash` is recomputed with
 *      `canonicalOverlayHash` and a mismatch is refused;
 *   3. coverage — the injected overlay validator judges each mode's
 *      set against the consumed-token manifest: a key outside the
 *      manifest (`unknown`) or a consumed token left unset
 *      (`uncovered`) is refused, per mode.
 *
 * A refusal is a schema-conformant `{ ok: false, code:
 * 'invalid_app_config', refusal }` RESULT (not a thrown error): the
 * body is one of the four the protocol names
 * (`appThemeRefusalBodySchema`), so a client reads the same refusal
 * from REST, AppSync and this door.
 *
 * Ownership: `AppsSource.get` first (scoped by `ownerSub`); cross-user
 * probes return the uniform "not found" shape. The store scopes the
 * write itself to the owner as well.
 *
 * Pure over the {@link AppsSource} seam + the injected validator.
 */
import {
  appThemeSchema,
  appThemeRefusalBodySchema,
  canonicalOverlayHash,
  type AppTheme,
  type AppThemeRefusalBody,
} from '@ggui-ai/protocol';
import { z } from 'zod';
import {
  defineHandler,
  handlerFailure,
  type HandlerContext,
  type SharedHandlerResult,
} from '../types.js';
import { resolveOwnerSub } from './identity.js';
import { AppNotFoundError } from './types.js';
import type { AppsSource } from './types.js';

/**
 * The coverage judgement over ONE mode's overlay, as `@ggui-ai/design`'s
 * `validateOverlayCoverage` reports it. Injected rather than imported:
 * the manifest is the design package's, and the composer binds it.
 */
export type OverlayCoverageValidator = (overlay: Readonly<Record<string, string>>) => {
  readonly uncovered: readonly string[];
  readonly unknown: readonly string[];
  readonly warnings: readonly string[];
};

const inputSchema = {
  appId: z
    .string()
    .min(1)
    .describe(
      'Target `GguiApp.appId` — must be one the calling user owns. Discover via `ggui_ops_list_apps`.',
    ),
  theme: appThemeSchema.describe(
    'The app theme: `overlays.light` / `overlays.dark` are the derived `--ggui-*` sets (every consumed token, minus the floor the renderer owns), `overlayHash` = canonicalOverlayHash({ overlays, cssVariables, keyframes }); optional `mode` (the default when no host announces one), `name` (a label), `cssVariables` (mode-agnostic overrides), `keyframes` (per mode), `frameless`. Refused with `invalid_app_config` when a mode leaves a token uncovered, names a token outside the manifest, the attestation mismatches, or the body is the retired one-palette shape.',
  ),
} as const;

const outputSchema = {
  ok: z.boolean(),
  appId: z.string().optional(),
  theme: appThemeSchema.optional(),
  updatedAt: z.string().optional(),
  /** Present on a refusal: the one refusal class this door emits. */
  code: z.literal('invalid_app_config').optional(),
  /** Present on a coverage / attestation / v1-shape refusal — one of the four protocol-named bodies. */
  refusal: appThemeRefusalBodySchema.optional(),
  /** Present on a shape refusal the schema itself raised — its messages, one per issue. */
  issues: z.array(z.string()).optional(),
} as const;

/** Derived from the output schema — one shape, never a hand mirror. */
export type SetAppThemeOutput = z.infer<z.ZodObject<typeof outputSchema>>;

export interface SetAppThemeDeps {
  readonly apps: AppsSource;
  /** Coverage judgement per mode — bind to `validateOverlayCoverage` from `@ggui-ai/design`. */
  readonly overlayCoverage: OverlayCoverageValidator;
}

/** The door's verdict on a raw body: the theme to persist, or why not. */
export type AppThemeAdmission =
  | { readonly ok: true; readonly theme: AppTheme }
  | { readonly ok: false; readonly refusal: AppThemeRefusalBody }
  | { readonly ok: false; readonly issues: readonly string[] };

/** The retired one-palette body: `cssVariables` at the top with no `overlays`. */
function isV1Shape(raw: unknown): boolean {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    'cssVariables' in raw &&
    !('overlays' in raw)
  );
}

/**
 * Admit a raw theme body: shape, attestation, coverage — in that order,
 * first failure wins; `unknown` outranks `uncovered` because a key the
 * manifest does not name is the more fundamental disagreement. Exported
 * so any other in-process door runs exactly these checks.
 */
export async function admitAppTheme(
  raw: unknown,
  overlayCoverage: OverlayCoverageValidator,
): Promise<AppThemeAdmission> {
  if (isV1Shape(raw)) return { ok: false, refusal: { refused: 'v1 shape' } };
  const parsed = appThemeSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`) };
  }
  const theme = parsed.data;
  const expected = await canonicalOverlayHash({
    overlays: theme.overlays,
    ...(theme.cssVariables !== undefined ? { cssVariables: theme.cssVariables } : {}),
    ...(theme.keyframes !== undefined ? { keyframes: theme.keyframes } : {}),
  });
  if (expected !== theme.overlayHash) return { ok: false, refusal: { overlayHash: 'mismatch' } };
  const light = overlayCoverage(theme.overlays.light);
  const dark = overlayCoverage(theme.overlays.dark);
  if (light.unknown.length > 0 || dark.unknown.length > 0) {
    return { ok: false, refusal: { unknown: { light: [...light.unknown], dark: [...dark.unknown] } } };
  }
  if (light.uncovered.length > 0 || dark.uncovered.length > 0) {
    return { ok: false, refusal: { uncovered: { light: [...light.uncovered], dark: [...dark.uncovered] } } };
  }
  return { ok: true, theme };
}

function refusalText(admission: Exclude<AppThemeAdmission, { ok: true }>): string {
  if ('issues' in admission) return `invalid_app_config: theme body rejected — ${admission.issues.join('; ')}`;
  const r = admission.refusal;
  if ('refused' in r) return 'invalid_app_config: the one-palette theme body is retired — send { overlays: { light, dark }, overlayHash, … }';
  if ('overlayHash' in r) return 'invalid_app_config: overlayHash does not match canonicalOverlayHash({ overlays, cssVariables, keyframes })';
  if ('unknown' in r) return `invalid_app_config: keys outside the consumed-token manifest — light: [${r.unknown.light.join(', ')}] dark: [${r.unknown.dark.join(', ')}]`;
  return `invalid_app_config: consumed tokens left uncovered — light: [${r.uncovered.light.join(', ')}] dark: [${r.uncovered.dark.join(', ')}]`;
}

export function createSetAppThemeHandler(deps: SetAppThemeDeps) {
  return defineHandler({
    name: 'ggui_ops_set_app_theme',
    title: 'Set app theme',
    audience: ['ops'],
    description:
      "Replace the theme on an app the caller owns. The `theme` carries both modes' derived `--ggui-*` sets (`overlays`) and their attestation (`overlayHash`); the door checks shape, attestation and coverage against the consumed-token manifest and answers a refusal as `{ ok: false, code: 'invalid_app_config', refusal }`. Discover app ids via `ggui_ops_list_apps`.",
    inputSchema,
    outputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<SharedHandlerResult<SetAppThemeOutput>> {
      const ownerSub = resolveOwnerSub('ggui_ops_set_app_theme', ctx);
      const appId = z.object({ appId: inputSchema.appId }).parse(rawInput).appId;
      const existing = await deps.apps.get({ appId, ownerSub });
      if (!existing) {
        throw new AppNotFoundError(appId);
      }
      const admission = await admitAppTheme(rawInput['theme'], deps.overlayCoverage);
      if (!admission.ok) {
        const data: SetAppThemeOutput = {
          ok: false,
          code: 'invalid_app_config',
          ...('issues' in admission ? { issues: [...admission.issues] } : { refusal: admission.refusal }),
        };
        return handlerFailure(data, refusalText(admission));
      }
      const written = await deps.apps.setTheme({ appId, ownerSub, theme: admission.theme });
      return {
        ok: true,
        appId: written.appId,
        theme: admission.theme,
        updatedAt: written.updatedAt,
      };
    },
  });
}
