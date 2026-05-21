/**
 * Premium Botanical Theme — light + dark variants
 *
 * Natural greens and warm cream neutrals. Organic shapes, gentle motion
 * inspired by leaves and vines. Mesh canvas with green/cream blobs.
 *
 * Light variant: cream surface, leaf-green primary — daytime garden.
 *
 * Dark variant: forest at night — deep dark base with green undertones,
 * lifted leaf-green accents that read against the dark soil.
 */

import type { DtcgTheme } from '../types';

// ── shared (mode-agnostic) tokens ──────────────────────────────────
const shared = {
  font: {
    family: {
      sans: {
        $value: '"Lora", "Georgia", serif',
        $type: 'fontFamily',
      },
      mono: {
        $value: '"IBM Plex Mono", "Courier New", monospace',
        $type: 'fontFamily',
      },
    },
    size: {
      sm: { $value: '0.875rem', $type: 'dimension' },
      base: { $value: '1rem', $type: 'dimension' },
      lg: { $value: '1.15rem', $type: 'dimension' },
      xl: { $value: '1.3rem', $type: 'dimension' },
      '2xl': { $value: '1.625rem', $type: 'dimension' },
    },
    weight: {
      normal: { $value: '400', $type: 'fontWeight' },
      medium: { $value: '500', $type: 'fontWeight' },
      semibold: { $value: '600', $type: 'fontWeight' },
      bold: { $value: '700', $type: 'fontWeight' },
    },
    lineHeight: {
      tight: { $value: '1.3', $type: 'number' },
      normal: { $value: '1.6', $type: 'number' },
      relaxed: { $value: '1.85', $type: 'number' },
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

  shape: {
    radius: {
      sm: { $value: '0.375rem', $type: 'dimension' },
      md: { $value: '0.625rem', $type: 'dimension' },
      lg: { $value: '1rem', $type: 'dimension' },
      xl: { $value: '1.5rem', $type: 'dimension' },
      full: { $value: '9999px', $type: 'dimension' },
    },
    shadow: {
      sm: {
        $value: '0 1px 3px rgba(53, 46, 32, 0.08)',
        $type: 'shadow',
      },
      md: {
        $value: '0 4px 8px rgba(53, 46, 32, 0.10)',
        $type: 'shadow',
      },
      lg: {
        $value: '0 8px 20px rgba(53, 46, 32, 0.12)',
        $type: 'shadow',
      },
      xl: {
        $value: '0 16px 40px rgba(53, 46, 32, 0.14)',
        $type: 'shadow',
      },
    },
  },

  motion: {
    duration: {
      fast: { $value: '200ms', $type: 'duration' },
      normal: { $value: '400ms', $type: 'duration' },
      slow: { $value: '1200ms', $type: 'duration' },
      ambient: { $value: '5000ms', $type: 'duration' },
    },
    easing: {
      default: {
        $value: 'cubic-bezier(0.4, 0, 0.2, 1)',
        $type: 'cubicBezier',
      },
      bounce: {
        $value: 'cubic-bezier(0.34, 1.3, 0.64, 1)',
        $type: 'cubicBezier',
      },
      spring: {
        $value: 'cubic-bezier(0.22, 1, 0.36, 1)',
        $type: 'cubicBezier',
      },
    },
    keyframes: {
      'leaf-float': {
        $value:
          '0%{transform:translateY(0) rotate(0deg);opacity:0.7}25%{transform:translateY(-6px) rotate(3deg)}50%{transform:translateY(-2px) rotate(-2deg);opacity:1}75%{transform:translateY(-8px) rotate(2deg)}100%{transform:translateY(0) rotate(0deg);opacity:0.7}',
        $type: 'keyframes',
      },
      'vine-grow': {
        $value:
          '0%{transform:scaleY(0);transform-origin:bottom}100%{transform:scaleY(1);transform-origin:bottom}',
        $type: 'keyframes',
      },
      'gentle-sway': {
        $value:
          '0%{transform:rotate(-1deg)}50%{transform:rotate(1deg)}100%{transform:rotate(-1deg)}',
        $type: 'keyframes',
      },
    },
  },
} as const;

// ── Botanical — Light ──────────────────────────────────────────────
const botanicalLight: DtcgTheme = {
  $name: 'Botanical',
  $description:
    'Organic greens on warm cream — leaf-float animations, vine-grow motion, and a gentle mesh canvas.',
  $metadata: {
    font: 'Lora',
    fontUrl:
      'https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap',
    philosophy: 'Rooted in nature. Growing with intention.',
  },

  color: {
    primary: {
      '50': { $value: '#f0fdf4', $type: 'color' },
      '100': { $value: '#dcfce7', $type: 'color' },
      '200': { $value: '#bbf7d0', $type: 'color' },
      '300': { $value: '#86efac', $type: 'color' },
      '400': { $value: '#4ade80', $type: 'color' },
      '500': { $value: '#22c55e', $type: 'color' },
      '600': { $value: '#16a34a', $type: 'color' },
      '700': { $value: '#15803d', $type: 'color' },
      '800': { $value: '#166534', $type: 'color' },
      '900': { $value: '#14532d', $type: 'color' },
    },
    neutral: {
      '50': { $value: '#fefcf8', $type: 'color' },
      '100': { $value: '#fdf8ef', $type: 'color' },
      '200': { $value: '#f8f0df', $type: 'color' },
      '300': { $value: '#f0e4c9', $type: 'color' },
      '400': { $value: '#dccba5', $type: 'color' },
      '500': { $value: '#bfaa80', $type: 'color' },
      '600': { $value: '#9a8660', $type: 'color' },
      '700': { $value: '#746448', $type: 'color' },
      '800': { $value: '#504530', $type: 'color' },
      '900': { $value: '#352e20', $type: 'color' },
    },
    success: { $value: '#059669', $type: 'color' },
    warning: { $value: '#d97706', $type: 'color' },
    error: { $value: '#dc2626', $type: 'color' },
    info: { $value: '#0284c7', $type: 'color' },
    // Semantic roles
    surface: { $value: '#fefcf8', $type: 'color' },
    onSurface: { $value: '#352e20', $type: 'color' },
    surfaceVariant: { $value: '#fdf8ef', $type: 'color' },
    onSurfaceVariant: { $value: '#746448', $type: 'color' },
    container: { $value: '#dcfce7', $type: 'color' },
    onContainer: { $value: '#14532d', $type: 'color' },
    outline: { $value: '#f0e4c9', $type: 'color' },
    outlineVariant: { $value: '#f8f0df', $type: 'color' },
  },

  font: shared.font,
  spacing: shared.spacing,
  shape: shared.shape,
  motion: shared.motion,

  canvas: {
    mode: { $value: 'mesh', $type: 'string' },
    speed: { $value: 0.4, $type: 'number' },
    colors: {
      $value: [
        'rgba(22, 163, 74, 0.10)',
        'rgba(191, 170, 128, 0.08)',
        'rgba(240, 228, 201, 0.06)',
      ],
      $type: 'array',
    },
    background: { $value: '#141210', $type: 'color' },
  },
};

// ── Botanical — Dark ───────────────────────────────────────────────
//
// Forest at night. Surface = deep forest-soil, text = warm cream that
// echoes the light variant's neutral-50 (so the family identity holds).
// Primary 500 lifts to `#4ade80` so leaf-greens read against the dark
// soil; container is a deep forest green; canvas drops to a near-black
// soil base.
const botanicalDark: DtcgTheme = {
  $name: 'Botanical',
  $description:
    'Forest at night (dark) — deep soil surfaces with lifted leaf-green accents and gentle organic motion.',
  $metadata: {
    font: 'Lora',
    fontUrl:
      'https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap',
    philosophy: 'Rooted in nature. Growing with intention.',
  },

  color: {
    primary: {
      '50': { $value: '#14532d', $type: 'color' },
      '100': { $value: '#166534', $type: 'color' },
      '200': { $value: '#15803d', $type: 'color' },
      '300': { $value: '#16a34a', $type: 'color' },
      '400': { $value: '#22c55e', $type: 'color' },
      '500': { $value: '#4ade80', $type: 'color' }, // lifted leaf-green for dark
      '600': { $value: '#86efac', $type: 'color' },
      '700': { $value: '#bbf7d0', $type: 'color' },
      '800': { $value: '#dcfce7', $type: 'color' },
      '900': { $value: '#f0fdf4', $type: 'color' },
    },
    neutral: {
      '50': { $value: '#141210', $type: 'color' }, // forest-soil base
      '100': { $value: '#1f1c18', $type: 'color' },
      '200': { $value: '#352e20', $type: 'color' },
      '300': { $value: '#504530', $type: 'color' },
      '400': { $value: '#746448', $type: 'color' },
      '500': { $value: '#9a8660', $type: 'color' },
      '600': { $value: '#bfaa80', $type: 'color' },
      '700': { $value: '#dccba5', $type: 'color' },
      '800': { $value: '#f0e4c9', $type: 'color' },
      '900': { $value: '#fefcf8', $type: 'color' }, // warm cream text
    },
    success: { $value: '#34d399', $type: 'color' },
    warning: { $value: '#f59e0b', $type: 'color' },
    error: { $value: '#f87171', $type: 'color' },
    info: { $value: '#38bdf8', $type: 'color' },
    surface: { $value: '#1f1c18', $type: 'color' },
    onSurface: { $value: '#fefcf8', $type: 'color' },
    surfaceVariant: { $value: '#352e20', $type: 'color' },
    onSurfaceVariant: { $value: '#dccba5', $type: 'color' },
    container: { $value: '#166534', $type: 'color' }, // deep forest
    onContainer: { $value: '#dcfce7', $type: 'color' },
    outline: { $value: '#504530', $type: 'color' },
    outlineVariant: { $value: '#352e20', $type: 'color' },
  },

  font: shared.font,
  spacing: shared.spacing,
  shape: shared.shape,
  motion: shared.motion,

  canvas: {
    mode: { $value: 'mesh', $type: 'string' },
    speed: { $value: 0.4, $type: 'number' },
    colors: {
      $value: [
        'rgba(74, 222, 128, 0.12)', // lifted leaf
        'rgba(191, 170, 128, 0.09)',
        'rgba(53, 46, 32, 0.06)',
      ],
      $type: 'array',
    },
    background: { $value: '#0a0907', $type: 'color' },
  },
};

/** Botanical registration — both modes ship from day one. */
export const theme = {
  light: botanicalLight,
  dark: botanicalDark,
} as const;
