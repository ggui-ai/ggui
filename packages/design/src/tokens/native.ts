/**
 * Native Design Tokens
 *
 * Plain JS objects for React Native consumption.
 * No CSS syntax (var(), px units) — only raw numbers and hex strings.
 * Mirrors the DTCG theme structure for consistency.
 */

/** Light theme colors (sky blue primary, light backgrounds) */
const lightColors = {
  // Primary
  primary50: '#f0f9ff',
  primary100: '#e0f2fe',
  primary200: '#bae6fd',
  primary300: '#7dd3fc',
  primary400: '#38bdf8',
  primary500: '#0ea5e9',
  primary600: '#0284c7',
  primary700: '#0369a1',
  primary800: '#075985',
  primary900: '#0c4a6e',
  // Gray
  gray50: '#f9fafb',
  gray100: '#f3f4f6',
  gray200: '#e5e7eb',
  gray300: '#d1d5db',
  gray400: '#9ca3af',
  gray500: '#6b7280',
  gray600: '#4b5563',
  gray700: '#374151',
  gray800: '#1f2937',
  gray900: '#111827',
  // Info
  info50: '#ecfeff',
  info100: '#cffafe',
  info200: '#a5f3fc',
  info500: '#06b6d4',
  info600: '#0891b2',
  info700: '#0e7490',
  info800: '#155e75',
  // Success
  success50: '#f0fdf4',
  success100: '#dcfce7',
  success200: '#bbf7d0',
  success500: '#22c55e',
  success600: '#16a34a',
  success700: '#15803d',
  success800: '#166534',
  // Warning
  warning50: '#fffbeb',
  warning100: '#fef3c7',
  warning200: '#fde68a',
  warning500: '#f59e0b',
  warning600: '#d97706',
  warning700: '#b45309',
  warning800: '#92400e',
  // Error
  error50: '#fef2f2',
  error100: '#fee2e2',
  error200: '#fecaca',
  error500: '#ef4444',
  error600: '#dc2626',
  error700: '#b91c1c',
  error800: '#991b1b',
  // Semantic
  background: '#ffffff',
  surface: '#ffffff',
  textPrimary: '#111827',
  textSecondary: '#6b7280',
  textDisabled: '#d1d5db',
  white: '#ffffff',
  black: '#000000',
} as const;

/** Dark theme colors (inverted scale, dark backgrounds) */
const darkColors = {
  // Primary (inverted for dark mode)
  primary50: '#0c4a6e',
  primary100: '#075985',
  primary200: '#0369a1',
  primary300: '#0284c7',
  primary400: '#0ea5e9',
  primary500: '#38bdf8',
  primary600: '#7dd3fc',
  primary700: '#bae6fd',
  primary800: '#e0f2fe',
  primary900: '#f0f9ff',
  // Gray (inverted for dark mode)
  gray50: '#111827',
  gray100: '#1f2937',
  gray200: '#374151',
  gray300: '#4b5563',
  gray400: '#6b7280',
  gray500: '#9ca3af',
  gray600: '#d1d5db',
  gray700: '#e5e7eb',
  gray800: '#f3f4f6',
  gray900: '#f9fafb',
  // Info
  info50: '#083344',
  info100: '#164e63',
  info200: '#155e75',
  info500: '#06b6d4',
  info600: '#22d3ee',
  info700: '#67e8f9',
  info800: '#a5f3fc',
  // Success
  success50: '#052e16',
  success100: '#14532d',
  success200: '#166534',
  success500: '#22c55e',
  success600: '#4ade80',
  success700: '#86efac',
  success800: '#bbf7d0',
  // Warning
  warning50: '#451a03',
  warning100: '#78350f',
  warning200: '#92400e',
  warning500: '#f59e0b',
  warning600: '#fbbf24',
  warning700: '#fcd34d',
  warning800: '#fde68a',
  // Error
  error50: '#450a0a',
  error100: '#7f1d1d',
  error200: '#991b1b',
  error500: '#ef4444',
  error600: '#f87171',
  error700: '#fca5a5',
  error800: '#fecaca',
  // Semantic
  background: '#0f172a',
  surface: '#1e293b',
  textPrimary: '#f1f5f9',
  textSecondary: '#94a3b8',
  textDisabled: '#475569',
  white: '#ffffff',
  black: '#000000',
} as const;

