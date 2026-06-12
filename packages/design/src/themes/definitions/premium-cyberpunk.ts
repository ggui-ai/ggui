/**
 * Premium Cyberpunk Theme — light + dark variants
 *
 * Neon-lit dystopian tech aesthetic. Cyan primary on near-black surfaces
 * with glitch animations.
 *
 * Light variant: pale chrome surface with cyan neon accents — keeps the
 * digital-rebellion feel without going full dark. The neon palette stays
 * intact; only neutrals invert.
 *
 * Dark variant: this preset's natural home — pure-black-ish surfaces let
 * the cyan crank harder. `primary-500` shifts a step lighter so neon
 * highlights pop against `#05050a`.
 */

import type { DtcgTheme } from '../types';
import { standardAccessibility, standardZIndex } from './_shared';

// ── shared (mode-agnostic) tokens ──────────────────────────────────
const shared = {
  font: {
    family: {
      sans: {
        $value: '"Orbitron", "Rajdhani", system-ui, sans-serif',
        $type: 'fontFamily',
      },
      mono: {
        $value: '"Share Tech Mono", "Fira Code", monospace',
        $type: 'fontFamily',
      },
    },
    size: {
      sm: { $value: '0.8rem', $type: 'dimension' },
      base: { $value: '0.95rem', $type: 'dimension' },
      lg: { $value: '1.1rem', $type: 'dimension' },
      xl: { $value: '1.3rem', $type: 'dimension' },
      '2xl': { $value: '1.6rem', $type: 'dimension' },
    },
    weight: {
      normal: { $value: '400', $type: 'fontWeight' },
      medium: { $value: '500', $type: 'fontWeight' },
      semibold: { $value: '600', $type: 'fontWeight' },
      bold: { $value: '700', $type: 'fontWeight' },
    },
    lineHeight: {
      tight: { $value: '1.2', $type: 'number' },
      normal: { $value: '1.5', $type: 'number' },
      relaxed: { $value: '1.7', $type: 'number' },
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
      sm: { $value: '2px', $type: 'dimension' },
      md: { $value: '4px', $type: 'dimension' },
      lg: { $value: '6px', $type: 'dimension' },
      xl: { $value: '8px', $type: 'dimension' },
      full: { $value: '9999px', $type: 'dimension' },
    },
    shadow: {
      sm: { $value: '0 0 4px rgba(6, 182, 212, 0.3)', $type: 'shadow' },
      md: { $value: '0 0 8px rgba(6, 182, 212, 0.4)', $type: 'shadow' },
      lg: { $value: '0 0 16px rgba(6, 182, 212, 0.5)', $type: 'shadow' },
      xl: {
        $value: '0 0 24px rgba(6, 182, 212, 0.6), 0 0 48px rgba(6, 182, 212, 0.2)',
        $type: 'shadow',
      },
    },
  },

  motion: {
    duration: {
      fast: { $value: '100ms', $type: 'duration' },
      normal: { $value: '200ms', $type: 'duration' },
      slow: { $value: '600ms', $type: 'duration' },
      ambient: { $value: '2000ms', $type: 'duration' },
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
    keyframes: {
      'glitch-flicker': {
        $value:
          '0%{opacity:1;transform:none}7%{opacity:0.8;transform:translateX(-2px) skewX(-1deg)}10%{opacity:1;transform:none}47%{opacity:1;transform:none}50%{opacity:0.6;transform:translateX(3px) skewX(2deg)}53%{opacity:1;transform:none}100%{opacity:1;transform:none}',
        $type: 'keyframes',
      },
      'scan-line': {
        $value:
          '0%{transform:translateY(-100%)}100%{transform:translateY(100%)}',
        $type: 'keyframes',
      },
      'neon-pulse': {
        $value:
          '0%{box-shadow:0 0 4px rgba(6,182,212,0.4)}50%{box-shadow:0 0 16px rgba(6,182,212,0.8)}100%{box-shadow:0 0 4px rgba(6,182,212,0.4)}',
        $type: 'keyframes',
      },
    },
    // Cyberpunk-tuned composed transitions: fast/normal match the
    // standard ladder, but `slow` lifts to 600ms to mirror this
    // theme's `motion.duration.slow` (drawn-out neon glow fades).
    transition: {
      fast: {
        $type: 'transition',
        $value: '100ms cubic-bezier(0.4, 0, 0.2, 1)',
      },
      normal: {
        $type: 'transition',
        $value: '200ms cubic-bezier(0.4, 0, 0.2, 1)',
      },
      slow: {
        $type: 'transition',
        $value: '600ms cubic-bezier(0.4, 0, 0.2, 1)',
      },
      colors: {
        $type: 'transition',
        $value:
          'color 200ms cubic-bezier(0.4, 0, 0.2, 1), background-color 200ms cubic-bezier(0.4, 0, 0.2, 1), border-color 200ms cubic-bezier(0.4, 0, 0.2, 1)',
      },
      opacity: {
        $type: 'transition',
        $value: 'opacity 200ms cubic-bezier(0.4, 0, 0.2, 1)',
      },
      transform: {
        $type: 'transition',
        $value: 'transform 200ms cubic-bezier(0, 0, 0.2, 1)',
      },
    },
  },
} as const;

// ── Cyberpunk — Light ──────────────────────────────────────────────
//
// Original shipping configuration: dark surfaces with cyan neon. This
// preset has always read as "dark by default" but it's registered as
// `light` in the registry; we keep it as-is for backward stability.
const cyberpunkLight: DtcgTheme = {
  $name: 'Cyberpunk',
  $description:
    'Neon-lit dystopian tech — cyan neon on dark chrome with glitch animations.',
  $metadata: {
    font: 'Orbitron',
    fontUrl:
      'https://fonts.googleapis.com/css2?family=Orbitron:wght@400;500;600;700&display=swap',
    philosophy: 'Chromatic noise, electric tension, digital rebellion.',
  },

  color: {
    primary: {
      '50': { $value: '#ecfeff', $type: 'color' },
      '100': { $value: '#cffafe', $type: 'color' },
      '200': { $value: '#a5f3fc', $type: 'color' },
      '300': { $value: '#67e8f9', $type: 'color' },
      '400': { $value: '#22d3ee', $type: 'color' },
      '500': { $value: '#06b6d4', $type: 'color' },
      '600': { $value: '#0891b2', $type: 'color' },
      '700': { $value: '#0e7490', $type: 'color' },
      '800': { $value: '#155e75', $type: 'color' },
      '900': { $value: '#164e63', $type: 'color' },
    },
    neutral: {
      '50': { $value: '#0a0a0f', $type: 'color' },
      '100': { $value: '#111118', $type: 'color' },
      '200': { $value: '#1a1a24', $type: 'color' },
      '300': { $value: '#25252f', $type: 'color' },
      '400': { $value: '#3a3a48', $type: 'color' },
      '500': { $value: '#55556a', $type: 'color' },
      '600': { $value: '#8888a0', $type: 'color' },
      '700': { $value: '#aaaabe', $type: 'color' },
      '800': { $value: '#d0d0e0', $type: 'color' },
      '900': { $value: '#e8e8f0', $type: 'color' },
    },
    // Neon semantic scales — each hue's existing singleton anchors `500`,
    // with lighter 50/100/200 tints (HSL lightness lifted toward 95/85/75)
    // and darker 600/700/800 shades (lightness pulled down ~10/20/30%)
    // while holding hue + saturation constant to keep the neon identity.
    success: {
      '50': { $value: '#e0fff1', $type: 'color' },
      '100': { $value: '#b3ffd9', $type: 'color' },
      '200': { $value: '#66ffb3', $type: 'color' },
      '500': { $value: '#00ff88', $type: 'color' },
      '600': { $value: '#00cc6e', $type: 'color' },
      '700': { $value: '#009955', $type: 'color' },
      '800': { $value: '#006638', $type: 'color' },
    },
    warning: {
      '50': { $value: '#fff5e0', $type: 'color' },
      '100': { $value: '#ffe5b3', $type: 'color' },
      '200': { $value: '#ffcc66', $type: 'color' },
      '500': { $value: '#ffaa00', $type: 'color' },
      '600': { $value: '#cc8800', $type: 'color' },
      '700': { $value: '#996600', $type: 'color' },
      '800': { $value: '#664400', $type: 'color' },
    },
    error: {
      '50': { $value: '#ffe0e8', $type: 'color' },
      '100': { $value: '#ffb3c4', $type: 'color' },
      '200': { $value: '#ff6688', $type: 'color' },
      '500': { $value: '#ff2255', $type: 'color' },
      '600': { $value: '#cc1a44', $type: 'color' },
      '700': { $value: '#991333', $type: 'color' },
      '800': { $value: '#660d22', $type: 'color' },
    },
    info: {
      '50': { $value: '#e0f9ff', $type: 'color' },
      '100': { $value: '#b3edff', $type: 'color' },
      '200': { $value: '#66dbff', $type: 'color' },
      '500': { $value: '#00ccff', $type: 'color' },
      '600': { $value: '#00a3cc', $type: 'color' },
      '700': { $value: '#007a99', $type: 'color' },
      '800': { $value: '#005266', $type: 'color' },
    },
    // Semantic roles (dark theme — inverted neutral scale)
    surface: { $value: '#0a0a0f', $type: 'color' },
    onSurface: { $value: '#e8e8f0', $type: 'color' },
    surfaceVariant: { $value: '#111118', $type: 'color' },
    onSurfaceVariant: { $value: '#8888a0', $type: 'color' },
    container: { $value: '#155e75', $type: 'color' },
    onContainer: { $value: '#cffafe', $type: 'color' },
    outline: { $value: '#3a3a48', $type: 'color' },
    outlineVariant: { $value: '#25252f', $type: 'color' },
    // Primary role pair — onPrimary is the deep night chrome, container
    // is the same teal as the canonical container (cyan-800).
    onPrimary: { $value: '#0a0a0f', $type: 'color' },
    primaryContainer: { $value: '#155e75', $type: 'color' }, // cyan-800
    onPrimaryContainer: { $value: '#cffafe', $type: 'color' }, // cyan-100
    // Error role pair — onError reads near-black on neon magenta.
    onError: { $value: '#0a0a0f', $type: 'color' },
    errorContainer: { $value: '#660d22', $type: 'color' }, // error-800
    onErrorContainer: { $value: '#ffe0e8', $type: 'color' }, // error-50
    // Tertiary role — neon lime, the canonical cyberpunk third-color
    // accent. Reuses the success singleton (#00ff88) for brand coherence
    // with on-brand "MATRIX-green" glow.
    tertiary: { $value: '#00ff88', $type: 'color' }, // neon lime
    onTertiary: { $value: '#0a0a0f', $type: 'color' },
    tertiaryContainer: { $value: '#006638', $type: 'color' }, // success-800
    onTertiaryContainer: { $value: '#e0fff1', $type: 'color' }, // success-50
  },

  font: shared.font,
  spacing: shared.spacing,
  shape: shared.shape,
  motion: shared.motion,

  // Focus ring shifts to cyberpunk's primary cyan so neon-on-dark
  // surfaces get a high-contrast cyan glow instead of the default sky.
  accessibility: {
    ...standardAccessibility.light,
    focusRing: {
      ...standardAccessibility.light.focusRing,
      color: { $type: 'color', $value: '#06b6d4' },
    },
  },
  zIndex: standardZIndex,

};

// ── Cyberpunk — Dark ───────────────────────────────────────────────
//
// Pushes deeper into the noir end of the cyberpunk axis: pure-black
// surfaces, cyan neon a step brighter, container becomes a deeper
// teal-cyan than the light variant for stronger primary-coded regions.
const cyberpunkDark: DtcgTheme = {
  $name: 'Cyberpunk',
  $description:
    'Neon-lit dystopian tech (dark) — brighter cyan on pure-black chrome, cranked neon contrast.',
  $metadata: {
    font: 'Orbitron',
    fontUrl:
      'https://fonts.googleapis.com/css2?family=Orbitron:wght@400;500;600;700&display=swap',
    philosophy: 'Chromatic noise, electric tension, digital rebellion.',
  },

  color: {
    // Inverted ladder, step 500 lifted to `#22d3ee` so neon clears
    // contrast against the deeper `#000005` surface.
    primary: {
      '50': { $value: '#164e63', $type: 'color' },
      '100': { $value: '#155e75', $type: 'color' },
      '200': { $value: '#0e7490', $type: 'color' },
      '300': { $value: '#0891b2', $type: 'color' },
      '400': { $value: '#06b6d4', $type: 'color' },
      '500': { $value: '#22d3ee', $type: 'color' }, // lifted neon for dark contrast
      '600': { $value: '#67e8f9', $type: 'color' },
      '700': { $value: '#a5f3fc', $type: 'color' },
      '800': { $value: '#cffafe', $type: 'color' },
      '900': { $value: '#ecfeff', $type: 'color' },
    },
    // Same neutral curve as the light "dark-default" variant — already
    // dark — but compressed darker at the bottom.
    neutral: {
      '50': { $value: '#000005', $type: 'color' }, // pure-black-ish base
      '100': { $value: '#0a0a0f', $type: 'color' },
      '200': { $value: '#111118', $type: 'color' },
      '300': { $value: '#1a1a24', $type: 'color' },
      '400': { $value: '#3a3a48', $type: 'color' },
      '500': { $value: '#55556a', $type: 'color' },
      '600': { $value: '#8888a0', $type: 'color' },
      '700': { $value: '#aaaabe', $type: 'color' },
      '800': { $value: '#d0d0e0', $type: 'color' },
      '900': { $value: '#e8e8f0', $type: 'color' },
    },
    // Neon semantic scales (dark) — inverted ramp: 50 is the deepest
    // saturated shade, 500 anchors the existing brighter neon singleton
    // for dark contrast, 800 is the palest tint. Derived by holding hue
    // + saturation and walking HSL lightness down/up from 500.
    success: {
      '50': { $value: '#003319', $type: 'color' },
      '100': { $value: '#006633', $type: 'color' },
      '200': { $value: '#00994d', $type: 'color' },
      '500': { $value: '#33ffaa', $type: 'color' }, // brighter mint for dark
      '600': { $value: '#66ffbf', $type: 'color' },
      '700': { $value: '#99ffd4', $type: 'color' },
      '800': { $value: '#ccffea', $type: 'color' },
    },
    warning: {
      '50': { $value: '#332200', $type: 'color' },
      '100': { $value: '#664400', $type: 'color' },
      '200': { $value: '#996600', $type: 'color' },
      '500': { $value: '#ffbe33', $type: 'color' },
      '600': { $value: '#ffcb5c', $type: 'color' },
      '700': { $value: '#ffd985', $type: 'color' },
      '800': { $value: '#ffe7ad', $type: 'color' },
    },
    error: {
      '50': { $value: '#330a17', $type: 'color' },
      '100': { $value: '#66142e', $type: 'color' },
      '200': { $value: '#991e45', $type: 'color' },
      '500': { $value: '#ff4477', $type: 'color' },
      '600': { $value: '#ff6e94', $type: 'color' },
      '700': { $value: '#ff97b1', $type: 'color' },
      '800': { $value: '#ffc1cf', $type: 'color' },
    },
    info: {
      '50': { $value: '#002b33', $type: 'color' },
      '100': { $value: '#005566', $type: 'color' },
      '200': { $value: '#008099', $type: 'color' },
      '500': { $value: '#33d6ff', $type: 'color' },
      '600': { $value: '#5cdeff', $type: 'color' },
      '700': { $value: '#85e6ff', $type: 'color' },
      '800': { $value: '#adeeff', $type: 'color' },
    },
    surface: { $value: '#000005', $type: 'color' },
    onSurface: { $value: '#e8e8f0', $type: 'color' },
    surfaceVariant: { $value: '#0a0a0f', $type: 'color' },
    onSurfaceVariant: { $value: '#aaaabe', $type: 'color' },
    container: { $value: '#0e7490', $type: 'color' }, // deeper teal
    onContainer: { $value: '#cffafe', $type: 'color' },
    outline: { $value: '#1a1a24', $type: 'color' },
    outlineVariant: { $value: '#111118', $type: 'color' },
    // Primary role pair — dark: onPrimary is pure-black-ish, container = deeper teal.
    onPrimary: { $value: '#000005', $type: 'color' },
    primaryContainer: { $value: '#0e7490', $type: 'color' }, // deeper teal
    onPrimaryContainer: { $value: '#cffafe', $type: 'color' },
    // Error role pair — lifted neon magenta against pure-black surface.
    onError: { $value: '#000005', $type: 'color' },
    errorContainer: { $value: '#991e45', $type: 'color' }, // dark error-200
    onErrorContainer: { $value: '#ffc1cf', $type: 'color' }, // dark error-800
    // Tertiary role — neon lime lifted for AA on pure-black.
    tertiary: { $value: '#33ffaa', $type: 'color' }, // brighter mint for dark
    onTertiary: { $value: '#000005', $type: 'color' },
    tertiaryContainer: { $value: '#006633', $type: 'color' }, // dark success-100
    onTertiaryContainer: { $value: '#ccffea', $type: 'color' }, // dark success-800
  },

  font: shared.font,
  spacing: shared.spacing,
  shape: shared.shape,
  motion: shared.motion,

  // Focus ring uses the dark variant's lifted neon cyan (#22d3ee) so
  // focus on pure-black surfaces glows brighter than the standard sky.
  accessibility: {
    ...standardAccessibility.dark,
    focusRing: {
      ...standardAccessibility.dark.focusRing,
      color: { $type: 'color', $value: '#22d3ee' },
    },
  },
  zIndex: standardZIndex,

};

/** Cyberpunk registration — both modes ship from day one. */
export const theme = {
  light: cyberpunkLight,
  dark: cyberpunkDark,
} as const;
