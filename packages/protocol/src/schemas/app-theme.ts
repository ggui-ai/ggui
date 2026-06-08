import { z } from 'zod';

/** Platform CSS-variable namespace — only `--ggui-*` custom properties. */
export const GGUI_CSS_VAR_KEY_RE = /^--ggui-[a-z0-9-]+$/;

/**
 * A single safe CSS value. The map is serialized into a `:root { --k: v; }`
 * declaration block inside the rendered iframe, so a value MUST NOT be able to
 * terminate the declaration or open a new rule/comment. Forbid the breakout
 * characters `; { } < > @` and the comment opener `/*`. Everything else
 * (colors, lengths, `calc(...)`, `var(...)`, font-family lists) is allowed.
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
