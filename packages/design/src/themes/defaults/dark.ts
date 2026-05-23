/**
 * Default Dark Theme
 *
 * Professional dark theme with excellent contrast ratios and
 * modern dark mode aesthetics. Companion to {@link lightTheme}.
 */

import type { DtcgTheme } from '../types';

export const darkTheme: DtcgTheme = {
  $name: 'Default Dark',
  $description:
    'ggui default dark theme — sky-blue primary lifted for dark, slate neutrals, WCAG-AA contrast.',

  color: {
    primary: {
      '50': { $type: 'color', $value: '#0c4a6e' },
      '100': { $type: 'color', $value: '#075985' },
      '200': { $type: 'color', $value: '#0369a1' },
      '300': { $type: 'color', $value: '#0284c7' },
      '400': { $type: 'color', $value: '#0ea5e9' },
      '500': { $type: 'color', $value: '#38bdf8' },
      '600': { $type: 'color', $value: '#7dd3fc' },
      '700': { $type: 'color', $value: '#bae6fd' },
      '800': { $type: 'color', $value: '#e0f2fe' },
      '900': { $type: 'color', $value: '#f0f9ff' },
    },
    neutral: {
      '50': { $type: 'color', $value: '#111827' },
      '100': { $type: 'color', $value: '#1f2937' },
      '200': { $type: 'color', $value: '#374151' },
      '300': { $type: 'color', $value: '#4b5563' },
      '400': { $type: 'color', $value: '#6b7280' },
      '500': { $type: 'color', $value: '#9ca3af' },
      '600': { $type: 'color', $value: '#d1d5db' },
      '700': { $type: 'color', $value: '#e5e7eb' },
      '800': { $type: 'color', $value: '#f3f4f6' },
      '900': { $type: 'color', $value: '#f9fafb' },
    },
    info: {
      '50': { $type: 'color', $value: '#083344' },
      '100': { $type: 'color', $value: '#164e63' },
      '200': { $type: 'color', $value: '#155e75' },
      '500': { $type: 'color', $value: '#06b6d4' },
      '600': { $type: 'color', $value: '#22d3ee' },
      '700': { $type: 'color', $value: '#67e8f9' },
      '800': { $type: 'color', $value: '#a5f3fc' },
    },
    success: {
      '50': { $type: 'color', $value: '#052e16' },
      '100': { $type: 'color', $value: '#14532d' },
      '200': { $type: 'color', $value: '#166534' },
      '500': { $type: 'color', $value: '#22c55e' },
      '600': { $type: 'color', $value: '#4ade80' },
      '700': { $type: 'color', $value: '#86efac' },
      '800': { $type: 'color', $value: '#bbf7d0' },
    },
    warning: {
      '50': { $type: 'color', $value: '#451a03' },
      '100': { $type: 'color', $value: '#78350f' },
      '200': { $type: 'color', $value: '#92400e' },
      '500': { $type: 'color', $value: '#f59e0b' },
      '600': { $type: 'color', $value: '#fbbf24' },
      '700': { $type: 'color', $value: '#fcd34d' },
      '800': { $type: 'color', $value: '#fde68a' },
    },
    error: {
      '50': { $type: 'color', $value: '#450a0a' },
      '100': { $type: 'color', $value: '#7f1d1d' },
      '200': { $type: 'color', $value: '#991b1b' },
      '500': { $type: 'color', $value: '#ef4444' },
      '600': { $type: 'color', $value: '#f87171' },
      '700': { $type: 'color', $value: '#fca5a5' },
      '800': { $type: 'color', $value: '#fecaca' },
    },
    surface: { $type: 'color', $value: '#1e293b' },
    onSurface: { $type: 'color', $value: '#f1f5f9' },
    surfaceVariant: { $type: 'color', $value: '#334155' },
    onSurfaceVariant: { $type: 'color', $value: '#94a3b8' },
    container: { $type: 'color', $value: '#0f172a' },
    onContainer: { $type: 'color', $value: '#f1f5f9' },
    outline: { $type: 'color', $value: '#64748b' },
    outlineVariant: { $type: 'color', $value: '#475569' },
    // Primary role pair — dark mode inverts: text on primary surface is the
    // darkest primary stop; primaryContainer is the deepest primary tint.
    onPrimary: { $type: 'color', $value: '#0c4a6e' }, // primary-50 in dark ladder = sky-900 hex
    primaryContainer: { $type: 'color', $value: '#075985' }, // primary-100 dark = sky-800 hex
    onPrimaryContainer: { $type: 'color', $value: '#e0f2fe' }, // primary-800 dark = sky-100 hex
    // Error role pair — same inversion.
    onError: { $type: 'color', $value: '#450a0a' },
    errorContainer: { $type: 'color', $value: '#7f1d1d' }, // error-100 dark
    onErrorContainer: { $type: 'color', $value: '#fecaca' }, // error-800 dark
    // Tertiary role — teal complement, lifted for dark contrast on slate.
    tertiary: { $type: 'color', $value: '#2dd4bf' }, // teal-400
    onTertiary: { $type: 'color', $value: '#042f2e' }, // teal-950
    tertiaryContainer: { $type: 'color', $value: '#115e59' }, // teal-800
    onTertiaryContainer: { $type: 'color', $value: '#ccfbf1' }, // teal-100
  },

  font: {
    family: {
      sans: {
        $type: 'fontFamily',
        $value:
          'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      },
      mono: {
        $type: 'fontFamily',
        $value:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      },
    },
    size: {
      xs: { $type: 'dimension', $value: '12px' },
      sm: { $type: 'dimension', $value: '14px' },
      base: { $type: 'dimension', $value: '16px' },
      lg: { $type: 'dimension', $value: '18px' },
      xl: { $type: 'dimension', $value: '20px' },
      '2xl': { $type: 'dimension', $value: '24px' },
      '3xl': { $type: 'dimension', $value: '30px' },
      '4xl': { $type: 'dimension', $value: '36px' },
    },
    weight: {
      normal: { $type: 'fontWeight', $value: '400' },
      medium: { $type: 'fontWeight', $value: '500' },
      semibold: { $type: 'fontWeight', $value: '600' },
      bold: { $type: 'fontWeight', $value: '700' },
    },
    lineHeight: {
      tight: { $type: 'number', $value: '1.25' },
      normal: { $type: 'number', $value: '1.5' },
      relaxed: { $type: 'number', $value: '1.75' },
    },
  },

  spacing: {
    xs: { $type: 'dimension', $value: '4px' },
    sm: { $type: 'dimension', $value: '8px' },
    md: { $type: 'dimension', $value: '16px' },
    lg: { $type: 'dimension', $value: '24px' },
    xl: { $type: 'dimension', $value: '32px' },
    '2xl': { $type: 'dimension', $value: '48px' },
    '3xl': { $type: 'dimension', $value: '64px' },
  },

  shape: {
    radius: {
      none: { $type: 'dimension', $value: '0' },
      sm: { $type: 'dimension', $value: '4px' },
      md: { $type: 'dimension', $value: '8px' },
      lg: { $type: 'dimension', $value: '12px' },
      xl: { $type: 'dimension', $value: '16px' },
      '2xl': { $type: 'dimension', $value: '24px' },
      full: { $type: 'dimension', $value: '9999px' },
    },
    shadow: {
      none: { $type: 'shadow', $value: '0 0 0 0 transparent' },
      xs: { $type: 'shadow', $value: '0 1px 2px 0 rgba(0, 0, 0, 0.20)' },
      sm: { $type: 'shadow', $value: '0 1px 3px 0 rgba(0, 0, 0, 0.30)' },
      md: { $type: 'shadow', $value: '0 8px 16px -4px rgba(0, 0, 0, 0.40)' },
      lg: { $type: 'shadow', $value: '0 16px 32px -8px rgba(0, 0, 0, 0.50)' },
      xl: { $type: 'shadow', $value: '0 24px 48px -12px rgba(0, 0, 0, 0.60)' },
      '2xl': { $type: 'shadow', $value: '0 25px 50px -12px rgba(0, 0, 0, 0.60)' },
    },
  },

  motion: {
    duration: {
      instant: { $type: 'duration', $value: '0ms' },
      fast: { $type: 'duration', $value: '100ms' },
      normal: { $type: 'duration', $value: '200ms' },
      slow: { $type: 'duration', $value: '300ms' },
      slower: { $type: 'duration', $value: '500ms' },
    },
    easing: {
      default: { $type: 'cubicBezier', $value: 'cubic-bezier(0.4, 0, 0.2, 1)' },
      easeOut: { $type: 'cubicBezier', $value: 'cubic-bezier(0, 0, 0.2, 1)' },
      easeIn: { $type: 'cubicBezier', $value: 'cubic-bezier(0.4, 0, 1, 1)' },
    },
    transition: {
      fast: { $type: 'transition', $value: '100ms cubic-bezier(0.4, 0, 0.2, 1)' },
      normal: { $type: 'transition', $value: '200ms cubic-bezier(0.4, 0, 0.2, 1)' },
      slow: { $type: 'transition', $value: '300ms cubic-bezier(0.4, 0, 0.2, 1)' },
      colors: {
        $type: 'transition',
        $value: 'color 200ms cubic-bezier(0.4, 0, 0.2, 1), background-color 200ms cubic-bezier(0.4, 0, 0.2, 1), border-color 200ms cubic-bezier(0.4, 0, 0.2, 1)',
      },
      opacity: { $type: 'transition', $value: 'opacity 200ms cubic-bezier(0.4, 0, 0.2, 1)' },
      transform: { $type: 'transition', $value: 'transform 200ms cubic-bezier(0, 0, 0.2, 1)' },
    },
    keyframes: {},
  },

  canvas: {
    mode: { $type: 'string', $value: 'none' },
    speed: { $type: 'number', $value: 0 },
    colors: { $type: 'array', $value: [] },
    background: { $type: 'color', $value: '#0f172a' },
  },

  accessibility: {
    focusRing: {
      color: { $type: 'color', $value: '#38bdf8' },
      width: { $type: 'dimension', $value: '2px' },
      offset: { $type: 'dimension', $value: '2px' },
    },
    reducedMotion: {
      duration: { $type: 'duration', $value: '0ms' },
    },
    highContrast: {
      borderWidth: { $type: 'dimension', $value: '2px' },
      textColor: { $type: 'color', $value: '#f1f5f9' },
      backgroundColor: { $type: 'color', $value: '#0f172a' },
      linkColor: { $type: 'color', $value: '#7dd3fc' },
    },
  },

  zIndex: {
    hide: { $type: 'number', $value: -1 },
    base: { $type: 'number', $value: 0 },
    docked: { $type: 'number', $value: 10 },
    dropdown: { $type: 'number', $value: 1000 },
    sticky: { $type: 'number', $value: 1100 },
    banner: { $type: 'number', $value: 1200 },
    overlay: { $type: 'number', $value: 1300 },
    modal: { $type: 'number', $value: 1400 },
    popover: { $type: 'number', $value: 1500 },
    skipLink: { $type: 'number', $value: 1600 },
    toast: { $type: 'number', $value: 1700 },
    tooltip: { $type: 'number', $value: 1800 },
  },
};
