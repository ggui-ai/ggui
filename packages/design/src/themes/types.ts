/**
 * DTCG Theme Type System
 *
 * Single canonical theme shape consumed by every `@ggui-ai/design` theme
 * (default light/dark + premium-*). Follows the DTCG (Design Tokens
 * Community Group) format with Material 3 semantic color roles plus
 * Tailwind-style 50-900 scales for primary/neutral/success/warning/
 * error/info, motion tokens (duration/easing/transition/keyframes),
 * accessibility tokens, and a z-index ladder.
 *
 * @see https://design-tokens.github.io/community-group/format/
 */

/**
 * DTCG design token leaf. `$value` carries the value, `$type` is the
 * DTCG type identifier (`color`, `dimension`, `fontFamily`, etc.).
 *
 * @typeParam T - The TypeScript type of the token value (defaults to `string`)
 */
/** One declared font face (ggui#987 §5). */
export interface FontFaceDeclaration {
  readonly family: string;
  /** `https:` URL of the face; validated at the document door. */
  readonly src: string;
  readonly weight?: string | number;
  readonly style?: string;
  readonly display?: string;
}

/** One type role of the host's design language (ggui#1093 P1b). */
export interface TypeScaleRole {
  readonly size: DtcgToken;
  readonly weight?: DtcgToken;
  readonly tracking?: DtcgToken;
  /** A RATIO, never a length: the projection writes `line-height: <ratio>`. */
  readonly leading?: DtcgToken<number>;
}

export interface DtcgToken<T = string> {
  $value: T;
  $type: string;
  $description?: string;
}

/**
 * Complete DTCG theme definition.
 *
 * Single shape used by every theme in `@ggui-ai/design`. Replaces the
 * pre-rc.1 split between `BaseDtcgTheme` (default light/dark) and the
 * earlier minimal `DtcgTheme` (premium presets only). All fields are
 * REQUIRED — no optional shape fields, no per-theme schema drift.
 */
export interface DtcgTheme {
  $name: string;
  $description: string;
  /**
   * DTCG-standard extensions bag: vendor-namespaced, arbitrary values
   * by SPEC (foreign namespaces are unknowable, so the open record is
   * the honest type — narrow per-namespace at the consumer). ggui's
   * own namespace: `'ai.ggui.coverage'` — the registration-gate
   * inherit declarations (see `validate-overlay-coverage.ts`).
   */
  $extensions?: Record<string, unknown>;
  $metadata?: {
    font?: string;
    philosophy?: string;
    /**
     * The embedding host draws the card silhouette (a rim / rounded
     * clip mask around the view), so the theme must paint NO border on
     * the document's ROOT layer — a square stroke on the outermost
     * element gets its corners amputated by the host's rounded mask.
     * When true, `getScopedThemeCss` appends a root-children border
     * suppression rule (`.scope > :where(:not(style)) { border: none
     * !important }`). Inner-container strokes are untouched — only the
     * outermost layer is the host's.
     */
    frameless?: boolean;
  };

  color: {
    /** 50-900 scale, primary brand color. */
    primary: Record<string, DtcgToken>;
    /** 50-900 scale, neutral/gray foundation. */
    neutral?: Record<string, DtcgToken>;
    /** 50-900 scale, success semantic color (greens). */
    success: Record<string, DtcgToken>;
    /** 50-900 scale, warning semantic color (ambers). */
    warning: Record<string, DtcgToken>;
    /** 50-900 scale, error semantic color (reds). */
    error: Record<string, DtcgToken>;
    /** 50-900 scale, info semantic color (cyans/blues). */
    info: Record<string, DtcgToken>;
    // Surface-layering roles (ggui#987 §2.1) — one kind of AREA each.
    /** The page / chat canvas behind everything. */
    ground: DtcgToken;
    onGround: DtcgToken;
    /** A card, a bubble, a panel — the unit of content. */
    container: DtcgToken;
    onContainer: DtcgToken;
    /** Wells, inputs at rest, code blocks — recessed inside `container`. */
    sunken: DtcgToken;
    onSunken: DtcgToken;
    // `elevated` / `onElevated` are never authored — derived (§2.4).
    // `heroGround` / `onHeroGround` likewise (ggui#1031 L2): light = the primary container pair, dark = the ink pair.
    // Everything below is OPTIONAL to author: the one producer
    // (`deriveThemeVariables`) derives it from the roles + anchors above
    // — the neutral ladder from ground/onGround, outlines from it, each
    // family's `on*` ink and containers from its `500` anchor, tertiary
    // from primary when absent. A stated value wins over the derived one.
    /**
     * The link colour, per mode. When stated it is emitted as stated;
     * when unstated the derivation aliases `primary-600` (ggui#987 §2.4).
     */
    link?: DtcgToken;
    outline?: DtcgToken;
    outlineVariant?: DtcgToken;
    /** Text / icon color rendered ON a primary surface (CTA buttons, etc.). */
    onPrimary?: DtcgToken;
    /** Softer primary-tinted surface (e.g. selected chips, hover wash). */
    primaryContainer?: DtcgToken;
    /** Text / icon color rendered ON a primaryContainer surface. */
    onPrimaryContainer?: DtcgToken;
    /** Text / icon color rendered ON an error surface (destructive CTAs). */
    onError?: DtcgToken;
    /** Softer error-tinted surface (e.g. inline error banner). */
    errorContainer?: DtcgToken;
    /** Text / icon color rendered ON an errorContainer surface. */
    onErrorContainer?: DtcgToken;
    onSuccess?: DtcgToken;
    successContainer?: DtcgToken;
    onSuccessContainer?: DtcgToken;
    onWarning?: DtcgToken;
    warningContainer?: DtcgToken;
    onWarningContainer?: DtcgToken;
    onInfo?: DtcgToken;
    infoContainer?: DtcgToken;
    onInfoContainer?: DtcgToken;
    /** Accent / complementary role, typically harmonizing with primary. */
    tertiary?: DtcgToken;
    /** Text / icon color rendered ON a tertiary surface. */
    onTertiary?: DtcgToken;
    /** Softer tertiary-tinted surface (e.g. accent callouts). */
    tertiaryContainer?: DtcgToken;
    /** Text / icon color rendered ON a tertiaryContainer surface. */
    onTertiaryContainer?: DtcgToken;
  };

