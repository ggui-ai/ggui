/**
 * Premium Zen Theme — light + dark variants
 *
 * Minimalist Japanese aesthetic inspired by wabi-sabi.
 * Stone/warm gray palette with subtle green accents, slow breathing
 * animations, and a soft mesh canvas.
 *
 * Light variant: warm stone ivory surface, restrained moss-green primary.
 *
 * Dark variant: muted dusk — warm dark stone surfaces with low-saturation
 * moss accents. Don't introduce vivid colors that break the zen
 * philosophy; the dark variant should still feel quiet.
 */

import type { DtcgTheme } from '../types';

// ── shared (mode-agnostic) tokens ──────────────────────────────────
const shared = {
  font: {
    family: {
      sans: {
        $value: '"Noto Serif JP", "Georgia", serif',
        $type: 'fontFamily',
      },
      mono: {
        $value: '"Noto Sans Mono", "Courier New", monospace',
        $type: 'fontFamily',
      },
    },
    size: {
      sm: { $value: '0.875rem', $type: 'dimension' },
      base: { $value: '1rem', $type: 'dimension' },
      lg: { $value: '1.125rem', $type: 'dimension' },
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
      tight: { $value: '1.3', $type: 'number' },
      normal: { $value: '1.6', $type: 'number' },
      relaxed: { $value: '1.9', $type: 'number' },
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
      sm: { $value: '0.125rem', $type: 'dimension' },
      md: { $value: '0.25rem', $type: 'dimension' },
      lg: { $value: '0.5rem', $type: 'dimension' },
      xl: { $value: '0.75rem', $type: 'dimension' },
      full: { $value: '9999px', $type: 'dimension' },
    },
    shadow: {
      sm: {
        $value: '0 1px 3px rgba(42, 39, 36, 0.06)',
        $type: 'shadow',
      },
      md: {
        $value: '0 3px 8px rgba(42, 39, 36, 0.08)',
        $type: 'shadow',
      },
      lg: {
        $value: '0 8px 20px rgba(42, 39, 36, 0.10)',
        $type: 'shadow',
      },
      xl: {
        $value: '0 16px 40px rgba(42, 39, 36, 0.12)',
        $type: 'shadow',
      },
    },
  },

  motion: {
    duration: {
      fast: { $value: '200ms', $type: 'duration' },
      normal: { $value: '500ms', $type: 'duration' },
      slow: { $value: '1500ms', $type: 'duration' },
      ambient: { $value: '6000ms', $type: 'duration' },
    },
    easing: {
      default: {
        $value: 'cubic-bezier(0.33, 0, 0.67, 1)',
        $type: 'cubicBezier',
      },
      bounce: {
        $value: 'cubic-bezier(0.34, 1.2, 0.64, 1)',
        $type: 'cubicBezier',
      },
      spring: {
        $value: 'cubic-bezier(0.22, 1, 0.36, 1)',
        $type: 'cubicBezier',
      },
    },
    keyframes: {
      'slow-breathe': {
        $value:
          '0%{opacity:0.85}50%{opacity:1}100%{opacity:0.85}',
        $type: 'keyframes',
      },
      'gentle-fade': {
        $value:
          '0%{opacity:0}100%{opacity:1}',
        $type: 'keyframes',
      },
      'ink-ripple': {
        $value:
          '0%{transform:scale(0.95);opacity:0.5}50%{transform:scale(1);opacity:0.8}100%{transform:scale(0.95);opacity:0.5}',
        $type: 'keyframes',
      },
    },
  },
} as const;

// ── Zen — Light ────────────────────────────────────────────────────
const zenLight: DtcgTheme = {
  $name: 'Zen',
  $description:
    'Minimalist Japanese aesthetic — warm stone tones, deliberate space, and unhurried motion.',
  $metadata: {
    font: 'Noto Serif JP',
    fontUrl:
      'https://fonts.googleapis.com/css2?family=Noto+Serif+JP:wght@400;500;600;700&display=swap',
    philosophy: 'Beauty in imperfection. Stillness as presence.',
  },

  color: {
    primary: {
      '50': { $value: '#f6f7f4', $type: 'color' },
      '100': { $value: '#e8ebe2', $type: 'color' },
      '200': { $value: '#d1d7c5', $type: 'color' },
      '300': { $value: '#b3bda1', $type: 'color' },
      '400': { $value: '#93a17c', $type: 'color' },
      '500': { $value: '#748660', $type: 'color' },
      '600': { $value: '#5c6b4c', $type: 'color' },
      '700': { $value: '#48543d', $type: 'color' },
      '800': { $value: '#3b4434', $type: 'color' },
      '900': { $value: '#33392e', $type: 'color' },
    },
    neutral: {
      '50': { $value: '#faf9f7', $type: 'color' },
      '100': { $value: '#f3f1ed', $type: 'color' },
      '200': { $value: '#e7e4de', $type: 'color' },
      '300': { $value: '#d5d0c8', $type: 'color' },
      '400': { $value: '#b8b0a4', $type: 'color' },
      '500': { $value: '#9a9084', $type: 'color' },
      '600': { $value: '#7a7068', $type: 'color' },
      '700': { $value: '#5e5650', $type: 'color' },
      '800': { $value: '#3e3a36', $type: 'color' },
      '900': { $value: '#2a2724', $type: 'color' },
    },
    success: { $value: '#6b8f5e', $type: 'color' },
    warning: { $value: '#c9a84c', $type: 'color' },
    error: { $value: '#b85450', $type: 'color' },
    info: { $value: '#6a8fa0', $type: 'color' },
    // Semantic roles
    surface: { $value: '#faf9f7', $type: 'color' },
    onSurface: { $value: '#2a2724', $type: 'color' },
    surfaceVariant: { $value: '#f3f1ed', $type: 'color' },
    onSurfaceVariant: { $value: '#6b635b', $type: 'color' },
    container: { $value: '#e8ebe2', $type: 'color' },
    onContainer: { $value: '#33392e', $type: 'color' },
    outline: { $value: '#d5d0c8', $type: 'color' },
    outlineVariant: { $value: '#e7e4de', $type: 'color' },
  },

  font: shared.font,
  spacing: shared.spacing,
  shape: shared.shape,
  motion: shared.motion,

  canvas: {
    mode: { $value: 'mesh', $type: 'string' },
    speed: { $value: 0.3, $type: 'number' },
    colors: {
      $value: [
        'rgba(92, 107, 76, 0.08)',
        'rgba(185, 176, 164, 0.06)',
        'rgba(213, 208, 200, 0.05)',
      ],
      $type: 'array',
    },
    background: { $value: '#1a1816', $type: 'color' },
  },
};

