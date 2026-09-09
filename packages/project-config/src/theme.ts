/**
 * `ggui.json#theme` → plain DTCG JSON document, v2 (ggui#987).
 *
 * The theme file is a plain JSON document matching the Design Tokens
 * Community Group (DTCG) spec, in the same vocabulary as
 * `@ggui-ai/design`'s canonical {@link DtcgTheme}: the curated registry
 * themes and an authored `theme.json` are the same shape.
 *
 * **What is authored, what is derived.** An author states the six
 * layering roles (`ground`/`onGround`, `container`/`onContainer`,
 * `sunken`/`onSunken`), one `500` anchor per family (`primary`,
 * `success`, `warning`, `error`, `info`), the font families and
 * weights, spacing, radii, shadows. Everything else — the ten-stop
 * ramps, every `on*` ink and container, the neutral ladder, outlines,
 * `elevated`, the type scale from the one `font.ramp` — is DERIVED by
 * the one producer (`deriveThemeVariables`), so the retired ladders
 * (`font.size`, `font.lineHeight`, `motion.duration`, `motion.easing`)
 * and `$metadata.fontUrl` are refused, not ignored. Fonts are declared
 * as `typography.faces` (https `src` only); the card installs them.
 *
 * **External-tool leniency.** `motion`, `accessibility`, `zIndex` and
 * the DTCG metadata fields stay OPTIONAL; {@link normalizeThemeDocument}
 * fills them from the shipped default and flattens the DTCG object
 * forms (structured shadows, transitions, array font stacks) to the CSS
 * strings the producer reads.
 *
 * **Ownership boundary:**
 *
 *   - *Where* the theme lives → `ggui.json#theme` (pointer string).
 *   - *What* the theme file looks like → this module's schema.
 *   - *How* the document becomes CSS variables → `@ggui-ai/design`'s
 *     `deriveThemeVariables` (the loader calls it for both modes).
 *   - *Built-in default* when `theme` is absent → `@ggui-ai/design`'s
 *     shipped `lightTheme` / `darkTheme`.
 *
 * **Extending rules:** additive only within `schema: '1'`; framework-
 * and host-neutral; root and per-group objects are strict — unknown
 * keys fail parse, the same discipline as `ggui.json`.
 */
import { z } from 'zod';
import { lightTheme } from '@ggui-ai/design/themes';
import type { DtcgTheme, DtcgToken } from '@ggui-ai/design/themes';

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

/** A token whose `$value` is a CSS string under any `$type` spelling
 *  (keyframes text, border style, …). */
const StringToken = z.strictObject({
  $type: z.string().min(1),
  $value: z.string().min(1),
  $description: z.string().optional(),
});
/** A declared font face (ggui#987 §5): `src` MUST be `https:` with a
 *  well-formed host — the same rule the design package asserts. */
const FontFaceDeclarationSchema = z.strictObject({
  family: z.string().min(1).refine((f) => !/[\r\n]/.test(f), 'family must be one line'),
  src: z
    .string()
    .min(1)
    .refine((src) => {
      let url: URL;
      try {
        url = new URL(src);
      } catch {
        return false;
      }
      return url.protocol === 'https:' && /^[a-z0-9.-]+$/i.test(url.hostname) && url.hostname.includes('.');
    }, 'src must be an https: URL with a well-formed host'),
  weight: z.union([z.string().min(1), z.number().int().min(1).max(1000)]).optional(),
  style: z.string().min(1).optional(),
  display: z.string().min(1).optional(),
});

// ─── Groups ──────────────────────────────────────────────────────────

/**
 * A "palette" group — a record of color tokens keyed by scale step
 * (`50`, `100`, `200`, …). DTCG allows freeform keys so the record
 * stays open; keys are not enforced at schema level.
 */
const ColorPalette = z.record(z.string(), ColorToken);

/**
 * The colour block: five family anchors (`500` stated; the other stops
 * derived unless stated) + the six layering roles, all REQUIRED; the
 * derived roles (`neutral`, outlines, `on*` inks, containers,
 * `tertiary`, `link`) are optional and win over derivation when stated.
 */
