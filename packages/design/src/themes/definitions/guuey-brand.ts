/**
 * guuey-brand-v1 — the guuey product brand as a FULL theme (ggui#589
 * ask 3). Registered under the EXACT `AppTheme.name` the guuey widget
 * stamps on its render envelopes (`guuey-brand-v1`), so the runtime's
 * theme-name→registry binding selects this as the BASE token ladder
 * with no sender-side change. The slice's own cssVariables overlay
 * still applies ABOVE this base (the #573 order), so a future brand
 * rev can override any slot without waiting for a registry release.
 *
 * Palette source: the guuey portal's product tokens (supplied verbatim
 * on ggui#589 — surface/sunken/elevated family, slime #B8FF3A accent,
 * DM Sans / JetBrains Mono, 12px card radius, slime focus ring).
 *
 * Brand rules encoded here:
 *   - **success IS slime** (#B8FF3A), never green — the rejected
 *     store-frame pixel. `onPrimary`-style dark ink (#0E1014) carries
 *     text on slime fills.
 *   - Ramps follow the dark-mode inverted convention (50 darkest →
 *     800/900 lightest, brand value pinned at 500) so the REAL
 *     consumers — the -500/-600/-700 stops (hover/pressed CTA states)
 *     — resolve brand, with the portal's #CCFF66 as the lifted hover
 *     stop.
 *   - `secondary` purple (#9B6AFF) has no DtcgTheme slot; the pink
 *     accent (#FF4FB0) rides `tertiary` per the portal's own naming.
 *
 * The LIGHT variant is a provisional derivation from the same accents
 * (portal's light pair ships on request; dark is the gating mode) —
 * serviceable for light hosts, expected to be replaced by portal
 * values in a follow-up rev of this file, same id.
 */

import type { DtcgTheme } from '../types';
import { standardZIndex } from './_shared';

