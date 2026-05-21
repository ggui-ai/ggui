/**
 * Color Tokens
 *
 * A comprehensive color palette for the GGUI design system.
 * Colors are organized by semantic meaning and include shades for flexibility.
 */

/**
 * Primary brand colors - used for primary actions and emphasis
 */
export const primary = {
  50: '#f0f9ff',
  100: '#e0f2fe',
  200: '#bae6fd',
  300: '#7dd3fc',
  400: '#38bdf8',
  500: '#0ea5e9',
  600: '#0284c7',
  700: '#0369a1',
  800: '#075985',
  900: '#0c4a6e',
} as const;

/**
 * Gray scale - used for text, backgrounds, borders
 */
export const gray = {
  50: '#f9fafb',
  100: '#f3f4f6',
  200: '#e5e7eb',
  300: '#d1d5db',
  400: '#9ca3af',
  500: '#6b7280',
  600: '#4b5563',
  700: '#374151',
  800: '#1f2937',
  900: '#111827',
} as const;

/**
 * Success colors - used for positive feedback and confirmations
 */
export const success = {
  50: '#f0fdf4',
  100: '#dcfce7',
  200: '#bbf7d0',
  300: '#86efac',
  400: '#4ade80',
  500: '#22c55e',
  600: '#16a34a',
  700: '#15803d',
  800: '#166534',
  900: '#14532d',
} as const;

/**
 * Warning colors - used for warnings and cautions
 */
export const warning = {
  50: '#fffbeb',
  100: '#fef3c7',
  200: '#fde68a',
  300: '#fcd34d',
  400: '#fbbf24',
  500: '#f59e0b',
  600: '#d97706',
  700: '#b45309',
  800: '#92400e',
  900: '#78350f',
} as const;

/**
 * Error colors - used for errors and destructive actions
 */
export const error = {
  50: '#fef2f2',
  100: '#fee2e2',
  200: '#fecaca',
  300: '#fca5a5',
  400: '#f87171',
  500: '#ef4444',
  600: '#dc2626',
  700: '#b91c1c',
  800: '#991b1b',
  900: '#7f1d1d',
} as const;

/**
 * Info colors - used for informational messages
 */
export const info = {
  50: '#ecfeff',
  100: '#cffafe',
  200: '#a5f3fc',
  300: '#67e8f9',
  400: '#22d3ee',
  500: '#06b6d4',
  600: '#0891b2',
  700: '#0e7490',
  800: '#155e75',
  900: '#164e63',
} as const;

/**
 * Semantic color aliases for common use cases
 */
export const semantic = {
  // Text colors
  textPrimary: gray[900],
  textSecondary: gray[600],
  textMuted: gray[400],
  textInverse: '#ffffff',

  // Background colors
  bgPrimary: '#ffffff',
  bgSecondary: gray[50],
  bgTertiary: gray[100],
  bgInverse: gray[900],

  // Border colors
  borderLight: gray[200],
  borderDefault: gray[300],
  borderDark: gray[400],

  // Interactive states
  focus: primary[500],
  hover: primary[50],
  active: primary[100],
  disabled: gray[300],

  // Status colors
  success: success[500],
  warning: warning[500],
  error: error[500],
  info: info[500],
} as const;

/**
 * Complete colors object
 */
export const colors = {
  primary,
  gray,
  success,
  warning,
  error,
  info,
  semantic,
  // Common shortcuts
  white: '#ffffff',
  black: '#000000',
  transparent: 'transparent',
} as const;

export type Colors = typeof colors;
