/**
 * `ggui.json#theme` → plain DTCG JSON document.
 *
 * The theme file is a plain JSON document matching the Design Tokens
 * Community Group (DTCG) spec. It is one of the open file-format
 * surfaces in the ggui manifest model, alongside
 * `ggui.primitives.json` and `ggui.ui.json`.
 *
 * **Shape parity with the internal `DtcgTheme`.** This v1 schema is
 * deliberately the same shape as `@ggui-ai/design`'s canonical
 * {@link DtcgTheme} — `color`/`font`/`spacing`/`shape`/`motion`/
 * `canvas`/`accessibility`/`zIndex` — so an authored `theme.json`
 * uses the same vocabulary the curated registry themes (light/dark/
 * premium-*) use. Previously this schema was Tailwind-style flat
 * (`typography`/`radius`/`shadow` at root); the v1 schema now mirrors
 * the internal shape to remove the divergence.
 *
 * **External-tool compatibility.** External tooling (Figma Tokens,
 * Style Dictionary, Tokens Studio) commonly emits only a subset of
 * the canonical shape. Only the original required groups (`color`,
 * `font`, `spacing`, `shape`) stay required; `motion`, `canvas`,
 * `accessibility`, `zIndex`, and the new DTCG metadata fields
 * (`$name`, `$description`, `$metadata`) are all OPTIONAL so tools
 * that only emit colors + dimensions still parse cleanly.
 *
 * **BREAKING for old `theme.json` files.** Authors who hand-wrote a
 * `theme.json` against the pre-rc schema must rename:
 *
 *   - `typography.fontFamily` → `font.family`
 *   - `typography.fontSize` → `font.size`
 *   - `typography.fontWeight` → `font.weight`
 *   - `typography.lineHeight` → `font.lineHeight`
 *   - top-level `radius` → `shape.radius`
 *   - top-level `shadow` → `shape.shadow`
 *   - top-level `duration` → `motion.duration`
 *   - top-level `transition` → `motion.transition`
 *
 * Plus: under `font.family`, `sans` is the only required sub-token
 * (was previously freeform); other family slots (`mono`, …) are
 * optional. The font-family record itself stays open so additional
 * named families parse without a schema change.
 *
 * **Ownership boundary:**
 *
 *   - *Where* the theme lives → `ggui.json#theme` (pointer string).
 *   - *What* the theme file looks like → this module's schema.
 *   - *How* DTCG tokens become CSS variables → `@ggui-ai/design`'s
 *     `generateCssVariables` (stays over there; this schema does not
 *     emit). The duck-typed walker accepts any DTCG-shaped tree, so
 *     the new nested groups (`font.size`, `shape.radius`, …) walk
 *     into `--ggui-font-size-md`/`--ggui-shape-radius-md` CSS vars
 *     without code changes.
 *   - *Built-in default* when `theme` is absent → `@ggui-ai/design`'s
 *     shipped `lightTheme`.
 *
 * **Extending rules:**
 *
 *   1. Additive only within `schema: '1'`. New optional fields must
 *      default to no-op behaviour so older tooling ignores them.
 *   2. Framework-neutral + host-neutral. No vendor names in enum
 *      values, no build-pipeline fields. (`canvas` IS hosting-
 *      vendor vocabulary; it is opt-in via the optional field.)
 *   3. Root and per-group objects are strict — unknown keys fail
 *      parse. Same discipline as `ggui.json`, `ggui.ui.json`, and
 *      `ggui.primitives.json`.
 *
 * **Strictness tradeoff:**
 *
 * Individual DTCG token leaves are validated with a discriminated
 * union over `$type` (color / dimension / fontFamily / fontWeight /
 * shadow / duration / cubicBezier / transition / number). Each
 * variant validates its `$value` shape. `$description` is accepted
 * everywhere as a free-form docstring. Token leaves under newer
 * groups (`canvas`, `accessibility`, `zIndex`) accept a slightly
 * wider token vocabulary because external tools sometimes encode
 * scalar/array values with permissive `$type` strings (`string`,
 * `array`, …); the schema accepts those without enumerating every
 * possible spelling.
 */
