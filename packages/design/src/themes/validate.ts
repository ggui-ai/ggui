/**
 * Consumer contrast validation for DTCG themes.
 *
 * The 8-role `validateTheme` predecessor was deleted 2026-08-22
 * (ggui#598 slice 2): it had zero callers since birth and its
 * successor is `validate-coverage.ts` — the manifest-grounded
 * registration gate. What remains here is the CONSUMER contrast
 * surface (`validateConsumerContrast` + its ratchet pairs), which has
 * live test consumers.
 */

import type { DtcgTheme } from './types';

/**
 * Parse a CSS color value to [r, g, b]. Accepts #rgb/#rrggbb hex and
 * rgb()/rgba() functional notation (several registry themes express
 * outline-family tokens as rgba). Alpha is ignored — the contrast
 * contract is checked against the fully-opaque channel values, which
 * under-reports contrast for translucent foregrounds and therefore
 * fails safe.
 */
function cssColorToRgb(value: string): [number, number, number] | null {
  const fn = value
    .trim()
    .match(/^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)/);
  if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3])];
  return hexToRgb(value.trim());
}

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
 * One foreground/background pairing that first-party consumers
 * actually render, expressed as dot-paths into the DTCG token tree.
 */
export interface ConsumerContrastPair {
  /** Stable identifier used by the ratchet baseline. */
  readonly label: string;
  /** Foreground token path, e.g. `color.primary.700`. */
  readonly fg: string;
  /** Background token path, e.g. `color.primary.100`. */
  readonly bg: string;
  /** Minimum WCAG contrast for this pairing. */
  readonly min: number;
  /** Where the pairing is rendered — the receipt for why it's checked. */
  readonly source: string;
}

/**
 * The pairings first-party components and the color-slot primitives
 * put on screen (verified against source, 2026-08-21 — see ggui#594's
 * measurement matrix). These are the CONSUMER-derived contract the
 * role-pair checks in {@link validateTheme} don't cover: ramp stops
 * used as fills/text and the slot text tokens on the base surface.
 *
 * Thresholds: 4.5:1 for normal text (WCAG AA), 3.0:1 for large
 * glyphs/icons and for the deliberately low-emphasis `subtle` hint
 * tier.
 */
export const CONSUMER_CONTRAST_PAIRS: readonly ConsumerContrastPair[] = [
  {
    label: 'stepper.completed fg700/bg100',
    fg: 'color.primary.700',
    bg: 'color.primary.100',
    min: 3.0,
    source: 'Stepper.tsx completed marker (check icon on tint fill)',
  },
  {
    label: 'stepper.current onPrimary/bg600',
    fg: 'color.onPrimary',
    bg: 'color.primary.600',
    min: 4.5,
    source: 'Stepper.tsx current marker (sm semibold numeral on -600 fill)',
  },
  {
    label: 'stepper.upcoming onSV/surface',
    fg: 'color.onSurfaceVariant',
    bg: 'color.surface',
    min: 4.5,
    source: 'Stepper.tsx upcoming marker',
  },
  {
    label: 'slots.subtle n500/surface',
    fg: 'color.neutral.500',
    bg: 'color.surface',
    min: 3.0,
    source: 'color-slots.ts `subtle` (low-emphasis hint text)',
  },
  {
    label: 'slots.emphasized p700/surface',
    fg: 'color.primary.700',
    bg: 'color.surface',
    min: 4.5,
    source: 'color-slots.ts `emphasized` (accent text)',
  },
  {
    label: 'slots.loud p500/surface',
    fg: 'color.primary.500',
    bg: 'color.surface',
    min: 4.5,
    source: 'color-slots.ts `loud` (CTA label text)',
  },
  {
    label: 'slots.positive s500/surface',
    fg: 'color.success.500',
    bg: 'color.surface',
    min: 4.5,
    source: 'color-slots.ts semantic tone text',
  },
  {
    label: 'slots.negative e500/surface',
    fg: 'color.error.500',
    bg: 'color.surface',
    min: 4.5,
    source: 'color-slots.ts semantic tone text',
  },
  {
    label: 'slots.warning w500/surface',
    fg: 'color.warning.500',
    bg: 'color.surface',
    min: 4.5,
    source: 'color-slots.ts semantic tone text',
  },
];

/** One consumer-contract violation (or unparseable pairing). */
export interface ConsumerContrastViolation {
  readonly label: string;
  /** Measured ratio, or null when a token was absent/unparseable. */
  readonly ratio: number | null;
  readonly min: number;
  readonly fgValue: string | undefined;
  readonly bgValue: string | undefined;
}

function tokenValueAtPath(theme: DtcgTheme, path: string): string | undefined {
  let node: unknown = theme as unknown as Record<string, unknown>;
  for (const seg of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  if (node !== null && typeof node === 'object' && '$value' in node) {
    const v = (node as { $value: unknown }).$value;
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}

/**
 * Check one theme against {@link CONSUMER_CONTRAST_PAIRS}.
 *
 * Sparse ramps are NOT violations: a pairing whose token the theme
 * simply doesn't declare is skipped (consumers fall back through their
 * `var()` defaults; declaring is optional, contradicting a consumer is
 * not). A declared-but-unparseable value IS reported (ratio null) —
 * silence there would hide a broken token.
 *
 * Registry-wide enforcement lives in `contrast-contract.test.ts` as a
 * two-way ratchet against the checked-in baseline (ggui#594): no NEW
 * violations may land, and entries that stop failing must leave the
 * baseline.
 */
export function validateConsumerContrast(
  theme: DtcgTheme,
): ConsumerContrastViolation[] {
  const out: ConsumerContrastViolation[] = [];
  for (const pair of CONSUMER_CONTRAST_PAIRS) {
    const fgValue = tokenValueAtPath(theme, pair.fg);
    const bgValue = tokenValueAtPath(theme, pair.bg);
    if (fgValue === undefined || bgValue === undefined) continue;
    const fgRgb = cssColorToRgb(fgValue);
    const bgRgb = cssColorToRgb(bgValue);
    if (!fgRgb || !bgRgb) {
      out.push({ label: pair.label, ratio: null, min: pair.min, fgValue, bgValue });
      continue;
    }
    const l1 = relativeLuminance(...fgRgb);
    const l2 = relativeLuminance(...bgRgb);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    if (ratio < pair.min) {
      out.push({ label: pair.label, ratio, min: pair.min, fgValue, bgValue });
    }
  }
  return out;
}
