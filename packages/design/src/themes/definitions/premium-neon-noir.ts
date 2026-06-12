/**
 * Premium Neon Noir Theme — light + dark variants
 *
 * Hot pink neon on near-black surfaces. Electric, bold, nocturnal.
 *
 * Light variant: shipping configuration. Already noir-leaning — dark
 * surface with hot pink neon.
 *
 * Dark variant: pure black surfaces, sharper neon contrast — leans
 * deeper into the noir end.
 */

import type { DtcgTheme } from '../types';
import {
  standardAccessibility,
  standardSemanticScales,
  standardZIndex,
} from './_shared';

// ── shared (mode-agnostic) tokens ──────────────────────────────────
const shared = {
  font: {
    family: {
      sans: {
        $value: '"Outfit", system-ui, -apple-system, sans-serif',
        $type: 'fontFamily',
      },
      mono: {
        $value: '"Fira Code", "JetBrains Mono", monospace',
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

  shape: {
    radius: {
      sm: { $value: '0.25rem', $type: 'dimension' },
      md: { $value: '0.5rem', $type: 'dimension' },
      lg: { $value: '0.75rem', $type: 'dimension' },
      xl: { $value: '1rem', $type: 'dimension' },
      full: { $value: '9999px', $type: 'dimension' },
    },
    shadow: {
      sm: { $value: '0 0 6px rgba(236, 72, 153, 0.25)', $type: 'shadow' },
      md: { $value: '0 0 12px rgba(236, 72, 153, 0.35)', $type: 'shadow' },
      lg: { $value: '0 0 20px rgba(236, 72, 153, 0.45)', $type: 'shadow' },
      xl: {
        $value:
          '0 0 30px rgba(236, 72, 153, 0.55), 0 0 60px rgba(236, 72, 153, 0.2)',
        $type: 'shadow',
      },
    },
  },

  motion: {
    duration: {
      fast: { $value: '120ms', $type: 'duration' },
      normal: { $value: '250ms', $type: 'duration' },
      slow: { $value: '800ms', $type: 'duration' },
      ambient: { $value: '2500ms', $type: 'duration' },
    },
    easing: {
      default: {
        $value: 'cubic-bezier(0.4, 0, 0.2, 1)',
        $type: 'cubicBezier',
      },
      bounce: {
        $value: 'cubic-bezier(0.68, -0.55, 0.27, 1.55)',
        $type: 'cubicBezier',
      },
      spring: {
        $value: 'cubic-bezier(0.22, 1, 0.36, 1)',
        $type: 'cubicBezier',
      },
    },
    transition: {
      fast: {
        $value: '120ms cubic-bezier(0.4, 0, 0.2, 1)',
        $type: 'transition',
      },
      normal: {
        $value: '250ms cubic-bezier(0.4, 0, 0.2, 1)',
        $type: 'transition',
      },
      slow: {
        $value: '800ms cubic-bezier(0.4, 0, 0.2, 1)',
        $type: 'transition',
      },
      colors: {
        $value:
          'color 250ms cubic-bezier(0.4, 0, 0.2, 1), background-color 250ms cubic-bezier(0.4, 0, 0.2, 1), border-color 250ms cubic-bezier(0.4, 0, 0.2, 1)',
        $type: 'transition',
      },
      opacity: {
        $value: 'opacity 250ms cubic-bezier(0.4, 0, 0.2, 1)',
        $type: 'transition',
      },
      transform: {
        $value: 'transform 250ms cubic-bezier(0.22, 1, 0.36, 1)',
        $type: 'transition',
      },
    },
    keyframes: {
      'neon-flicker': {
        $value:
          '0%{opacity:1}4%{opacity:0.7}8%{opacity:1}12%{opacity:0.85}16%{opacity:1}100%{opacity:1}',
        $type: 'keyframes',
      },
      'glow-pulse': {
        $value:
          '0%{box-shadow:0 0 8px rgba(236,72,153,0.4)}50%{box-shadow:0 0 24px rgba(236,72,153,0.8)}100%{box-shadow:0 0 8px rgba(236,72,153,0.4)}',
        $type: 'keyframes',
      },
      'electric-arc': {
        $value:
          '0%{clip-path:inset(0 100% 0 0)}50%{clip-path:inset(0 0 0 0)}100%{clip-path:inset(0 0 0 100%)}',
        $type: 'keyframes',
      },
    },
  },
} as const;

// ── Neon Noir — Light ──────────────────────────────────────────────
const neonNoirLight: DtcgTheme = {
  $name: 'Neon Noir',
  $description:
    'Hot pink neon on dark — electric glow effects, neon flicker, and flowing magenta particles.',
  $metadata: {
    font: 'Outfit',
    fontUrl:
      'https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&display=swap',
    philosophy: 'Midnight electricity. The city never sleeps.',
  },

  color: {
    primary: {
      '50': { $value: '#fdf2f8', $type: 'color' },
      '100': { $value: '#fce7f3', $type: 'color' },
      '200': { $value: '#fbcfe8', $type: 'color' },
      '300': { $value: '#f9a8d4', $type: 'color' },
      '400': { $value: '#f472b6', $type: 'color' },
      '500': { $value: '#ec4899', $type: 'color' },
      '600': { $value: '#db2777', $type: 'color' },
      '700': { $value: '#be185d', $type: 'color' },
      '800': { $value: '#9d174d', $type: 'color' },
      '900': { $value: '#831843', $type: 'color' },
    },
    neutral: {
      '50': { $value: '#09090b', $type: 'color' },
      '100': { $value: '#111114', $type: 'color' },
      '200': { $value: '#19191e', $type: 'color' },
      '300': { $value: '#232329', $type: 'color' },
      '400': { $value: '#3b3b44', $type: 'color' },
      '500': { $value: '#5a5a68', $type: 'color' },
      '600': { $value: '#8a8a9a', $type: 'color' },
      '700': { $value: '#b0b0be', $type: 'color' },
      '800': { $value: '#d4d4de', $type: 'color' },
      '900': { $value: '#ececf0', $type: 'color' },
    },
    success: {
      ...standardSemanticScales.dark.success,
      '500': { $value: '#34d399', $type: 'color' },
    },
    warning: {
      ...standardSemanticScales.dark.warning,
      '500': { $value: '#fbbf24', $type: 'color' },
    },
    error: {
      ...standardSemanticScales.dark.error,
      '500': { $value: '#f87171', $type: 'color' },
    },
    info: {
      ...standardSemanticScales.dark.info,
      '500': { $value: '#38bdf8', $type: 'color' },
    },
    // Semantic roles (dark theme — inverted neutral scale)
    surface: { $value: '#09090b', $type: 'color' },
    onSurface: { $value: '#ececf0', $type: 'color' },
    surfaceVariant: { $value: '#111114', $type: 'color' },
    onSurfaceVariant: { $value: '#8a8a9a', $type: 'color' },
    container: { $value: '#9d174d', $type: 'color' },
    onContainer: { $value: '#fce7f3', $type: 'color' },
    outline: { $value: '#3b3b44', $type: 'color' },
    outlineVariant: { $value: '#232329', $type: 'color' },
    // Primary role pair — onPrimary is deep noir so hot pink CTAs pop.
    onPrimary: { $value: '#09090b', $type: 'color' },
    primaryContainer: { $value: '#9d174d', $type: 'color' }, // primary-800
    onPrimaryContainer: { $value: '#fce7f3', $type: 'color' }, // primary-100
    // Error role pair — onError on lifted rose.
    onError: { $value: '#09090b', $type: 'color' },
    errorContainer: { $value: '#7f1d1d', $type: 'color' },
    onErrorContainer: { $value: '#fecaca', $type: 'color' },
    // Tertiary role — electric violet, the natural neon-noir sister hue
    // to hot pink (UV side of the spectrum, keeps the nocturnal-electric
    // family identity).
    tertiary: { $value: '#a855f7', $type: 'color' }, // violet-500 — electric UV
    onTertiary: { $value: '#09090b', $type: 'color' },
    tertiaryContainer: { $value: '#6b21a8', $type: 'color' }, // violet-800
    onTertiaryContainer: { $value: '#f3e8ff', $type: 'color' }, // violet-100
  },

  font: shared.font,
  spacing: shared.spacing,
  shape: shared.shape,
  motion: shared.motion,


  accessibility: {
    ...standardAccessibility.dark,
    focusRing: {
      ...standardAccessibility.dark.focusRing,
      color: { $value: '#ec4899', $type: 'color' },
    },
  },

  zIndex: standardZIndex,
};

// ── Neon Noir — Dark ───────────────────────────────────────────────
//
// Pure black, sharper neon. The pink ladder shifts up so primary CTAs
// burn brighter against the deeper surface; container reads as a
// richer magenta than light variant for stronger primary regions.
const neonNoirDark: DtcgTheme = {
  $name: 'Neon Noir',
  $description:
    'Hot pink neon on pure black (dark) — sharper noir contrast, brighter electric glow, deeper magenta containers.',
  $metadata: {
    font: 'Outfit',
    fontUrl:
      'https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&display=swap',
    philosophy: 'Midnight electricity. The city never sleeps.',
  },

  color: {
    primary: {
      '50': { $value: '#831843', $type: 'color' },
      '100': { $value: '#9d174d', $type: 'color' },
      '200': { $value: '#be185d', $type: 'color' },
      '300': { $value: '#db2777', $type: 'color' },
      '400': { $value: '#ec4899', $type: 'color' },
      '500': { $value: '#f472b6', $type: 'color' }, // lifted hot pink for pure-black surface
      '600': { $value: '#f9a8d4', $type: 'color' },
      '700': { $value: '#fbcfe8', $type: 'color' },
      '800': { $value: '#fce7f3', $type: 'color' },
      '900': { $value: '#fdf2f8', $type: 'color' },
    },
    neutral: {
      '50': { $value: '#000000', $type: 'color' }, // pure black surface base
      '100': { $value: '#09090b', $type: 'color' },
      '200': { $value: '#111114', $type: 'color' },
      '300': { $value: '#19191e', $type: 'color' },
      '400': { $value: '#3b3b44', $type: 'color' },
      '500': { $value: '#5a5a68', $type: 'color' },
      '600': { $value: '#8a8a9a', $type: 'color' },
      '700': { $value: '#b0b0be', $type: 'color' },
      '800': { $value: '#d4d4de', $type: 'color' },
      '900': { $value: '#ececf0', $type: 'color' },
    },
    success: {
      ...standardSemanticScales.dark.success,
      '500': { $value: '#5ee0ad', $type: 'color' },
    },
    warning: {
      ...standardSemanticScales.dark.warning,
      '500': { $value: '#ffd24a', $type: 'color' },
    },
    error: {
      ...standardSemanticScales.dark.error,
      '500': { $value: '#ff8a8a', $type: 'color' },
    },
    info: {
      ...standardSemanticScales.dark.info,
      '500': { $value: '#5acdff', $type: 'color' },
    },
    surface: { $value: '#000000', $type: 'color' },
    onSurface: { $value: '#ececf0', $type: 'color' },
    surfaceVariant: { $value: '#09090b', $type: 'color' },
    onSurfaceVariant: { $value: '#b0b0be', $type: 'color' },
    container: { $value: '#be185d', $type: 'color' }, // richer magenta
    onContainer: { $value: '#fce7f3', $type: 'color' },
    outline: { $value: '#19191e', $type: 'color' },
    outlineVariant: { $value: '#111114', $type: 'color' },
    // Primary role pair — dark: onPrimary is pure black, container = richer magenta.
    onPrimary: { $value: '#000000', $type: 'color' },
    primaryContainer: { $value: '#be185d', $type: 'color' }, // richer magenta
    onPrimaryContainer: { $value: '#fce7f3', $type: 'color' },
    // Error role pair — lifted rose against pure black.
    onError: { $value: '#000000', $type: 'color' },
    errorContainer: { $value: '#7f1d1d', $type: 'color' },
    onErrorContainer: { $value: '#fecdd3', $type: 'color' },
    // Tertiary role — electric violet lifted for AA on pure black.
    tertiary: { $value: '#c084fc', $type: 'color' }, // violet-400 lifted
    onTertiary: { $value: '#000000', $type: 'color' },
    tertiaryContainer: { $value: '#581c87', $type: 'color' }, // violet-900
    onTertiaryContainer: { $value: '#f3e8ff', $type: 'color' }, // violet-100
  },

  font: shared.font,
  spacing: shared.spacing,
  shape: shared.shape,
  motion: shared.motion,


  accessibility: {
    ...standardAccessibility.dark,
    focusRing: {
      ...standardAccessibility.dark.focusRing,
      color: { $value: '#f472b6', $type: 'color' },
    },
  },

  zIndex: standardZIndex,
};

/** Neon Noir registration — both modes ship from day one. */
export const theme = {
  light: neonNoirLight,
  dark: neonNoirDark,
} as const;