import { z } from 'zod';

// ─── Token leaves ────────────────────────────────────────────────────

/** A CSS color string. `$value` is not structurally validated (hex,
 *  rgba, color-mix, named, etc. are all legal DTCG colors). */
const ColorToken = z.strictObject({
  $type: z.literal('color'),
  $value: z.string().min(1),
  $description: z.string().optional(),
});

/** A CSS dimension string (`"16px"`, `"1rem"`, `"0.5em"`, …). */
const DimensionToken = z.strictObject({
  $type: z.literal('dimension'),
  $value: z.string().min(1),
  $description: z.string().optional(),
});

/** Font family stack. Array-form is canonical (matches how
 *  `generateCssVariables` emits `"Inter", "system-ui"`). String-form
 *  also accepted for single-family leaves. */
const FontFamilyToken = z.strictObject({
  $type: z.literal('fontFamily'),
  $value: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  $description: z.string().optional(),
});

/** Font weight — DTCG allows numeric weight (100..900) or keyword
 *  aliases; the design package's emitter handles both. */
const FontWeightToken = z.strictObject({
  $type: z.literal('fontWeight'),
  $value: z.union([z.number().int().min(1).max(1000), z.string().min(1)]),
  $description: z.string().optional(),
});

/** A CSS duration (`"200ms"`, `"0.3s"`). */
const DurationToken = z.strictObject({
  $type: z.literal('duration'),
  $value: z.string().min(1),
  $description: z.string().optional(),
});

/** DTCG cubic-bezier easing token. `$value` is a CSS timing function
 *  string (`"cubic-bezier(0.4, 0, 0.2, 1)"`, keyword aliases like
 *  `"ease-out"`, etc.). */
const CubicBezierToken = z.strictObject({
  $type: z.literal('cubicBezier'),
  $value: z.string().min(1),
  $description: z.string().optional(),
});

/** Structured shadow value — DTCG spec composite shape. */
const ShadowValue = z.strictObject({
  offsetX: z.string().min(1),
  offsetY: z.string().min(1),
  blur: z.string().min(1),
  spread: z.string().min(1),
  color: z.string().min(1),
});

/** Shadow token — accepts either the structured DTCG composite or a
 *  raw CSS box-shadow string (the curated registry themes ship the
 *  string form, e.g. `"0 1px 2px 0 rgba(0, 0, 0, 0.05)"`). */
const ShadowToken = z.strictObject({
  $type: z.literal('shadow'),
  $value: z.union([z.string().min(1), ShadowValue]),
  $description: z.string().optional(),
});

/** Structured transition value. String-form also accepted because
 *  DTCG spec itself allows a single `property duration timing` line. */
const TransitionValue = z.strictObject({
  duration: z.string().min(1),
  timingFunction: z.string().min(1),
  property: z.string().min(1).optional(),
});

const TransitionToken = z.strictObject({
  $type: z.literal('transition'),
  $value: z.union([z.string().min(1), TransitionValue]),
  $description: z.string().optional(),
});

const NumberToken = z.strictObject({
  $type: z.literal('number'),
  $value: z.number(),
  $description: z.string().optional(),
});

/** Line-height token — DTCG allows unit-less number or dimension. */
const LineHeightToken = z.union([
  z.strictObject({
    $type: z.literal('number'),
    $value: z.number(),
    $description: z.string().optional(),
  }),
  z.strictObject({
    $type: z.literal('dimension'),
    $value: z.string().min(1),
    $description: z.string().optional(),
  }),
]);

/**
 * Permissive token leaf for the newer optional groups (`canvas`,
 * `motion.keyframes`, `zIndex`). DTCG hasn't standardised every
 * `$type` value the curated registry themes carry — for example
 * canvas mode uses `$type: 'string'`, canvas colors uses
 * `$type: 'array'`, easing uses `$type: 'cubicBezier'`. Rather than
 * enumerate every spelling, this leaf accepts any `$type` string and
 * any JSON-serializable `$value`. Strict per-leaf shape stays in
 * force for the original token types via the leaves above.
 */
const PermissiveToken = z.strictObject({
  $type: z.string().min(1),
  $value: z.unknown(),
  $description: z.string().optional(),
});