const ColorGroup = z.strictObject({
  primary: ColorPalette,
  neutral: ColorPalette.optional(),
  success: ColorPalette,
  warning: ColorPalette,
  error: ColorPalette,
  info: ColorPalette,
  ground: ColorToken,
  onGround: ColorToken,
  container: ColorToken,
  onContainer: ColorToken,
  sunken: ColorToken,
  onSunken: ColorToken,
  link: ColorToken.optional(),
  outline: ColorToken.optional(),
  outlineVariant: ColorToken.optional(),
  onPrimary: ColorToken.optional(),
  primaryContainer: ColorToken.optional(),
  onPrimaryContainer: ColorToken.optional(),
  onSuccess: ColorToken.optional(),
  successContainer: ColorToken.optional(),
  onSuccessContainer: ColorToken.optional(),
  onWarning: ColorToken.optional(),
  warningContainer: ColorToken.optional(),
  onWarningContainer: ColorToken.optional(),
  onError: ColorToken.optional(),
  errorContainer: ColorToken.optional(),
  onErrorContainer: ColorToken.optional(),
  onInfo: ColorToken.optional(),
  infoContainer: ColorToken.optional(),
  onInfoContainer: ColorToken.optional(),
  tertiary: ColorToken.optional(),
  onTertiary: ColorToken.optional(),
  tertiaryContainer: ColorToken.optional(),
  onTertiaryContainer: ColorToken.optional(),
});

const SpacingGroup = z.record(z.string(), DimensionToken);

/**
 * Font group — `family` (the `sans` slot required; `mono`, `heading`
 * and any other named family optional) and `weight`; optional
 * `letterSpacing` and the ONE `ramp` the type scale is derived from.
 */
/** Font families: `sans` required; `mono`, `heading` and any other named family optional. */
const FontFamilyGroup = z.record(z.string(), FontFamilyToken).and(
  z.object({
    sans: FontFamilyToken,
  }),
);
const FontGroup = z.strictObject({
  family: FontFamilyGroup,
  weight: z.record(z.string(), FontWeightToken),
  letterSpacing: z
    .strictObject({ body: DimensionToken.optional(), heading: DimensionToken.optional() })
    .optional(),
  ramp: z.strictObject({ base: DimensionToken, ratio: NumberToken }).optional(),
});
/** Declared font faces (ggui#987 §5). */
const TypographyGroup = z.strictObject({
  faces: z.array(FontFaceDeclarationSchema).optional(),
});

/**
 * Shape group — `radius` + `shadow`. Moved here from the previous
 * top-level `radius` and `shadow` fields to mirror the internal
 * `DtcgTheme.shape` group.
 */
const ShapeGroup = z.strictObject({
  radius: z.record(z.string(), DimensionToken),
  shadow: z.record(z.string(), ShadowToken),
  border: z.strictObject({ width: DimensionToken.optional(), style: StringToken.optional() }).optional(),
});

/**
 * Motion group — `transition` (required sub-record) + `keyframes`
 * (optional). Durations and easings are not ladders any more: they ride
 * each transition's own value.
 */
const MotionGroup = z.strictObject({
  transition: z.record(z.string(), TransitionToken),
  keyframes: z.record(z.string(), StringToken).optional(),
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
  philosophy: z.string().min(1).optional(),
  /** The embedding host draws the card silhouette; the renderer suppresses root-children strokes. */
  frameless: z.boolean().optional(),
});

// ─── Root document ───────────────────────────────────────────────────

/**
 * Plain DTCG theme document v1. Required groups (`color`, `font`,
 * `spacing`, `shape`) map 1:1 to `@ggui-ai/design`'s
 * `generateCssVariables` walker targets — anything less would mean
 * a partial CSS output worse than falling back to the shipped
 * default. Optional groups (`motion`, `accessibility`,
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
export const ThemeDocumentV2 = z.strictObject({
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

  /** Declared font faces (ggui#987 §5) — https `src` only; the card installs them. */
  typography: TypographyGroup.optional(),

  /** Shape tokens — `radius` + `shadow`. Required. */
  shape: ShapeGroup,

  /** Motion tokens — `duration` + `transition` (required sub-records),
   *  `easing` + `keyframes` (optional sub-records). Optional. */
  motion: MotionGroup.optional(),

  /** Accessibility tokens (focus ring, reduced motion, high contrast).
   *  Optional. */
  accessibility: AccessibilityGroup.optional(),

  /** Z-index scale. Optional. */
  zIndex: ZIndexGroup.optional(),
});

/** Static TypeScript type derived from the v1 schema. */
export type ThemeDocumentV2 = z.infer<typeof ThemeDocumentV2>;

/** Canonical type alias used everywhere else. */
export type ThemeDocument = ThemeDocumentV2;

