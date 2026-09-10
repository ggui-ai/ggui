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

/**
 * The grammar a per-mode `keyframes` string MUST satisfy (ggui#987 §3.4,
 * follower D). The renderer injects the text verbatim into the card's
 * `<style>` after the variables, so the text is bounded to what that slot
 * is FOR: zero or more `@keyframes <ident> { <frame-selectors> { <declarations> } … }`
 * blocks and nothing else — no other at-rule (`@import`, `@font-face`,
 * `@media`, …), no `<` / `>`, braces balanced and nested exactly one level
 * inside a block. Comments (`/* … *\/`) are stripped before the walk and are
 * therefore allowed, as `cssVariableMap` values allow `url(`; the deny-list
 * on values (`;{}<>@`) cannot apply verbatim here because `;`, `{`, `}` and
 * the one `@` ARE the grammar. Same principal, same slot, one rule.
 */
export const KEYFRAMES_NAME_RE = /^[A-Za-z_-][A-Za-z0-9_-]*$/;

export function isKeyframesText(text: string): boolean {
  const s = text.replace(/\/\*[\s\S]*?\*\//g, ' ');
  if (/[<>]/.test(s)) return false;
  let i = 0;
  const n = s.length;
  const skipWs = () => {
    while (i < n && /\s/.test(s[i] as string)) i += 1;
  };
  for (;;) {
    skipWs();
    if (i >= n) return true;
    if (!s.startsWith('@keyframes', i)) return false;
    i += '@keyframes'.length;
    if (i >= n || !/\s/.test(s[i] as string)) return false;
    skipWs();
    const nameStart = i;
    while (i < n && /[A-Za-z0-9_-]/.test(s[i] as string)) i += 1;
    if (!KEYFRAMES_NAME_RE.test(s.slice(nameStart, i))) return false;
    skipWs();
    if (s[i] !== '{') return false;
    i += 1;
    // Inside the block: frame rules only — `selectors { declarations }` at depth 1, no `@`.
    let depth = 1;
    while (i < n && depth > 0) {
      const ch = s[i] as string;
      if (ch === '@') return false;
      if (ch === '{') {
        depth += 1;
        if (depth > 2) return false;
      } else if (ch === '}') {
        depth -= 1;
      }
      i += 1;
    }
    if (depth !== 0) return false;
  }
}

/** A per-mode keyframes string: `@keyframes` blocks only (see {@link isKeyframesText}), 8 KiB cap unchanged. */
const keyframesText = z
  .string()
  .max(8192)
  .refine(isKeyframesText, 'keyframes must be `@keyframes <name> { … }` blocks and nothing else');

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
    /** Per-mode `@keyframes` blocks, injected verbatim after the variables — bounded to that grammar by {@link isKeyframesText}. */
    keyframes: z
      .object({
        light: keyframesText.optional(),
        dark: keyframesText.optional(),
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