// ── shared (mode-agnostic) tokens ──────────────────────────────────
const shared = {
  font: {
    family: {
      sans: {
        $value: '"DM Sans", system-ui, -apple-system, sans-serif',
        $type: 'fontFamily',
      },
      mono: {
        $value: '"JetBrains Mono", ui-monospace, monospace',
        $type: 'fontFamily',
      },
    },
    size: {
      sm: { $value: '0.875rem', $type: 'dimension' },
      base: { $value: '1rem', $type: 'dimension' },
      lg: { $value: '1.125rem', $type: 'dimension' },
      xl: { $value: '1.25rem', $type: 'dimension' },
      '2xl': { $value: '1.5rem', $type: 'dimension' },
    },
    weight: {
      normal: { $value: '400', $type: 'fontWeight' },
      medium: { $value: '500', $type: 'fontWeight' },
      semibold: { $value: '600', $type: 'fontWeight' },
      bold: { $value: '700', $type: 'fontWeight' },
    },
    lineHeight: {
      tight: { $value: '1.25', $type: 'number' },
      normal: { $value: '1.5', $type: 'number' },
      relaxed: { $value: '1.75', $type: 'number' },
    },
  },

  spacing: {
    '1': { $value: '0.25rem', $type: 'dimension' },
    '2': { $value: '0.5rem', $type: 'dimension' },
    '3': { $value: '0.75rem', $type: 'dimension' },
    '4': { $value: '1rem', $type: 'dimension' },
    '5': { $value: '1.25rem', $type: 'dimension' },
    '6': { $value: '1.5rem', $type: 'dimension' },
    '8': { $value: '2rem', $type: 'dimension' },
    '10': { $value: '2.5rem', $type: 'dimension' },
    '12': { $value: '3rem', $type: 'dimension' },
  },

  // NOTE: `shape` is per-mode (round 4) — radius is shared via
  // `sharedRadius` below, but shadows split: dark wants near-none ink
  // (a visible black blob under a card on a dark surface was the
  // round-3 "borders looking ugly" residual's shadow half), light
  // wants classic soft grey.

  motion: {
    duration: {
      fast: { $value: '120ms', $type: 'duration' },
      normal: { $value: '200ms', $type: 'duration' },
      slow: { $value: '400ms', $type: 'duration' },
      ambient: { $value: '2000ms', $type: 'duration' },
    },
    easing: {
      default: { $value: 'cubic-bezier(0.4, 0, 0.2, 1)', $type: 'cubicBezier' },
      bounce: {
        $value: 'cubic-bezier(0.68, -0.55, 0.27, 1.55)',
        $type: 'cubicBezier',
      },
      spring: { $value: 'cubic-bezier(0.22, 1, 0.36, 1)', $type: 'cubicBezier' },
    },
    transition: {
      fast: { $value: '120ms cubic-bezier(0.4, 0, 0.2, 1)', $type: 'transition' },
      normal: { $value: '200ms cubic-bezier(0.4, 0, 0.2, 1)', $type: 'transition' },
      slow: { $value: '400ms cubic-bezier(0.4, 0, 0.2, 1)', $type: 'transition' },
      colors: {
        $value:
          'color 200ms cubic-bezier(0.4, 0, 0.2, 1), background-color 200ms cubic-bezier(0.4, 0, 0.2, 1), border-color 200ms cubic-bezier(0.4, 0, 0.2, 1)',
        $type: 'transition',
      },
      opacity: { $value: 'opacity 200ms cubic-bezier(0.4, 0, 0.2, 1)', $type: 'transition' },
      transform: { $value: 'transform 200ms cubic-bezier(0.22, 1, 0.36, 1)', $type: 'transition' },
    },
    keyframes: {
      'fade-in': {
        $value: '0%{opacity:0}100%{opacity:1}',
        $type: 'keyframes',
      },
      'slide-up': {
        $value: '0%{opacity:0;transform:translateY(8px)}100%{opacity:1;transform:translateY(0)}',
        $type: 'keyframes',
      },
      'pulse-soft': {
        $value: '0%{opacity:1}50%{opacity:0.65}100%{opacity:1}',
        $type: 'keyframes',
      },
    },
  },

  accessibility: {
    focusRing: {
      color: { $value: '#B8FF3A', $type: 'color' },
      width: { $value: '2px', $type: 'dimension' },
      offset: { $value: '2px', $type: 'dimension' },
    },
    reducedMotion: {
      duration: { $value: '0ms', $type: 'duration' },
    },
    highContrast: {
      borderWidth: { $value: '2px', $type: 'dimension' },
      textColor: { $value: '#FFFFFF', $type: 'color' },
      backgroundColor: { $value: '#000000', $type: 'color' },
      linkColor: { $value: '#CCFF66', $type: 'color' },
    },
  },

  zIndex: standardZIndex,
} as const;

/** 12px cards = the portal's stated radius rule → `lg` (0.75rem). */
const sharedRadius = {
  sm: { $value: '0.375rem', $type: 'dimension' },
  md: { $value: '0.5rem', $type: 'dimension' },
  lg: { $value: '0.75rem', $type: 'dimension' },
  xl: { $value: '1rem', $type: 'dimension' },
  full: { $value: '9999px', $type: 'dimension' },
} as const;

/**
 * Dark elevation = near-none ink (round 4). Elevation on the slate
 * surfaces reads through the surface-step ladder (sunken → surface →
 * elevated), not through drop shadows — a black blob under a card on
 * #1A1D24 was exactly the rejected look.
 */
const darkShadows = {
  sm: { $value: '0 1px 2px rgba(0, 0, 0, 0.2)', $type: 'shadow' },
  md: { $value: '0 2px 8px rgba(0, 0, 0, 0.25)', $type: 'shadow' },
  lg: { $value: '0 6px 16px rgba(0, 0, 0, 0.28)', $type: 'shadow' },
  xl: { $value: '0 10px 24px rgba(0, 0, 0, 0.3)', $type: 'shadow' },
} as const;