  font: {
    family: {
      sans: DtcgToken;
      mono?: DtcgToken;
      /** Heading family — falls back to `sans` (ggui#987 §2.2). */
      heading?: DtcgToken;
    };
    /** Weights; `heading` optional (default: bold). */
    weight: Record<string, DtcgToken>;
    /** Letter-spacing roles; defaults 0 / −0.01em. */
    letterSpacing?: {
      body?: DtcgToken;
      heading?: DtcgToken;
    };
    /**
     * The one size knob (ggui#987 §2.2): the eight stops are derived by
     * `size(stop) = base × ratio^exp` (xs −2 · sm −1 · base 0 · lg +1 ·
     * xl +2 · 2xl +3 · 3xl +4 · 4xl +5). Absent = the layer-1 ladder.
     */
    ramp?: {
      base: DtcgToken;
      ratio: DtcgToken<number>;
    };
  };
  /**
   * Font-face transport (ggui#987 §5): the faces a theme declares. Each
   * `src` MUST be `https:`; the embedding host admits the origin and
   * hands the rendered `@font-face` rules to the card.
   */
  typography?: {
    faces?: ReadonlyArray<FontFaceDeclaration>;
  };

  /**
   * The host design language's five type ROLES (ggui#1093 P1b): `size`
   * required, `leading` a RATIO (never a length — `line-height: <ratio>`
   * survives a size change). Role-based, beside `font.ramp`'s stop ladder.
   */
  typeScale?: {
    display?: TypeScaleRole;
    h1?: TypeScaleRole;
    h2?: TypeScaleRole;
    body?: TypeScaleRole;
    label?: TypeScaleRole;
  };

  /**
   * The host's spacing rhythm (ggui#1093 P1b): `base` re-derives the scale
   * (px 2–16, or rem/em 0.125–1 at the document door); `section` / `inset`
   * are named steps.
   */
  rhythm?: {
    base: DtcgToken;
    section?: DtcgToken;
    inset?: DtcgToken;
  };

  /**
   * The scrim between the host page's ground and the card (ggui#1093 P1b,
   * ggui#1083). Absent ⇒ derived from the ground pair by the completion.
   *
   * Carried on the wire and validated at the document door. The CARD
   * projection this package ships does not read it yet — inside the card
   * the scrim stays the completion-derived one — while a host's own shell
   * may already paint the member around the card from the same document.
   * This sentence leaves with the card projection that reads it, in the
   * same publication.
   */
  scrim?: {
    tone: 'light' | 'dark' | DtcgToken;
    opacity: DtcgToken<number>;
    blur: DtcgToken;
  };

  spacing: Record<string, DtcgToken>;

  shape: {
    /**
     * The radius ladder's stops (`sm` … `xl`) — and `control`, a ROLE rather than a stop: the
     * radius the host's buttons and fields carry (ggui#1093 harvest half). Absent, the role is the
     * `md` stop; the projector always emits `--ggui-shape-radius-control`.
     */
    radius: Record<string, DtcgToken>;
    shadow: Record<string, DtcgToken>;
    border?: {
      width?: DtcgToken;
      style?: DtcgToken;
    };
  };