// ─── Groups ──────────────────────────────────────────────────────────

/**
 * A "palette" group — a record of color tokens keyed by scale step
 * (`50`, `100`, `200`, …). DTCG allows freeform keys so the record
 * stays open; keys are not enforced at schema level.
 */
const ColorPalette = z.record(z.string(), ColorToken);

/**
 * Color group — two-tier: `{palette}` records for scales (primary /
 * neutral / semantic scales) plus single-token semantic roles
 * (surface / onSurface / outline / …) at the top level.
 *
 * Kept open (`z.record` not `z.strictObject`) so authored themes
 * can add brand-specific palettes (`accent`, `brand-green`, …) and
 * semantic roles without a schema change. `color` itself is
 * required but its internal shape is author-extensible.
 *
 * Each entry can be EITHER a singleton `ColorToken` (e.g. a Material
 * role like `surface`) OR a `ColorPalette` (a scale like `primary`'s
 * 50-900 stops). Tools that emit only singleton colors (no scales)
 * stay parseable.
 */
const ColorGroup = z.record(
  z.string(),
  z.union([ColorToken, ColorPalette]),
);

const SpacingGroup = z.record(z.string(), DimensionToken);

/**
 * Font group — `family` / `size` / `weight` / `lineHeight` records.
 * Renamed from `typography` (previously: `typography.fontFamily`,
 * `typography.fontSize`, …) to mirror the internal `DtcgTheme`
 * shape's `font.family` / `font.size` / `font.weight` /
 * `font.lineHeight`.
 *
 * Inside `family`, `sans` is the only required slot — the canonical
 * theme always carries a sans-serif default. `mono` and any other
 * family slot (e.g. `serif`, `display`) are optional. The record
 * stays open so authors can declare additional named families.
 */
const FontFamilyGroup = z.record(z.string(), FontFamilyToken).and(
  z.object({
    sans: FontFamilyToken,
  }),
);

const FontGroup = z.strictObject({
  family: FontFamilyGroup,
  size: z.record(z.string(), DimensionToken),
  weight: z.record(z.string(), FontWeightToken),
  lineHeight: z.record(z.string(), LineHeightToken),
});

/**
 * Shape group — `radius` + `shadow`. Moved here from the previous
 * top-level `radius` and `shadow` fields to mirror the internal
 * `DtcgTheme.shape` group.
 */
const ShapeGroup = z.strictObject({
  radius: z.record(z.string(), DimensionToken),
  shadow: z.record(z.string(), ShadowToken),
});

/**
 * Motion group — `duration` / `easing` / `transition` / `keyframes`.
 * Moved here from the previous top-level `duration` and `transition`
 * fields. `easing` and `keyframes` are optional because external
 * tools (Figma Tokens, Style Dictionary) don't always emit them.
 */
const MotionGroup = z.strictObject({
  duration: z.record(z.string(), DurationToken),
  easing: z.record(z.string(), CubicBezierToken).optional(),
  transition: z.record(z.string(), TransitionToken),
  keyframes: z.record(z.string(), PermissiveToken).optional(),
});

/**
 * Canvas group — GenerativeCanvas background configuration.
 * Optional at the document root (external tools won't emit this).
 * Token leaves use `PermissiveToken` because the canonical shape
 * mixes `$type: 'string'` (mode), `$type: 'number'` (speed),
 * `$type: 'array'` (colors), `$type: 'color'` (background).
 */
const CanvasGroup = z.strictObject({
  mode: PermissiveToken,
  speed: PermissiveToken,
  colors: PermissiveToken,
  background: PermissiveToken,
});

const AccessibilityGroup = z.strictObject({
  focusRing: z
    .strictObject({
      color: ColorToken,
      width: DimensionToken,
      offset: DimensionToken,
    })
    .optional(),
  reducedMotion: z
    .strictObject({
      duration: DurationToken,
    })
    .optional(),
  highContrast: z
    .strictObject({
      borderWidth: DimensionToken,
      textColor: ColorToken,
      backgroundColor: ColorToken,
      linkColor: ColorToken,
    })
    .optional(),
});

