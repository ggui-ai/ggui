/**
 * React Native Design Tokens
 *
 * Converts DTCG/CSS-based design tokens from @ggui-ai/design
 * into React Native-compatible values (numbers, RN shadow format, etc.)
 */

import { colors, semantic, focusRing, reducedMotion, highContrast } from '@ggui-ai/design/tokens';
import { Easing } from 'react-native';

// --- Colors (already plain hex strings, pass through) ---

export const rnColors = {
  primary: colors.primary,
  gray: colors.gray,
  success: colors.success,
  warning: colors.warning,
  error: colors.error,
  info: colors.info,
  white: colors.white,
  black: colors.black,
  transparent: colors.transparent,
} as const;

export const rnSemantic = semantic;

// --- Spacing (numeric values for RN) ---

export const rnSpacing = {
  0: 0,
  0.5: 2,
  1: 4,
  1.5: 6,
  2: 8,
  2.5: 10,
  3: 12,
  3.5: 14,
  4: 16,
  5: 20,
  6: 24,
  7: 28,
  8: 32,
  9: 36,
  10: 40,
  11: 44,
  12: 48,
  14: 56,
  16: 64,
  20: 80,
  24: 96,
} as const;

// Named spacing aliases for ergonomic use
export const rnSpacingNamed = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  '2xl': 48,
  '3xl': 64,
} as const;

// --- Typography (numeric values for RN) ---

export const rnFontSize = {
  xs: 12,
  sm: 14,
  base: 16,
  lg: 18,
  xl: 20,
  '2xl': 24,
  '3xl': 30,
  '4xl': 36,
  '5xl': 48,
  '6xl': 60,
} as const;

export const rnFontWeight = {
  thin: '100' as const,
  extralight: '200' as const,
  light: '300' as const,
  normal: '400' as const,
  medium: '500' as const,
  semibold: '600' as const,
  bold: '700' as const,
  extrabold: '800' as const,
  black: '900' as const,
};

export const rnLineHeight = {
  none: 1,
  tight: 1.25,
  snug: 1.375,
  normal: 1.5,
  relaxed: 1.625,
  loose: 2,
} as const;

// Platform font families (RN uses system fonts, not CSS font stacks)
export const rnFontFamily = {
  sans: undefined, // Uses system default (San Francisco on iOS, Roboto on Android)
  mono: 'monospace' as const, // Platform monospace
} as const;

// --- Border Radius (numeric values for RN) ---

export const rnRadius = {
  none: 0,
  sm: 4,
  md: 6,
  lg: 8,
  xl: 12,
  '2xl': 16,
  '3xl': 24,
  full: 9999,
} as const;

// --- Shadows (RN shadow format) ---

export interface RNShadow {
  shadowColor: string;
  shadowOffset: { width: number; height: number };
  shadowOpacity: number;
  shadowRadius: number;
  elevation: number; // Android
}

export const rnShadow: Record<string, RNShadow> = {
  none: {
    shadowColor: 'transparent',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0,
    shadowRadius: 0,
    elevation: 0,
  },
  sm: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  md: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 6,
    elevation: 3,
  },
  lg: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.1,
    shadowRadius: 15,
    elevation: 6,
  },
  xl: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 20 },
    shadowOpacity: 0.1,
    shadowRadius: 25,
    elevation: 10,
  },
  '2xl': {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 25 },
    shadowOpacity: 0.25,
    shadowRadius: 50,
    elevation: 15,
  },
} as const;

// --- Duration (milliseconds for Animated.timing) ---

export const rnDuration = {
  instant: 0,
  fast: 100,
  normal: 200,
  slow: 300,
  slower: 500,
} as const;

// --- Easing (RN Easing functions mapped to Material Design curves) ---

export const rnEasing = {
  standard: Easing.bezier(0.4, 0, 0.2, 1),
  decelerate: Easing.bezier(0, 0, 0.2, 1),
  accelerate: Easing.bezier(0.4, 0, 1, 1),
  linear: Easing.linear,
} as const;

// --- Transition presets (duration + easing combos for Animated.timing) ---

export const rnTransition = {
  fast: { duration: 100, easing: rnEasing.standard },
  normal: { duration: 200, easing: rnEasing.standard },
  slow: { duration: 300, easing: rnEasing.standard },
  transform: { duration: 200, easing: rnEasing.decelerate },
} as const;

// --- Accessibility (RN-compatible values from design package) ---

export const rnAccessibility = {
  focusRing: {
    color: focusRing.color,
    width: parseFloat(focusRing.width),
    offset: parseFloat(focusRing.offset),
  },
  reducedMotion: {
    duration: parseInt(reducedMotion.duration, 10),
  },
  highContrast: {
    borderWidth: parseFloat(highContrast.borderWidth),
    textColor: highContrast.textColor,
    backgroundColor: highContrast.backgroundColor,
    linkColor: highContrast.linkColor,
  },
} as const;
