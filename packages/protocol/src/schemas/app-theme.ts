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

export const appThemeSchema = z
  .object({
    mode: z.enum(['light', 'dark']),
    cssVariables: z
      .record(z.string().regex(GGUI_CSS_VAR_KEY_RE, 'css var key must be --ggui-*'), cssValue)
      .refine((m) => Object.keys(m).length <= 200, 'too many css variables (max 200)'),
    name: z.string().min(1).max(64).optional(),
  })
  .strict();

export type AppTheme = z.infer<typeof appThemeSchema>;
