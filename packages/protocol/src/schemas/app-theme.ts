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

/**
 * https-only asset URL with a well-formed host — the theme document's rule
 * for a declared face (ggui#987 §5), now the wire's rule for every asset an
 * AppTheme names. Grammar only: nothing here is fetched.
 */
function isHttpsAssetUrl(src: string): boolean {
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && /^[a-z0-9.-]+$/i.test(url.hostname) && url.hostname.includes('.');
}
const httpsAssetUrl = z.string().min(1).refine(isHttpsAssetUrl, 'src must be an https: URL with a well-formed host');

/**
 * One declared font face (ggui#987 §5; lifted here for ggui#1093 / #990 so the
 * theme DOCUMENT's `typography.faces` and the AppTheme WIRE's `fonts` share
 * ONE grammar — `@ggui-ai/project-config` imports this schema for the
 * document door). `src` MUST be `https:` with a well-formed host; the face is
 * DECLARED, never fetched by any door: the render host unions the origin into
 * its `font-src`, the shell renders the `@font-face` rule, and a face that
 * fails to load in the browser falls back down the family's stack.
 */
export const fontFaceDeclarationSchema = z.strictObject({
  family: z.string().min(1).refine((f) => !/[\r\n]/.test(f), 'family must be one line'),
  src: httpsAssetUrl,
  weight: z.union([z.string().min(1), z.number().int().min(1).max(1000)]).optional(),
  style: z.string().min(1).optional(),
  display: z.string().min(1).optional(),
});
export type FontFaceDeclaration = z.infer<typeof fontFaceDeclarationSchema>;

/** The most faces one theme may declare on the wire — a CSP and a `<style>` block stay bounded. */
export const APP_THEME_FONTS_MAX = 16;

/** The imagery slots a theme may fill (ggui#1093): a brand mark, a hero image, a repeating pattern. */
export const APP_THEME_IMAGERY_KINDS = ['mark', 'hero', 'pattern'] as const;
export type AppThemeImageryKind = (typeof APP_THEME_IMAGERY_KINDS)[number];

/**
 * One image asset: https-only `src` (never fetched by a door), an optional
 * `alt` (≤ 200) and an optional `tone` — the image's own tonality (`light` /
 * `dark`), so a composer can place ink over it without sampling pixels.
 */
export const appThemeImageAssetSchema = z.strictObject({
  src: httpsAssetUrl,
  alt: z.string().max(200).optional(),
  tone: z.enum(['light', 'dark']).optional(),
});
export type AppThemeImageAsset = z.infer<typeof appThemeImageAssetSchema>;

/**
 * The host's imagery, by slot (ggui#1093, #1075 Track C (a)). Parties: a
 * WRITER (an operator's design tooling, or a harvest of the host page) declares; the WRITE door
 * validates this grammar and nothing more; the render host unions every
 * `src` origin into its `img-src`; the composer reads the slots through
 * the design primitives. Absent ⇒ no imagery, today's card.
 */
export const appThemeImagerySchema = z.strictObject({
  mark: appThemeImageAssetSchema.optional(),
  hero: appThemeImageAssetSchema.optional(),
  pattern: appThemeImageAssetSchema.optional(),
});
export type AppThemeImagery = z.infer<typeof appThemeImagerySchema>;

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
    /**
     * Declared font faces (ggui#1093 / #990 — the hosted carrier for the
     * document's `typography.faces`): 1..{@link APP_THEME_FONTS_MAX} faces,
     * each {@link fontFaceDeclarationSchema}. OUTSIDE the attestation:
     * `overlayHash` covers `{ overlays, cssVariables, keyframes }` only
     * (`integrations/overlay-hash.ts`, `OverlayHashInput`) — a face is a
     * declared asset, not a derived projection. A reader on a release that
     * does not name this member strips it at its read door and paints the
     * colours without the faces (`appThemeReadSchema`, VERSION-POLICY §3.6).
     */
    fonts: z.array(fontFaceDeclarationSchema).min(1).max(APP_THEME_FONTS_MAX).optional(),
    /** The host's imagery by slot — {@link appThemeImagerySchema}; outside the attestation, same as `fonts`. */
    imagery: appThemeImagerySchema.optional(),
  })
  .strict();

export type AppTheme = z.infer<typeof appThemeSchema>;

/**
 * The READ-door posture (ggui#1093 belt, 2026-09-15; VERSION-POLICY §3.6).
 *
 * `appThemeSchema` is the WRITE door: strict, an unknown top-level member is
 * refused (`invalid_app_config`). A READ door — a stored row turned into
 * paint, a carried `_meta["ai.ggui/render"].theme` slice — parses with THIS
 * schema instead: an unknown TOP-LEVEL member is stripped, the overlays are
 * kept, and the caller reports what it stripped (one line per read, keys
 * only, never theme content). Everything below the top level is unchanged —
 * nested objects stay strict, token grammar and value safety still refuse,
 * the v1 shape still refuses — and the attestation is untouched because
 * `overlayHash` covers `{ overlays, cssVariables, keyframes }` only.
 *
 * Why: a reader on release N−1 meeting a member release N added would
 * otherwise drop the WHOLE theme — colours and all — until it rolled
 * (guuey#1266's class). Parties: every read door of an `AppTheme` MUST use
 * this variant (or {@link parseAppThemeAtReadDoor}); every write door MUST
 * stay on `appThemeSchema`. Observable violation: a read door dropping a
 * theme whose overlays are valid because of an unknown top-level member —
 * the kit's `n1-compat` forward case grades it.
 */
export const appThemeReadSchema = z.object(appThemeSchema.shape);

export type AppThemeReadDoorResult =
  | { readonly ok: true; readonly theme: AppTheme; readonly stripped: readonly string[] }
  | { readonly ok: false; readonly issues: readonly string[] };

/**
 * Parse a stored or carried theme at a READ door: `ok` with the theme and
 * the top-level members that were stripped (payload order, `[]` when none),
 * or the issues in `path: message` form when the theme is refused for a
 * reason the write door would also refuse.
 */
export function parseAppThemeAtReadDoor(input: unknown): AppThemeReadDoorResult {
  const r = appThemeReadSchema.safeParse(input);
  if (!r.success) {
    return { ok: false, issues: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  }
  const known = new Set(Object.keys(appThemeSchema.shape));
  const stripped =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? Object.keys(input).filter((k) => !known.has(k))
      : [];
  return { ok: true, theme: r.data, stripped };
}

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
