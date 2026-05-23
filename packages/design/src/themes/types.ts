/**
 * DTCG Theme Type System
 *
 * Extended DTCG types for the theme selector system.
 * These types represent the full theme definition including motion tokens,
 * canvas configuration, and metadata for the theme picker UI.
 *
 * Naming: `DtcgTheme` (camelCase) for the new extended system vs
 * `BaseDtcgTheme` (all-caps) for the legacy base token system in dtcg/types.ts.
 */

/**
 * Extended DTCG design token.
 *
 * Simplified variant of {@link DTCGToken} used by the theme selector system.
 * Uses camelCase naming (`DtcgToken`) to distinguish from the legacy
 * all-caps `DTCGToken` in `dtcg/types.ts`.
 *
 * @typeParam T - The TypeScript type of the token value (defaults to `string`)
 */
export interface DtcgToken<T = string> {
  $value: T;
  $type: string;
  $description?: string;
}

/**
 * Complete extended DTCG theme definition for the theme selector system.
 *
 * Extends the base DTCG format with motion tokens (`duration`, `easing`,
 * `keyframes`), canvas configuration for the GenerativeCanvas background,
 * and metadata for the theme picker UI (name, description).
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
    primary: Record<string, DtcgToken>;
    neutral: Record<string, DtcgToken>;
    success: DtcgToken;
    warning: DtcgToken;
    error: DtcgToken;
    info: DtcgToken;
    // Semantic roles (DTCG standard two-tier pattern)
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
    keyframes: Record<string, DtcgToken>;
  };

  canvas: {
    mode: DtcgToken<'wave' | 'flow' | 'mesh' | 'constellation' | 'none'>;
    speed: DtcgToken<number>;
    colors: DtcgToken<string[]>;
    background: DtcgToken;
  };
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
