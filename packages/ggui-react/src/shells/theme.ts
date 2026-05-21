/**
 * Shared theme utilities for shell components.
 *
 * All shells derive their accent palette from a single `primaryColor` hex prop.
 * These helpers convert hex -> RGB -> derived colors so every shell stays in sync.
 */

/** Default primary accent color (ggui signature violet). */
export const DEFAULT_PRIMARY = '#7c3aed';

/**
 * Convert a 6-character hex color string to an RGB tuple.
 *
 * @param hex - Hex color (e.g., `'#7c3aed'` or `'7c3aed'`)
 * @returns Tuple of `[red, green, blue]` values (0-255)
 */
export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  ];
}

/**
 * Darken an RGB color by a multiplicative factor and return the hex result.
 *
 * @param r - Red channel (0-255)
 * @param g - Green channel (0-255)
 * @param b - Blue channel (0-255)
 * @param factor - Darkening factor (0-1, default 0.78). Lower = darker.
 * @returns Hex color string (e.g., `'#612ebc'`)
 */
export function darkenRgb(r: number, g: number, b: number, factor = 0.78): string {
  return '#' + [r, g, b].map(v => Math.round(v * factor).toString(16).padStart(2, '0')).join('');
}

/**
 * Build a CSS `rgba()` color string from individual channels.
 *
 * @param r - Red channel (0-255)
 * @param g - Green channel (0-255)
 * @param b - Blue channel (0-255)
 * @param a - Alpha channel (0-1)
 * @returns CSS rgba string (e.g., `'rgba(124,58,237,0.5)'`)
 */
export function rgba(r: number, g: number, b: number, a: number): string {
  return `rgba(${r},${g},${b},${a})`;
}

/** Pre-computed theme values derived from a primary color. */
export interface ShellTheme {
  /** RGB channels */
  r: number;
  g: number;
  b: number;
  /** Original hex */
  hex: string;
  /** Darkened variant hex */
  darkHex: string;
}

/**
 * Build a {@link ShellTheme} from a primary hex color.
 *
 * Derives RGB channels and a darkened variant for gradient endpoints.
 *
 * @param primaryColor - Hex color string (defaults to ggui signature violet)
 * @returns Pre-computed theme values for shell rendering
 */
export function buildShellTheme(primaryColor: string = DEFAULT_PRIMARY): ShellTheme {
  const [r, g, b] = hexToRgb(primaryColor);
  return { r, g, b, hex: primaryColor, darkHex: darkenRgb(r, g, b) };
}

/**
 * Build CSS overrides that inject the app's primary color into the
 * generated component's design token `:root` scope.
 *
 * Replaces `--ggui-color-primary-500/600/700` so generated components
 * pick up the app's configured theme color instead of the default.
 *
 * @param hex - Primary color hex (e.g., `'#7c3aed'`)
 * @param darkHex - Darkened variant hex (for the 700 shade)
 * @returns CSS string with `:root` variable overrides
 */
export function buildPrimaryCssOverrides(hex: string, darkHex: string): string {
  return `
:root {
  --ggui-color-primary-500: ${hex};
  --ggui-color-primary-600: ${hex};
  --ggui-color-primary-700: ${darkHex};
}
`;
}

/**
 * Build CSS overrides for dark shell contexts (e.g., ChatShell).
 *
 * In addition to primary color overrides, sets background to transparent,
 * surface to a glass-morphism tint, and text colors to light values
 * suitable for dark backgrounds.
 *
 * @param hex - Primary color hex
 * @param darkHex - Darkened variant hex
 * @returns CSS string with `:root` variable overrides and body rules
 */
export function buildDarkCssOverrides(hex: string, darkHex: string): string {
  return `
:root {
  --ggui-color-neutral-50: transparent;
  --ggui-color-neutral-50: rgba(255,255,255,0.04);
  --ggui-color-neutral-900: #f9fafb;
  --ggui-color-neutral-500: #9ca3af;
  --ggui-color-neutral-300: #4b5563;
  --ggui-color-primary-500: ${hex};
  --ggui-color-primary-600: ${hex};
  --ggui-color-primary-700: ${darkHex};
}
body { background: transparent; color: #f9fafb; }
`;
}