const ZIndexGroup = z.record(z.string(), NumberToken);

/**
 * Optional `$metadata` bag — mirrors the internal
 * `DtcgTheme.$metadata` shape so registry themes can round-trip
 * through the file format without information loss.
 */
const MetadataGroup = z.strictObject({
  font: z.string().min(1).optional(),
  fontUrl: z.string().min(1).optional(),
  philosophy: z.string().min(1).optional(),
});

// ─── Root document ───────────────────────────────────────────────────

/**
 * Plain DTCG theme document v1. Required groups (`color`, `font`,
 * `spacing`, `shape`) map 1:1 to `@ggui-ai/design`'s
 * `generateCssVariables` walker targets — anything less would mean
 * a partial CSS output worse than falling back to the shipped
 * default. Optional groups (`motion`, `canvas`, `accessibility`,
 * `zIndex`) are the well-known DTCG additives; present → emitted,
 * absent → the design system's built-in fallbacks apply.
 *
 * `$name`, `$description`, and `$metadata` are accepted as optional
 * DTCG-standard metadata. They round-trip cleanly to/from the
 * internal `DtcgTheme` shape but external tools don't always emit
 * them.
 *
 * Strict root: unknown top-level keys fail parse. `$schema`,
 * `$version`, `$name`, `$description`, `$metadata` are all
 * allow-listed (DTCG metadata); anything else is a typo. Additive
 * slices add new fields here under `schema: '1'`.
 */
export const ThemeDocumentV1 = z.strictObject({
  /** Optional DTCG spec URL. Not validated — the spec hasn't frozen
   *  a canonical URL and hand-authored themes often omit it. */
  $schema: z.string().min(1).optional(),

  /** Optional author-declared version. Not validated — string-form. */
  $version: z.string().min(1).optional(),

  /** Optional human-readable theme name. DTCG metadata; mirrors
   *  `DtcgTheme.$name`. */
  $name: z.string().min(1).optional(),

  /** Optional human-readable theme description. DTCG metadata;
   *  mirrors `DtcgTheme.$description`. */
  $description: z.string().min(1).optional(),

  /** Optional metadata bag — font fallback, hosting-philosophy notes,
   *  etc. Mirrors `DtcgTheme.$metadata`. */
  $metadata: MetadataGroup.optional(),

  /** Color tokens — palettes + semantic roles. Required. */
  color: ColorGroup,

  /** Spacing scale. Required. */
  spacing: SpacingGroup,

  /** Font tokens — `family` / `size` / `weight` / `lineHeight`. Required. */
  font: FontGroup,

  /** Shape tokens — `radius` + `shadow`. Required. */
  shape: ShapeGroup,

  /** Motion tokens — `duration` + `transition` (required sub-records),
   *  `easing` + `keyframes` (optional sub-records). Optional. */
  motion: MotionGroup.optional(),

  /** Canvas configuration for the GenerativeCanvas background.
   *  Optional — external tools won't emit this. */
  canvas: CanvasGroup.optional(),

  /** Accessibility tokens (focus ring, reduced motion, high contrast).
   *  Optional. */
  accessibility: AccessibilityGroup.optional(),

  /** Z-index scale. Optional. */
  zIndex: ZIndexGroup.optional(),
});

/** Static TypeScript type derived from the v1 schema. */
export type ThemeDocumentV1 = z.infer<typeof ThemeDocumentV1>;

/** Canonical type alias used everywhere else. */
export type ThemeDocument = ThemeDocumentV1;

/**
 * Parse a raw JSON value into a validated {@link ThemeDocument}.
 * Throws a `ZodError` with human-readable issues on invalid input.
 */
export function parseThemeDocument(raw: unknown): ThemeDocument {
  return ThemeDocumentV1.parse(raw);
}

/**
 * Safe-parse variant — returns a discriminated `z.safeParse` result.
 * Prefer this inside CLI tooling where you want to render the issue
 * list without try/catch.
 */
export function safeParseThemeDocument(
  raw: unknown,
): ReturnType<typeof ThemeDocumentV1.safeParse> {
  return ThemeDocumentV1.safeParse(raw);
}
