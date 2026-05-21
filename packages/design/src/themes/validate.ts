/**
 * DTCG Theme Validator
 *
 * Validates that a DtcgTheme has all required semantic color roles
 * and that paired tokens meet WCAG AA contrast requirements.
 */

import type { DtcgTheme, DtcgToken } from './types';

export interface ValidationIssue {
  severity: 'error' | 'warning';
  token: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

/** Required semantic color tokens and their paired foreground/background. */
const SEMANTIC_PAIRS: Array<{ bg: string; fg: string }> = [
  { bg: 'surface', fg: 'onSurface' },
  { bg: 'surfaceVariant', fg: 'onSurfaceVariant' },
  { bg: 'container', fg: 'onContainer' },
];

const SEMANTIC_TOKENS = [
  'surface',
  'onSurface',
  'surfaceVariant',
  'onSurfaceVariant',
  'container',
  'onContainer',
  'outline',
  'outlineVariant',
] as const;

/**
 * Parse a hex color (#rgb or #rrggbb) to [r, g, b] in 0-255 range.
 */
function hexToRgb(hex: string): [number, number, number] | null {
  const m = hex.match(/^#([0-9a-fA-F]{3,8})$/);
  if (!m) return null;
  const h = m[1];
  if (h.length === 3) {
    return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
  }
  if (h.length >= 6) {
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  return null;
}

/**
 * Compute relative luminance per WCAG 2.1.
 */
function relativeLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/**
 * Compute contrast ratio between two colors (WCAG 2.1).
 * Returns a value >= 1.0.
 */
function contrastRatio(hex1: string, hex2: string): number | null {
  const rgb1 = hexToRgb(hex1);
  const rgb2 = hexToRgb(hex2);
  if (!rgb1 || !rgb2) return null;

  const l1 = relativeLuminance(...rgb1);
  const l2 = relativeLuminance(...rgb2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG AA minimum contrast for normal text. */
const WCAG_AA_CONTRAST = 4.5;

/**
 * Validate a DtcgTheme for semantic color role completeness and contrast.
 */
export function validateTheme(theme: DtcgTheme): ValidationResult {
  const issues: ValidationIssue[] = [];

  const colorRecord = theme.color as Record<string, DtcgToken | Record<string, DtcgToken>>;

  // Check all 8 semantic tokens are present
  for (const name of SEMANTIC_TOKENS) {
    const token = colorRecord[name] as DtcgToken | undefined;
    if (!token) {
      issues.push({
        severity: 'error',
        token: `color.${name}`,
        message: `Missing required semantic token "color.${name}"`,
      });
    } else if (!token.$value || typeof token.$value !== 'string') {
      issues.push({
        severity: 'error',
        token: `color.${name}`,
        message: `Token "color.${name}" must have a string $value`,
      });
    } else if (token.$type !== 'color') {
      issues.push({
        severity: 'warning',
        token: `color.${name}`,
        message: `Token "color.${name}" should have $type "color", got "${token.$type}"`,
      });
    }
  }

  // Check contrast ratios for semantic pairs
  for (const { bg, fg } of SEMANTIC_PAIRS) {
    const bgToken = colorRecord[bg] as DtcgToken | undefined;
    const fgToken = colorRecord[fg] as DtcgToken | undefined;
    if (!bgToken?.$value || !fgToken?.$value) continue;

    const ratio = contrastRatio(
      bgToken.$value as string,
      fgToken.$value as string,
    );
    if (ratio === null) {
      issues.push({
        severity: 'warning',
        token: `color.${bg} / color.${fg}`,
        message: `Could not compute contrast ratio (non-hex values)`,
      });
    } else if (ratio < WCAG_AA_CONTRAST) {
      issues.push({
        severity: 'error',
        token: `color.${bg} / color.${fg}`,
        message: `Contrast ratio ${ratio.toFixed(2)}:1 is below WCAG AA minimum (${WCAG_AA_CONTRAST}:1)`,
      });
    }
  }

  return {
    valid: issues.filter((i) => i.severity === 'error').length === 0,
    issues,
  };
}
