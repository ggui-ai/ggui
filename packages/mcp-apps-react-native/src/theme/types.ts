/**
 * React Native Theme Types
 *
 * Typed theme interface for the RN design system.
 * Mirrors the web DTCG theme structure but with RN-compatible values.
 */

import type { RNShadow } from './tokens';

export interface RNThemeColors {
  primary: Record<string, string>;
  gray: Record<string, string>;
  success: Record<string, string>;
  warning: Record<string, string>;
  error: Record<string, string>;
  info: Record<string, string>;
  white: string;
  black: string;
  transparent: string;
}

export interface RNThemeSemantic {
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textInverse: string;
  bgPrimary: string;
  bgSecondary: string;
  bgTertiary: string;
  bgInverse: string;
  borderLight: string;
  borderDefault: string;
  borderDark: string;
  focus: string;
  hover: string;
  active: string;
  disabled: string;
  success: string;
  warning: string;
  error: string;
  info: string;
}

export interface RNTransitionPreset {
  duration: number;
  easing: (t: number) => number;
}

export interface RNAccessibility {
  focusRing: {
    color: string;
    width: number;
    offset: number;
  };
  reducedMotion: {
    duration: number;
  };
  highContrast: {
    borderWidth: number;
    textColor: string;
    backgroundColor: string;
    linkColor: string;
  };
}

export interface RNTheme {
  colorScheme: 'light' | 'dark';
  colors: RNThemeColors;
  semantic: RNThemeSemantic;
  spacing: Record<number, number>;
  spacingNamed: {
    xs: number;
    sm: number;
    md: number;
    lg: number;
    xl: number;
    '2xl': number;
    '3xl': number;
  };
  fontSize: Record<string, number>;
  fontWeight: Record<string, string>;
  lineHeight: Record<string, number>;
  fontFamily: {
    sans: string | undefined;
    mono: string;
  };
  radius: Record<string, number>;
  shadow: Record<string, RNShadow>;
  duration: Record<string, number>;
  easing: Record<string, (t: number) => number>;
  transition: Record<string, RNTransitionPreset>;
  accessibility: RNAccessibility;
  reduceMotionEnabled: boolean;
}