  /**
   * Motion — durations and easings are layer-1 (never per app,
   * ggui#987 §2.3); the document carries only composed transitions and
   * keyframes.
   */
  motion: {
    /**
     * Composed transition shorthands ready for the CSS `transition`
     * property. Each value is a full transition string (e.g.
     * `"200ms cubic-bezier(0.4, 0, 0.2, 1)"` or
     * `"color, background-color 200ms ease-out"`).
     */
    transition: Record<string, DtcgToken>;
    keyframes: Record<string, DtcgToken>;
    /**
     * The per-app motion TEMPO OVERRIDE (ggui#1093 P1c). Layer-1 keeps the
     * motion SCALE — the durations and easings the design system ships,
     * which no app redefines wholesale; these three bounded steps are the
     * override a card uses to sit inside someone else's site, exactly the
     * standing `palette` has. Absent ⇒ the shipped scale, unchanged.
     *
     * Carried on the wire and validated at the document door; no projection
     * in this package reads `duration` or `easing` yet — a document may
     * declare them today and the card keeps the shipped scale. This
     * sentence leaves with the projection that reads them, in the same
     * publication.
     */
    duration?: {
      fast?: DtcgToken;
      base?: DtcgToken;
      slow?: DtcgToken;
    };
    /**
     * Easings by intent. The document door validates each value as a CSS
     * keyword, `cubic-bezier(a,b,c,d)` or `steps(n[, position])`, so a
     * projection emits it verbatim and never clamps.
     */
    easing?: {
      standard?: DtcgToken;
      emphasized?: DtcgToken;
      exit?: DtcgToken;
    };
    /**
     * What the composer does under `prefers-reduced-motion: reduce`.
     *
     * Two defaults, stated together so they never read as disagreeing
     * (ggui#1093 P1c): the document door stamps nothing — absent stays
     * absent — and the COMPOSER's default is `respect`, emitting the
     * reduced-motion rule unless a document explicitly says `ignore`.
     *
     * CONTRACTED, NOT YET CONSUMED (ggui#1106): the primitives express
     * motion as build-time constants, so no `--ggui-motion-*` variable
     * exists to project onto and a stated tempo changes nothing visible
     * until that row lands. Declaring it today is correct and stored.
     */
    reduce?: 'respect' | 'ignore';
  };

  /**
   * WCAG-driven accessibility tokens. Operators can override per-theme
   * to tune focus ring contrast, reduced-motion duration, and
   * high-contrast fallback palette.
   */
  accessibility: {
    focusRing: {
      color: DtcgToken;
      width: DtcgToken;
      offset: DtcgToken;
    };
    reducedMotion: {
      duration: DtcgToken;
    };
    highContrast: {
      borderWidth: DtcgToken;
      textColor: DtcgToken;
      backgroundColor: DtcgToken;
      linkColor: DtcgToken;
    };
  };

  /**
   * Z-index ladder. All overlay UI (dropdowns, modals, toasts, etc.)
   * should resolve their stacking context from these tokens to keep
   * the cross-component layering coherent.
   */
  zIndex: Record<string, DtcgToken<number>>;
}

/** Parsed theme output ready for injection */
export interface ParsedTheme {
  id: string;
  name: string;
  description: string;
  metadata?: DtcgTheme['$metadata'];
  /** CSS custom properties string (--ggui-*: value) */
  cssVariables: string;
  /** @keyframes declarations string */
  cssKeyframes: string;
  /** Combined CSS (variables + keyframes) */
  css: string;
}

/**
 * Color mode — light or dark variant of a registered theme.
 *
 * Every theme MUST ship a `light` definition. `dark` is optional during
 * the migration; `getTheme(id, 'dark')` falls back to the light variant
 * when a theme has not yet shipped its dark mode.
 */
export type ThemeMode = 'light' | 'dark';

/**
 * Registry-internal record for a registered theme.
 *
 * Stores both color-mode variants so {@link getTheme} can resolve
 * `(id, mode)` without re-reading from disk. `dark` is optional —
 * themes that haven't been migrated to dual-mode register with
 * `light` only and the registry falls back to it on `'dark'` lookup.
 */
export interface ThemeRegistration {
  readonly light: DtcgTheme;
  readonly dark?: DtcgTheme;
}

/** Theme registry entry (metadata only, for picker UI) */
export interface ThemeEntry {
  id: string;
  name: string;
  description: string;
  metadata?: DtcgTheme['$metadata'];
  /** Color modes the theme ships. Always includes `'light'`. */
  modes: readonly ThemeMode[];
}