// ── Zen — Dark ─────────────────────────────────────────────────────
//
// Warm dusk stone. Surface = deep warm-brown stone, text = off-cream
// (kept slightly muted to preserve restraint). Moss accent lifts a
// step lighter; saturation deliberately held low so the family
// philosophy ("Beauty in imperfection. Stillness as presence.") survives.
const zenDark: DtcgTheme = {
  $name: 'Zen',
  $description:
    'Minimalist Japanese aesthetic (dark) — dusk stone surfaces with restrained moss accents and unhurried motion.',
  $metadata: {
    font: 'Noto Serif JP',
    fontUrl:
      'https://fonts.googleapis.com/css2?family=Noto+Serif+JP:wght@400;500;600;700&display=swap',
    philosophy: 'Beauty in imperfection. Stillness as presence.',
  },

  color: {
    primary: {
      '50': { $value: '#33392e', $type: 'color' },
      '100': { $value: '#3b4434', $type: 'color' },
      '200': { $value: '#48543d', $type: 'color' },
      '300': { $value: '#5c6b4c', $type: 'color' },
      '400': { $value: '#748660', $type: 'color' },
      '500': { $value: '#93a17c', $type: 'color' }, // lifted moss for dark
      '600': { $value: '#b3bda1', $type: 'color' },
      '700': { $value: '#d1d7c5', $type: 'color' },
      '800': { $value: '#e8ebe2', $type: 'color' },
      '900': { $value: '#f6f7f4', $type: 'color' },
    },
    neutral: {
      '50': { $value: '#1a1816', $type: 'color' }, // deep stone base
      '100': { $value: '#2a2724', $type: 'color' },
      '200': { $value: '#3e3a36', $type: 'color' },
      '300': { $value: '#5e5650', $type: 'color' },
      '400': { $value: '#7a7068', $type: 'color' },
      '500': { $value: '#9a9084', $type: 'color' },
      '600': { $value: '#b8b0a4', $type: 'color' },
      '700': { $value: '#d5d0c8', $type: 'color' },
      '800': { $value: '#e7e4de', $type: 'color' },
      '900': { $value: '#faf9f7', $type: 'color' }, // off-cream
    },
    // Semantic colors — held to similar low saturation as light variant.
    success: { $value: '#8aab7a', $type: 'color' },
    warning: { $value: '#d8b96a', $type: 'color' },
    error: { $value: '#cf6f6a', $type: 'color' },
    info: { $value: '#8eaab8', $type: 'color' },
    surface: { $value: '#2a2724', $type: 'color' },
    onSurface: { $value: '#f3f1ed', $type: 'color' }, // muted off-cream, not pure white
    surfaceVariant: { $value: '#3e3a36', $type: 'color' },
    onSurfaceVariant: { $value: '#b8b0a4', $type: 'color' },
    container: { $value: '#48543d', $type: 'color' }, // deep moss
    onContainer: { $value: '#e8ebe2', $type: 'color' }, // primary-100 in dark tree
    outline: { $value: '#5e5650', $type: 'color' },
    outlineVariant: { $value: '#3e3a36', $type: 'color' },
  },

  font: shared.font,
  spacing: shared.spacing,
  shape: shared.shape,
  motion: shared.motion,

  canvas: {
    mode: { $value: 'mesh', $type: 'string' },
    speed: { $value: 0.3, $type: 'number' },
    colors: {
      $value: [
        'rgba(147, 161, 124, 0.10)',
        'rgba(185, 176, 164, 0.07)',
        'rgba(213, 208, 200, 0.05)',
      ],
      $type: 'array',
    },
    background: { $value: '#1a1816', $type: 'color' },
  },
};

/** Zen registration — both modes ship from day one. */
export const theme = {
  light: zenLight,
  dark: zenDark,
} as const;