/**
 * Parse a raw JSON value into a validated {@link ThemeDocument}.
 * Throws a `ZodError` with human-readable issues on invalid input.
 */
export function parseThemeDocument(raw: unknown): ThemeDocument {
  return ThemeDocumentV2.parse(raw);
}

/**
 * Safe-parse variant — returns a discriminated `z.safeParse` result.
 * Prefer this inside CLI tooling where you want to render the issue
 * list without try/catch.
 */
export function safeParseThemeDocument(
  raw: unknown,
): ReturnType<typeof ThemeDocumentV2.safeParse> {
  return ThemeDocumentV2.safeParse(raw);
}

// ─── Normalisation → the producer's document ─────────────────────────

function stringToken<T>(token: { $type: string; $value: T; $description?: string }, value: string): DtcgToken {
  return { $type: token.$type, $value: value, ...(token.$description !== undefined ? { $description: token.$description } : {}) };
}

function mapRecord<In, Out>(record: Readonly<Record<string, In>>, f: (value: In) => Out): Record<string, Out> {
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, f(v)]));
}

/**
 * Turn a parsed document into the EXACT {@link DtcgTheme} the one
 * producer (`deriveThemeVariables`) consumes:
 *
 *   - names the document (`$name` ⇒ `'custom'`, `$description` ⇒ `''`);
 *   - drops the DTCG envelope fields the producer does not read
 *     (`$schema`, `$version`);
 *   - flattens the DTCG object forms to the CSS strings the producer
 *     reads: array font stacks → `'Inter, system-ui'`, numeric weights →
 *     `'400'`, structured shadows → `'0 1px 2px 0 …'`, structured
 *     transitions → `'<property ?? all> <duration> <timingFunction>'`;
 *   - fills the optional groups (`motion`, `accessibility`, `zIndex` and
 *     their sub-records) from the shipped default, so an external tool's
 *     colours-and-dimensions export still derives every consumed token.
 *
 * The authored roles, anchors and faces pass through verbatim.
 */
export function normalizeThemeDocument(doc: ThemeDocument): DtcgTheme {
  const family = doc.font.family;
  const fontFamily = (t: (typeof family)['sans']): DtcgToken =>
    stringToken(t, Array.isArray(t.$value) ? t.$value.join(', ') : t.$value);
  const accessibility = doc.accessibility;
  return {
    $name: doc.$name ?? 'custom',
    $description: doc.$description ?? '',
    ...(doc.$metadata !== undefined ? { $metadata: doc.$metadata } : {}),
    color: doc.color,
    font: {
      family: { ...mapRecord(family, fontFamily), sans: fontFamily(family.sans) },
      weight: mapRecord(doc.font.weight, (t) => stringToken(t, String(t.$value))),
      ...(doc.font.letterSpacing !== undefined ? { letterSpacing: doc.font.letterSpacing } : {}),
      ...(doc.font.ramp !== undefined ? { ramp: doc.font.ramp } : {}),
    },
    ...(doc.typography !== undefined ? { typography: doc.typography } : {}),
    spacing: doc.spacing,
    shape: {
      radius: doc.shape.radius,
      shadow: mapRecord(doc.shape.shadow, (t) =>
        stringToken(
          t,
          typeof t.$value === 'string'
            ? t.$value
            : `${t.$value.offsetX} ${t.$value.offsetY} ${t.$value.blur} ${t.$value.spread} ${t.$value.color}`,
        ),
      ),
      ...(doc.shape.border !== undefined ? { border: doc.shape.border } : {}),
    },
    motion:
      doc.motion === undefined
        ? lightTheme.motion
        : {
            transition: mapRecord(doc.motion.transition, (t) =>
              stringToken(
                t,
                typeof t.$value === 'string'
                  ? t.$value
                  : `${t.$value.property ?? 'all'} ${t.$value.duration} ${t.$value.timingFunction}`,
              ),
            ),
            keyframes: doc.motion.keyframes ?? lightTheme.motion.keyframes,
          },
    accessibility: {
      focusRing: accessibility?.focusRing ?? lightTheme.accessibility.focusRing,
      reducedMotion: accessibility?.reducedMotion ?? lightTheme.accessibility.reducedMotion,
      highContrast: accessibility?.highContrast ?? lightTheme.accessibility.highContrast,
    },
    zIndex: doc.zIndex ?? lightTheme.zIndex,
  };
}
