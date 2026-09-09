import { z } from 'zod';

/**
 * Platform CSS-variable namespace — only `--ggui-*` custom properties.
 *
 * The charset allows mixed-case ASCII because the canonical theme parser
 * (`@ggui-ai/design`) emits camelCase token segments verbatim into the
 * variable name (e.g. `--ggui-color-onSurface`, `--ggui-zIndex-modal`,
 * `--ggui-font-lineHeight-tight`) — and the design system both EMITS and
 * CONSUMES those exact keys (`var(--ggui-color-onSurface)`). Case has no
 * bearing on injection safety; the `--ggui-` prefix is the namespace guard
 * and value-level breakout characters are forbidden by {@link CSS_VALUE_SAFE_RE}.
 */
export const GGUI_CSS_VAR_KEY_RE = /^--ggui-[a-zA-Z0-9-]+$/;

/**
 * A single safe CSS value. The map is serialized into a `:root { --k: v; }`
 * declaration block inside the rendered iframe, so a value MUST NOT be able to
 * terminate the declaration or open a new rule/comment. Forbid the breakout
 * characters `; { } < > @` and the comment opener `/*`. Everything else
 * (colors, lengths, `calc(...)`, `var(...)`, font-family lists) is allowed.
 *
 * PARTIAL gate — this regex alone is NOT a complete validator. Bare `/` and
 * `*` are intentionally allowed (legal in `16px/1.5`, `calc(2 * 4px)`); only
 * the `/*` comment-opener SEQUENCE is forbidden, and that check lives in
 * {@link appThemeSchema}'s `.refine`, not here. Callers MUST validate values
 * through `appThemeSchema` (the complete validator) — never against this
 * bare regex on its own.
 */
export const CSS_VALUE_SAFE_RE = /^[^;{}<>@]*$/;

const cssValue = z
  .string()
  .min(1)
  .max(256)
  .regex(CSS_VALUE_SAFE_RE, 'css value contains a disallowed character')
  .refine((v) => !v.includes('/*'), 'css value may not contain a comment');

const cssVariableMap = z
  .record(z.string().regex(GGUI_CSS_VAR_KEY_RE, 'css var key must be --ggui-*'), cssValue)
  .refine((m) => Object.keys(m).length <= 200, 'too many css variables (max 200)');

export const appThemeSchema = z
  .object({
    /**
     * Default appearance: the mode painted when NO embedding host announces
     * one. Never a pin — the host owns runtime mode (ggui#987 D4; see
     * `integrations/theme-binding.ts`). Absent ⇒ mode-neutral.
     */
    mode: z.enum(['light', 'dark']).optional(),
    /** A label the author's tooling reads back. Never resolved by a renderer. */
    name: z.string().min(1).max(64).optional(),
    /**
     * Delivery attestation: `canonicalOverlayHash({ overlays, cssVariables,
     * keyframes })` (`integrations/overlay-hash.ts`). Every write door
     * recomputes it and refuses a mismatch; read doors pass it through.
     */
    overlayHash: z.string().regex(/^[0-9a-f]{64}$/, 'overlayHash must be sha256 lowercase hex'),
    /**
     * The projection, both modes — the derived `--ggui-*` sets a card
     * injects for the effective mode (ggui#987 §2.4: produced by ONE
     * function on every path). REQUIRED, both: an overlay that could not
     * follow the host's mode is not accepted.
     */
    overlays: z.object({ light: cssVariableMap, dark: cssVariableMap }).strict(),
    /** Mode-agnostic per-app overrides, injected above both projections. */
    cssVariables: cssVariableMap.optional(),
    /** Per-mode `@keyframes` blocks, injected verbatim after the variables. */
    keyframes: z
      .object({
        light: z.string().max(8192).optional(),
        dark: z.string().max(8192).optional(),
      })
      .strict()
      .optional(),
    /**
     * The embedding host owns the card silhouette: the renderer appends the
     * root-children border-suppression rule.
     */
    frameless: z.boolean().optional(),
  })
  .strict();

export type AppTheme = z.infer<typeof appThemeSchema>;

/**
 * The ONE refusal body every write door returns for an overlay it will not
 * store (ggui#987 §3.4): REST 422 `invalid_app_config`, the AppSync
 * `errorInfo`, the MCP ops door's `{ ok: false }` structured content. A
 * discriminated union by key — exactly one of the four.
 */
export const appThemeRefusalBodySchema = z.union([
  z.object({ uncovered: z.object({ light: z.array(z.string()), dark: z.array(z.string()) }).strict() }).strict(),
  z.object({ unknown: z.object({ light: z.array(z.string()), dark: z.array(z.string()) }).strict() }).strict(),
  z.object({ overlayHash: z.literal('mismatch') }).strict(),
  z.object({ refused: z.literal('v1 shape') }).strict(),
]);
export type AppThemeRefusalBody = z.infer<typeof appThemeRefusalBodySchema>;
