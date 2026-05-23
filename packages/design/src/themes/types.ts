/**
 * DTCG Theme Type System
 *
 * Single canonical theme shape consumed by every `@ggui-ai/design` theme
 * (default light/dark + premium-*). Follows the DTCG (Design Tokens
 * Community Group) format with Material 3 semantic color roles plus
 * Tailwind-style 50-900 scales for primary/neutral/success/warning/
 * error/info, motion tokens (duration/easing/transition/keyframes),
 * accessibility tokens, z-index ladder, and canvas configuration for
 * the GenerativeCanvas background.
 *
 * @see https://design-tokens.github.io/community-group/format/
 */

/**
 * DTCG design token leaf. `$value` carries the value, `$type` is the
 * DTCG type identifier (`color`, `dimension`, `fontFamily`, etc.).
 *
 * @typeParam T - The TypeScript type of the token value (defaults to `string`)
 */
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
  $metadata?: {
    font?: string;
    fontUrl?: string;
    philosophy?: string;
  };

  color: {
    /** 50-900 scale, primary brand color. */
    primary: Record<string, DtcgToken>;
    /** 50-900 scale, neutral/gray foundation. */
    neutral: Record<string, DtcgToken>;
    /** 50-900 scale, success semantic color (greens). */
    success: Record<string, DtcgToken>;
    /** 50-900 scale, warning semantic color (ambers). */
    warning: Record<string, DtcgToken>;
    /** 50-900 scale, error semantic color (reds). */
    error: Record<string, DtcgToken>;
    /** 50-900 scale, info semantic color (cyans/blues). */
    info: Record<string, DtcgToken>;
    // Material 3 semantic role pairs.
    surface: DtcgToken;
    onSurface: DtcgToken;
    surfaceVariant: DtcgToken;
    onSurfaceVariant: DtcgToken;
    container: DtcgToken;
    onContainer: DtcgToken;
    outline: DtcgToken;
    outlineVariant: DtcgToken;
  };

  font: {
    family: {
      sans: DtcgToken;
      mono?: DtcgToken;
    };
    size: Record<string, DtcgToken>;
    weight: Record<string, DtcgToken>;
    lineHeight: Record<string, DtcgToken>;
  };

  spacing: Record<string, DtcgToken>;

  shape: {
    radius: Record<string, DtcgToken>;
    shadow: Record<string, DtcgToken>;
  };

  motion: {
    duration: Record<string, DtcgToken>;
    easing: Record<string, DtcgToken>;
    /**
     * Composed transition shorthands ready for the CSS `transition`
     * property. Each value is a full transition string (e.g.
     * `"200ms cubic-bezier(0.4, 0, 0.2, 1)"` or
     * `"color, background-color 200ms ease-out"`).
     */
    transition: Record<string, DtcgToken>;
    keyframes: Record<string, DtcgToken>;
  };

  canvas: {
    mode: DtcgToken<'wave' | 'flow' | 'mesh' | 'constellation' | 'none'>;
    speed: DtcgToken<number>;
    colors: DtcgToken<string[]>;
    background: DtcgToken;
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
  /** Canvas configuration for GenerativeCanvas component */
  canvasConfig: {
    mode: 'wave' | 'flow' | 'mesh' | 'constellation' | 'none';
    speed: number;
    colors: string[];
    background: string;
  };
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
