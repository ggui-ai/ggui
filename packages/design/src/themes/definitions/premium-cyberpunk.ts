/**
 * Premium Cyberpunk Theme — light + dark variants
 *
 * Neon-lit dystopian tech aesthetic. Cyan primary on near-black surfaces
 * with glitch animations and a constellation canvas evoking a neon network.
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
    'Neon-lit dystopian tech — cyan neon on dark chrome with glitch animations and constellation canvas.',
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
    success: { $value: '#00ff88', $type: 'color' },
    warning: { $value: '#ffaa00', $type: 'color' },
    error: { $value: '#ff2255', $type: 'color' },
    info: { $value: '#00ccff', $type: 'color' },
    // Semantic roles (dark theme — inverted neutral scale)
    surface: { $value: '#0a0a0f', $type: 'color' },
    onSurface: { $value: '#e8e8f0', $type: 'color' },
    surfaceVariant: { $value: '#111118', $type: 'color' },
    onSurfaceVariant: { $value: '#8888a0', $type: 'color' },
    container: { $value: '#155e75', $type: 'color' },
    onContainer: { $value: '#cffafe', $type: 'color' },
    outline: { $value: '#3a3a48', $type: 'color' },
    outlineVariant: { $value: '#25252f', $type: 'color' },
  },

  font: shared.font,
  spacing: shared.spacing,
  shape: shared.shape,
  motion: shared.motion,

  canvas: {
    mode: { $value: 'constellation', $type: 'string' },
    speed: { $value: 1.2, $type: 'number' },
    colors: {
      $value: [
        'rgba(6, 182, 212, 0.25)',
        'rgba(0, 255, 136, 0.12)',
        'rgba(255, 34, 85, 0.08)',
      ],
      $type: 'array',
    },
    background: { $value: '#05050a', $type: 'color' },
  },
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
    success: { $value: '#33ffaa', $type: 'color' }, // brighter mint for dark
    warning: { $value: '#ffbe33', $type: 'color' },
    error: { $value: '#ff4477', $type: 'color' },
    info: { $value: '#33d6ff', $type: 'color' },
    surface: { $value: '#000005', $type: 'color' },
    onSurface: { $value: '#e8e8f0', $type: 'color' },
    surfaceVariant: { $value: '#0a0a0f', $type: 'color' },
    onSurfaceVariant: { $value: '#aaaabe', $type: 'color' },
    container: { $value: '#0e7490', $type: 'color' }, // deeper teal
    onContainer: { $value: '#cffafe', $type: 'color' },
    outline: { $value: '#1a1a24', $type: 'color' },
    outlineVariant: { $value: '#111118', $type: 'color' },
  },

  font: shared.font,
  spacing: shared.spacing,
  shape: shared.shape,
  motion: shared.motion,

  canvas: {
    mode: { $value: 'constellation', $type: 'string' },
    speed: { $value: 1.2, $type: 'number' },
    colors: {
      $value: [
        'rgba(34, 211, 238, 0.32)', // brighter cyan
        'rgba(0, 255, 136, 0.16)',
        'rgba(255, 34, 85, 0.10)',
      ],
      $type: 'array',
    },
    background: { $value: '#000005', $type: 'color' },
  },
};

/** Cyberpunk registration — both modes ship from day one. */
export const theme = {
  light: cyberpunkLight,
  dark: cyberpunkDark,
} as const;
