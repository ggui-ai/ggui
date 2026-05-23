/**
 * Default Light Theme
 *
 * Professional, modern light theme optimized for:
 * - Accessibility (WCAG AA contrast ratios)
 * - Modern aesthetics (Sky blue primary, neutral grays)
 * - Professional polish (Subtle shadows, proper spacing)
 * - Versatility (Works for SaaS, dashboards, consumer apps)
 */

import type { DtcgTheme } from '../types';

export const lightTheme: DtcgTheme = {
  $name: 'Default Light',
  $description:
    'ggui default light theme — sky-blue primary, neutral foundation, WCAG-AA contrast, system font stack.',

  color: {
    primary: {
      '50': { $type: 'color', $value: '#f0f9ff' },
      '100': { $type: 'color', $value: '#e0f2fe' },
      '200': { $type: 'color', $value: '#bae6fd' },
      '300': { $type: 'color', $value: '#7dd3fc' },
      '400': { $type: 'color', $value: '#38bdf8' },
      '500': { $type: 'color', $value: '#0ea5e9' },
      '600': { $type: 'color', $value: '#0284c7' },
      '700': { $type: 'color', $value: '#0369a1' },
      '800': { $type: 'color', $value: '#075985' },
      '900': { $type: 'color', $value: '#0c4a6e' },
    },
    neutral: {
      '50': { $type: 'color', $value: '#f9fafb' },
      '100': { $type: 'color', $value: '#f3f4f6' },
      '200': { $type: 'color', $value: '#e5e7eb' },
      '300': { $type: 'color', $value: '#d1d5db' },
      '400': { $type: 'color', $value: '#9ca3af' },
      '500': { $type: 'color', $value: '#6b7280' },
      '600': { $type: 'color', $value: '#4b5563' },
      '700': { $type: 'color', $value: '#374151' },
      '800': { $type: 'color', $value: '#1f2937' },
      '900': { $type: 'color', $value: '#111827' },
    },
    info: {
      '50': { $type: 'color', $value: '#ecfeff' },
      '100': { $type: 'color', $value: '#cffafe' },
      '200': { $type: 'color', $value: '#a5f3fc' },
      '500': { $type: 'color', $value: '#06b6d4' },
      '600': { $type: 'color', $value: '#0891b2' },
      '700': { $type: 'color', $value: '#0e7490' },
      '800': { $type: 'color', $value: '#155e75' },
    },
    success: {
      '50': { $type: 'color', $value: '#f0fdf4' },
      '100': { $type: 'color', $value: '#dcfce7' },
      '200': { $type: 'color', $value: '#bbf7d0' },
      '500': { $type: 'color', $value: '#22c55e' },
      '600': { $type: 'color', $value: '#16a34a' },
      '700': { $type: 'color', $value: '#15803d' },
      '800': { $type: 'color', $value: '#166534' },
    },
    warning: {
      '50': { $type: 'color', $value: '#fffbeb' },
      '100': { $type: 'color', $value: '#fef3c7' },
      '200': { $type: 'color', $value: '#fde68a' },
      '500': { $type: 'color', $value: '#f59e0b' },
      '600': { $type: 'color', $value: '#d97706' },
      '700': { $type: 'color', $value: '#b45309' },
      '800': { $type: 'color', $value: '#92400e' },
    },
    error: {
      '50': { $type: 'color', $value: '#fef2f2' },
      '100': { $type: 'color', $value: '#fee2e2' },
      '200': { $type: 'color', $value: '#fecaca' },
      '500': { $type: 'color', $value: '#ef4444' },
      '600': { $type: 'color', $value: '#dc2626' },
      '700': { $type: 'color', $value: '#b91c1c' },
      '800': { $type: 'color', $value: '#991b1b' },
    },
    // Material 3 semantic role pairs.
    // Mapping decision (B-iii):
    //   background    → surface
    //   text.primary   → onSurface
    //   text.secondary → onSurfaceVariant
    //   text.disabled  → outlineVariant
    surface: { $type: 'color', $value: '#ffffff' },
    onSurface: { $type: 'color', $value: '#111827' },
    surfaceVariant: { $type: 'color', $value: '#f3f4f6' },
    onSurfaceVariant: { $type: 'color', $value: '#6b7280' },
    container: { $type: 'color', $value: '#f9fafb' },
    onContainer: { $type: 'color', $value: '#111827' },
    outline: { $type: 'color', $value: '#9ca3af' },
    outlineVariant: { $type: 'color', $value: '#d1d5db' },
  },

  font: {
    family: {
      // OSS default = system stack. No Google Fonts dependency, no FOUT,
      // works inside CSP-locked iframe sandboxes (claude.ai etc.).
      // Branded fonts (Inter, etc.) live on opt-in premium themes.
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
      xs: { $type: 'shadow', $value: '0 1px 2px 0 rgba(15, 23, 42, 0.04)' },
      sm: { $type: 'shadow', $value: '0 1px 3px 0 rgba(15, 23, 42, 0.06)' },
      md: { $type: 'shadow', $value: '0 8px 16px -4px rgba(15, 23, 42, 0.10)' },
      lg: { $type: 'shadow', $value: '0 16px 32px -8px rgba(15, 23, 42, 0.14)' },
      xl: { $type: 'shadow', $value: '0 24px 48px -12px rgba(15, 23, 42, 0.18)' },
      '2xl': { $type: 'shadow', $value: '0 25px 50px -12px rgba(0, 0, 0, 0.25)' },
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
    background: { $type: 'color', $value: '#ffffff' },
  },

  accessibility: {
    focusRing: {
      color: { $type: 'color', $value: '#0284c7' },
      width: { $type: 'dimension', $value: '2px' },
      offset: { $type: 'dimension', $value: '2px' },
    },
    reducedMotion: {
      duration: { $type: 'duration', $value: '0ms' },
    },
    highContrast: {
      borderWidth: { $type: 'dimension', $value: '2px' },
      textColor: { $type: 'color', $value: '#000000' },
      backgroundColor: { $type: 'color', $value: '#ffffff' },
      linkColor: { $type: 'color', $value: '#0369a1' },
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
