/**
 * `ggui.json#theme` → plain DTCG JSON document.
 *
 * The theme file is a plain JSON document matching the Design Tokens
 * Community Group (DTCG) spec. It is one of the open file-format
 * surfaces in the ggui manifest model, alongside
 * `ggui.primitives.json` and `ggui.ui.json`.
 *
 * **Why plain DTCG** (not the extended `DtcgTheme` shape that the ggui
 * Studio's curated picker uses): plain DTCG is what external tooling
 * already emits (Figma Tokens, Style Dictionary, Tokens Studio). The
 * extended shape carries hosting-vendor-specific vocabulary (`$category:
 * 'signature' | 'premium'`, `canvas.*`) — keeping it out of the open
 * `ggui.json#theme` contract is what makes the theme file
 * hosting-neutral.
 *
 * **Ownership boundary:**
 *
 *   - *Where* the theme lives → `ggui.json#theme` (pointer string).
 *   - *What* the theme file looks like → this module's schema.
 *   - *How* DTCG tokens become CSS variables → `@ggui-ai/design`'s
 *     `generateCssVariables` (stays over there; this schema does not
 *     emit).
 *   - *Built-in default* when `theme` is absent → `@ggui-ai/design`'s
 *     shipped `lightTheme`.
 *
 * **Extending rules:**
 *
 *   1. Additive only within `schema: '1'`. New optional fields must
 *      default to no-op behaviour so older tooling ignores them.
 *   2. Framework-neutral + host-neutral. No vendor names in enum
 *      values, no build-pipeline fields, no hosting-only shapes.
 *   3. Root and per-group objects are strict — unknown keys fail
 *      parse. Same discipline as `ggui.json`, `ggui.ui.json`, and
 *      `ggui.primitives.json`.
 *
 * **Strictness tradeoff:**
 *
 * Individual DTCG token leaves are validated with a discriminated
 * union over `$type` (color / dimension / fontFamily / fontWeight /
 * shadow / duration / transition / number / typography). Each
 * variant validates its `$value` shape. `$description` is accepted
 * everywhere as a free-form docstring. Unknown `$type` values are
 * rejected — DTCG's own list is short and stable, and rejecting
 * typos at parse is more valuable than allowing forward-compat
 * unknowns (which would render as broken CSS anyway).
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

/** Structured shadow value — matches `@ggui-ai/design`'s internal
 *  emitter expectations. String form kept out on purpose: the
 *  structured form is the DTCG spec shape. */
const ShadowValue = z.strictObject({
  offsetX: z.string().min(1),
  offsetY: z.string().min(1),
  blur: z.string().min(1),
  spread: z.string().min(1),
  color: z.string().min(1),
});

const ShadowToken = z.strictObject({
  $type: z.literal('shadow'),
  $value: ShadowValue,
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

// DTCG also spec'd a composite `typography` token type, but this v1
// schema doesn't accept it — authored themes compose
// `fontFamily`/`fontSize`/`fontWeight`/`lineHeight` leaves under the
// `typography` group (see `TypographyGroup` below). When a real
// consumer needs composite typography tokens, they land as an
// additive `$type: 'typography'` variant under `schema: '1'`.

// Note: the schema does not expose a single "any token" union today —
// each group validates its own token type explicitly. Rejecting
// unknown `$type` values happens implicitly because each group's
// token schema is a strict object over its specific `$type` literal.

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
 * Kept open (`z.object` not `z.strictObject`) so authored themes
 * can add brand-specific palettes (`accent`, `brand-green`, …) and
 * semantic roles without a schema change. `color` itself is
 * required but its internal shape is author-extensible.
 */
const ColorGroup = z.record(
  z.string(),
  z.union([ColorToken, ColorPalette]),
);

const SpacingGroup = z.record(z.string(), DimensionToken);

const TypographyGroup = z.strictObject({
  fontFamily: z.record(z.string(), FontFamilyToken),
  fontSize: z.record(z.string(), DimensionToken),
  fontWeight: z.record(z.string(), FontWeightToken),
  lineHeight: z.record(
    z.string(),
    z.union([
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
    ]),
  ),
});

const RadiusGroup = z.record(z.string(), DimensionToken);
const ShadowGroup = z.record(z.string(), ShadowToken);
const DurationGroup = z.record(z.string(), DurationToken);
const TransitionGroup = z.record(z.string(), TransitionToken);
const ZIndexGroup = z.record(z.string(), NumberToken);

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

// ─── Root document ───────────────────────────────────────────────────

/**
 * Plain DTCG theme document v1. Required groups (`color`, `spacing`,
 * `typography`, `radius`, `shadow`) map 1:1 to
 * `@ggui-ai/design`'s `generateCssVariables` walker targets —
 * anything less would mean a partial CSS output worse than falling
 * back to the shipped default. Optional groups (`duration`,
 * `transition`, `zIndex`, `accessibility`) are the well-known DTCG
 * additives; present → emitted, absent → the design system's
 * built-in fallbacks apply.
 *
 * Strict root: unknown top-level keys fail parse. `$schema` and
 * `$version` are allow-listed (DTCG metadata); anything else is a
 * typo. Additive slices add new fields here under `schema: '1'`.
 */
export const ThemeDocumentV1 = z.strictObject({
  /** Optional DTCG spec URL. Not validated — the spec hasn't frozen
   *  a canonical URL and hand-authored themes often omit it. */
  $schema: z.string().min(1).optional(),

  /** Optional author-declared version. Not validated — string-form. */
  $version: z.string().min(1).optional(),

  /** Color tokens — palettes + semantic roles. Required. */
  color: ColorGroup,

  /** Spacing scale. Required. */
  spacing: SpacingGroup,

  /** Typography — required shape (`fontFamily` + `fontSize` +
   *  `fontWeight` + `lineHeight` sub-records). */
  typography: TypographyGroup,

  /** Border-radius scale. Required. */
  radius: RadiusGroup,

  /** Shadow scale. Required. */
  shadow: ShadowGroup,

  /** Duration tokens (animation / transition primitives). Optional. */
  duration: DurationGroup.optional(),

  /** Transition composites. Optional. */
  transition: TransitionGroup.optional(),

  /** Z-index scale. Optional. */
  zIndex: ZIndexGroup.optional(),

  /** Accessibility tokens (focus ring, reduced motion, high contrast).
   *  Optional. */
  accessibility: AccessibilityGroup.optional(),
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