/** Light elevation = classic soft ink-tinted grey. */
const lightShadows = {
  sm: { $value: '0 1px 2px rgba(26, 29, 36, 0.06)', $type: 'shadow' },
  md: { $value: '0 2px 8px rgba(26, 29, 36, 0.08)', $type: 'shadow' },
  lg: { $value: '0 6px 16px rgba(26, 29, 36, 0.1)', $type: 'shadow' },
  xl: { $value: '0 12px 28px rgba(26, 29, 36, 0.12)', $type: 'shadow' },
} as const;

// ── guuey brand — Dark (the gating variant) ────────────────────────
const guueyBrandDark: DtcgTheme = {
  $name: 'guuey-brand-v1',
  $description:
    'The guuey product brand (dark) — slate-ink surfaces, slime #B8FF3A accent, DM Sans.',
  $metadata: {
    font: 'DM Sans',
    fontUrl:
      'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap',
    philosophy: 'Agent-native. Slime on slate.',
    // Round 5 (founder-ruled): the guuey host clips the view with its
    // own rounded rim — the HOST owns the card silhouette; the theme
    // paints no border on the root layer. Inner hairlines stay.
    frameless: true,
  },

  color: {
    // Inverted dark ladder — 50 darkest, 900 lightest; slime pinned at
    // 500, the portal's lifted #CCFF66 at the hover stop (600).
    primary: {
      '50': { $value: '#141D05', $type: 'color' },
      '100': { $value: '#28390B', $type: 'color' },
      '200': { $value: '#3F5A11', $type: 'color' },
      '300': { $value: '#5F8719', $type: 'color' },
      '400': { $value: '#8CC627', $type: 'color' },
      '500': { $value: '#B8FF3A', $type: 'color' }, // slime (brand)
      '600': { $value: '#CCFF66', $type: 'color' }, // lifted hover (portal)
      '700': { $value: '#DBFF8F', $type: 'color' }, // pressed / emphasized
      '800': { $value: '#E9FFB8', $type: 'color' },
      '900': { $value: '#F6FFE0', $type: 'color' },
    },
    // Slate-ink foundation from the portal surface family: sunken →
    // surface → elevated → surfaceVariant, then up through the greys
    // to paper (#F6F5EE).
    neutral: {
      '50': { $value: '#0E1014', $type: 'color' }, // sunken
      '100': { $value: '#1A1D24', $type: 'color' }, // surface
      '200': { $value: '#232630', $type: 'color' }, // elevated
      '300': { $value: '#242938', $type: 'color' }, // surfaceVariant
      '400': { $value: '#3B4152', $type: 'color' },
      '500': { $value: '#878C99', $type: 'color' }, // hint text
      '600': { $value: '#B7BAC4', $type: 'color' }, // secondary text
      '700': { $value: '#D5D6DC', $type: 'color' },
      '800': { $value: '#E8E7E2', $type: 'color' },
      '900': { $value: '#F6F5EE', $type: 'color' }, // paper (text)
    },
    // BRAND RULE: success IS slime — never green. Same family as
    // primary so an "Available" pill and a slime CTA read as one brand.
    success: {
      '50': { $value: '#141D05', $type: 'color' },
      '100': { $value: '#28390B', $type: 'color' },
      '200': { $value: '#3F5A11', $type: 'color' },
      '500': { $value: '#B8FF3A', $type: 'color' }, // slime (brand rule)
      '600': { $value: '#CCFF66', $type: 'color' },
      '700': { $value: '#DBFF8F', $type: 'color' },
      '800': { $value: '#E9FFB8', $type: 'color' },
    },
    warning: {
      '50': { $value: '#33240A', $type: 'color' },
      '100': { $value: '#5C420F', $type: 'color' },
      '200': { $value: '#8A6318', $type: 'color' },
      '500': { $value: '#FFB020', $type: 'color' }, // portal warning
      '600': { $value: '#FFC24D', $type: 'color' },
      '700': { $value: '#FFD37D', $type: 'color' },
      '800': { $value: '#FFE5AE', $type: 'color' },
    },
    error: {
      '50': { $value: '#33110E', $type: 'color' },
      '100': { $value: '#5E1F1B', $type: 'color' },
      '200': { $value: '#8F2F2A', $type: 'color' },
      '500': { $value: '#FF5B5B', $type: 'color' }, // portal error
      '600': { $value: '#FF7D7A', $type: 'color' },
      '700': { $value: '#FF9F9C', $type: 'color' },
      '800': { $value: '#FFC3C0', $type: 'color' },
    },
    info: {
      '50': { $value: '#0A2733', $type: 'color' },
      '100': { $value: '#12455C', $type: 'color' },
      '200': { $value: '#1E6A8A', $type: 'color' },
      '500': { $value: '#3AC8FF', $type: 'color' }, // portal info
      '600': { $value: '#66D4FF', $type: 'color' },
      '700': { $value: '#92E0FF', $type: 'color' },
      '800': { $value: '#BFECFF', $type: 'color' },
    },
    // M3 roles — portal values verbatim.
    surface: { $value: '#1A1D24', $type: 'color' },
    onSurface: { $value: '#F6F5EE', $type: 'color' },
    surfaceVariant: { $value: '#242938', $type: 'color' },
    onSurfaceVariant: { $value: '#B7BAC4', $type: 'color' },
    container: { $value: '#232630', $type: 'color' }, // elevated
    onContainer: { $value: '#F6F5EE', $type: 'color' },
    // Round 4 (portal stops): .14 IS the base hairline; .18 is the
    // STRONG stop (no DtcgTheme slot — strong/interactive strokes
    // ride primary borders + the slime focusRing, receipted by the
    // Select button). Dividers sit softer still.
    outline: { $value: 'rgba(246, 245, 238, 0.14)', $type: 'color' },
    outlineVariant: { $value: 'rgba(246, 245, 238, 0.1)', $type: 'color' },
    onPrimary: { $value: '#0E1014', $type: 'color' }, // ink on slime
    primaryContainer: { $value: '#242938', $type: 'color' }, // portal
    onPrimaryContainer: { $value: '#CCFF66', $type: 'color' }, // portal
    onError: { $value: '#33110E', $type: 'color' },
    errorContainer: { $value: '#5E1F1B', $type: 'color' },
    onErrorContainer: { $value: '#FFC3C0', $type: 'color' },
    // Pink accent — the portal's tertiary. (Purple #9B6AFF has no
    // DtcgTheme slot; see the file docstring.)
    tertiary: { $value: '#FF4FB0', $type: 'color' },
    onTertiary: { $value: '#0E1014', $type: 'color' },
    tertiaryContainer: { $value: '#451A35', $type: 'color' },
    onTertiaryContainer: { $value: '#FFC1E4', $type: 'color' },
  },

  ...shared,
  shape: { radius: sharedRadius, shadow: darkShadows },
};