/** Spacing values in density-independent pixels (numbers) */
const spacingTokens = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  '2xl': 48,
  '3xl': 64,
} as const;

/** Typography tokens — raw values for StyleSheet */
const typographyTokens = {
  fontFamily: {
    sans: 'System',
    mono: 'Courier',
  },
  fontSize: {
    xs: 12,
    sm: 14,
    base: 16,
    lg: 18,
    xl: 20,
    '2xl': 24,
    '3xl': 30,
    '4xl': 36,
  },
  fontWeight: {
    normal: '400' as const,
    medium: '500' as const,
    semibold: '600' as const,
    bold: '700' as const,
  },
  lineHeight: {
    tight: 20,
    normal: 24,
    relaxed: 28,
  },
} as const;

/** Shadow definitions for React Native (elevation + shadow props) */
const shadowTokens = {
  sm: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  md: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 6,
    elevation: 3,
  },
  lg: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.1,
    shadowRadius: 15,
    elevation: 6,
  },
  xl: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 20 },
    shadowOpacity: 0.1,
    shadowRadius: 25,
    elevation: 10,
  },
  '2xl': {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 25 },
    shadowOpacity: 0.25,
    shadowRadius: 50,
    elevation: 15,
  },
} as const;

/** Dark-mode shadow overrides (higher opacity for dark backgrounds) */
const darkShadowTokens = {
  sm: {
    ...shadowTokens.sm,
    shadowOpacity: 0.3,
  },
  md: {
    ...shadowTokens.md,
    shadowOpacity: 0.4,
  },
  lg: {
    ...shadowTokens.lg,
    shadowOpacity: 0.4,
  },
  xl: {
    ...shadowTokens.xl,
    shadowOpacity: 0.5,
  },
  '2xl': {
    ...shadowTokens['2xl'],
    shadowOpacity: 0.6,
  },
} as const;

/** Duration values in milliseconds (numbers for Animated API) */
const durationTokens = {
  instant: 0,
  fast: 100,
  normal: 200,
  slow: 300,
  slower: 500,
} as const;

/** Easing bezier control points for React Native Animated.timing */
const easingTokens = {
  linear: [0, 0, 1, 1] as const,
  easeIn: [0.4, 0, 1, 1] as const,
  easeOut: [0, 0, 0.2, 1] as const,
  easeInOut: [0.4, 0, 0.2, 1] as const,
  spring: [0.175, 0.885, 0.32, 1.275] as const,
} as const;

/** Border radius values (numbers) */
const radiusTokens = {
  none: 0,
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  '2xl': 24,
  full: 9999,
} as const;

/**
 * Complete native token set organized by theme.
 *
 * Usage in React Native:
 * ```ts
 * import { nativeTokens } from '@ggui-ai/design/tokens';
 *
 * const styles = StyleSheet.create({
 *   container: {
 *     backgroundColor: nativeTokens.light.colors.background,
 *     padding: nativeTokens.light.spacing.md,
 *     borderRadius: nativeTokens.light.radius.lg,
 *     ...nativeTokens.light.shadows.md,
 *   },
 * });
 * ```
 */
export const nativeTokens = {
  light: {
    colors: lightColors,
    spacing: spacingTokens,
    typography: typographyTokens,
    shadows: shadowTokens,
    radius: radiusTokens,
    duration: durationTokens,
    easing: easingTokens,
  },
  dark: {
    colors: darkColors,
    spacing: spacingTokens,
    typography: typographyTokens,
    shadows: darkShadowTokens,
    radius: radiusTokens,
    duration: durationTokens,
    easing: easingTokens,
  },
} as const;

export type NativeTokens = typeof nativeTokens;
export type NativeTheme = (typeof nativeTokens)['light'];
export type NativeColors = typeof lightColors;
export type NativeShadow = (typeof shadowTokens)[keyof typeof shadowTokens];
