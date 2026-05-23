/**
 * Shared theme defaults
 *
 * Canonical token blocks every registered theme inherits unless it
 * explicitly overrides them:
 *
 * - {@link standardSemanticScales} — Tailwind-canonical 50/100/200/500/
 *   600/700/800 scales for `success/warning/error/info`. Holds the
 *   semantic-color identity ("success looks like success") constant
 *   across themes; brand differentiation lives in `color.primary`
 *   and `color.neutral`, not the semantic ramps.
 * - {@link standardAccessibility} — WCAG-AA-aligned focus ring,
 *   reduced-motion + high-contrast defaults (light + dark variants).
 * - {@link standardZIndex} — 12-step stacking ladder (hide..tooltip).
 * - {@link standardTransitions} — six composed CSS transition strings
 *   using the standard cubic-bezier easing.
 *
 * Per-theme `shared` consts spread these in. This keeps every theme
 * sharing the same underlying contracts (a11y, z-index, semantic
 * scales) without copy-paste drift.
 */

import type { DtcgToken } from '../types';

/**
 * Tailwind v3 canonical semantic-color scales.
 *
 * Each scale ships 7 stops (50, 100, 200, 500, 600, 700, 800) — the
 * stops actually consumed across `@ggui-ai/design`. Dark-mode variant
 * inverts the ramp (50 = darkest, 800 = lightest) so dark themes can
 * reference the same stop names and get readable shades.
 */
export const standardSemanticScales = {
  light: {
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
    info: {
      '50': { $type: 'color', $value: '#ecfeff' },
      '100': { $type: 'color', $value: '#cffafe' },
      '200': { $type: 'color', $value: '#a5f3fc' },
      '500': { $type: 'color', $value: '#06b6d4' },
      '600': { $type: 'color', $value: '#0891b2' },
      '700': { $type: 'color', $value: '#0e7490' },
      '800': { $type: 'color', $value: '#155e75' },
    },
  },
  dark: {
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
    info: {
      '50': { $type: 'color', $value: '#083344' },
      '100': { $type: 'color', $value: '#164e63' },
      '200': { $type: 'color', $value: '#155e75' },
      '500': { $type: 'color', $value: '#06b6d4' },
      '600': { $type: 'color', $value: '#22d3ee' },
      '700': { $type: 'color', $value: '#67e8f9' },
      '800': { $type: 'color', $value: '#a5f3fc' },
    },
  },
} as const satisfies Record<
  'light' | 'dark',
  Record<'success' | 'warning' | 'error' | 'info', Record<string, DtcgToken>>
>;

/**
 * Standard accessibility token defaults. Themes that need a different
 * focus-ring color or high-contrast palette should spread + override.
 */
export const standardAccessibility = {
  light: {
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
  dark: {
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
} as const;

/**
 * Standard 12-step z-index ladder. Identical across every theme so
 * cross-component stacking (dropdown over sticky over docked) stays
 * consistent regardless of theme.
 */
export const standardZIndex = {
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
} as const satisfies Record<string, DtcgToken<number>>;

/**
 * Standard composed transition shorthands. Themes that ship a longer
 * `motion.duration` (e.g. premium-zen's slow-breathe family) should
 * spread + override `normal`/`slow` to match.
 */
export const standardTransitions = {
  fast: { $type: 'transition', $value: '100ms cubic-bezier(0.4, 0, 0.2, 1)' },
  normal: { $type: 'transition', $value: '200ms cubic-bezier(0.4, 0, 0.2, 1)' },
  slow: { $type: 'transition', $value: '300ms cubic-bezier(0.4, 0, 0.2, 1)' },
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
} as const satisfies Record<string, DtcgToken>;