// ── guuey brand — Light (provisional derivation) ───────────────────
const guueyBrandLight: DtcgTheme = {
  $name: 'guuey-brand-v1',
  $description:
    'The guuey product brand (light, provisional) — paper surfaces, slime accent held for fills, darkened slime for text emphasis.',
  $metadata: guueyBrandDark.$metadata,

  color: {
    // Normal (non-inverted) ramps; slime stays the 500 fill anchor,
    // text-emphasis stops (600/700) darken for contrast on paper.
    primary: {
      '50': { $value: '#F6FFE0', $type: 'color' },
      '100': { $value: '#E9FFB8', $type: 'color' },
      '200': { $value: '#DBFF8F', $type: 'color' },
      '300': { $value: '#CCFF66', $type: 'color' },
      '400': { $value: '#B8FF3A', $type: 'color' },
      '500': { $value: '#9FE01C', $type: 'color' },
      '600': { $value: '#7DB214', $type: 'color' },
      '700': { $value: '#5C850D', $type: 'color' },
      '800': { $value: '#3F5A11', $type: 'color' },
      '900': { $value: '#28390B', $type: 'color' },
    },
    neutral: {
      '50': { $value: '#FBFAF6', $type: 'color' },
      '100': { $value: '#F6F5EE', $type: 'color' },
      '200': { $value: '#E8E7E2', $type: 'color' },
      '300': { $value: '#D5D6DC', $type: 'color' },
      '400': { $value: '#B7BAC4', $type: 'color' },
      '500': { $value: '#6E7380', $type: 'color' },
      '600': { $value: '#4A4F5C', $type: 'color' },
      '700': { $value: '#333846', $type: 'color' },
      '800': { $value: '#242938', $type: 'color' },
      '900': { $value: '#1A1D24', $type: 'color' },
    },
    success: {
      '50': { $value: '#F6FFE0', $type: 'color' },
      '100': { $value: '#E9FFB8', $type: 'color' },
      '200': { $value: '#DBFF8F', $type: 'color' },
      '500': { $value: '#7DB214', $type: 'color' },
      '600': { $value: '#5C850D', $type: 'color' },
      '700': { $value: '#476809', $type: 'color' },
      '800': { $value: '#28390B', $type: 'color' },
    },
    warning: {
      '50': { $value: '#FFF4DD', $type: 'color' },
      '100': { $value: '#FFE5AE', $type: 'color' },
      '200': { $value: '#FFD37D', $type: 'color' },
      '500': { $value: '#D98A0A', $type: 'color' },
      '600': { $value: '#A96A06', $type: 'color' },
      '700': { $value: '#7C4D04', $type: 'color' },
      '800': { $value: '#523203', $type: 'color' },
    },
    error: {
      '50': { $value: '#FFE9E8', $type: 'color' },
      '100': { $value: '#FFC3C0', $type: 'color' },
      '200': { $value: '#FF9F9C', $type: 'color' },
      '500': { $value: '#E23B3B', $type: 'color' },
      '600': { $value: '#B62C2C', $type: 'color' },
      '700': { $value: '#8A1F1F', $type: 'color' },
      '800': { $value: '#5E1F1B', $type: 'color' },
    },
    info: {
      '50': { $value: '#E5F7FF', $type: 'color' },
      '100': { $value: '#BFECFF', $type: 'color' },
      '200': { $value: '#92E0FF', $type: 'color' },
      '500': { $value: '#0E93C9', $type: 'color' },
      '600': { $value: '#0B739E', $type: 'color' },
      '700': { $value: '#085572', $type: 'color' },
      '800': { $value: '#12455C', $type: 'color' },
    },
    surface: { $value: '#FFFFFF', $type: 'color' },
    onSurface: { $value: '#1A1D24', $type: 'color' },
    surfaceVariant: { $value: '#F6F5EE', $type: 'color' },
    onSurfaceVariant: { $value: '#4A4F5C', $type: 'color' },
    container: { $value: '#FBFAF6', $type: 'color' },
    onContainer: { $value: '#1A1D24', $type: 'color' },
    outline: { $value: 'rgba(26, 29, 36, 0.18)', $type: 'color' },
    outlineVariant: { $value: 'rgba(26, 29, 36, 0.10)', $type: 'color' },
    onPrimary: { $value: '#0E1014', $type: 'color' },
    primaryContainer: { $value: '#E9FFB8', $type: 'color' },
    onPrimaryContainer: { $value: '#28390B', $type: 'color' },
    onError: { $value: '#FFFFFF', $type: 'color' },
    errorContainer: { $value: '#FFE9E8', $type: 'color' },
    onErrorContainer: { $value: '#8A1F1F', $type: 'color' },
    tertiary: { $value: '#D6247F', $type: 'color' },
    onTertiary: { $value: '#FFFFFF', $type: 'color' },
    tertiaryContainer: { $value: '#FFDCEE', $type: 'color' },
    onTertiaryContainer: { $value: '#6B1240', $type: 'color' },
  },

  ...shared,
  shape: { radius: sharedRadius, shadow: lightShadows },
};

export const theme = {
  light: guueyBrandLight,
  dark: guueyBrandDark,
};
