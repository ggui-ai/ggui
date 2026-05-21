/**
 * Design Tokens
 *
 * The foundational constant values of the GGUI design system.
 * These are platform constants (never per-app) and include colors, spacing,
 * typography, transitions, accessibility, elevation, chart palettes, and
 * motion/animation presets.
 *
 * Import from `@ggui-ai/design/tokens`.
 */

export * from './colors';
export * from './spacing';
export * from './typography';
export * from './transitions';
export * from './native';
export * from './accessibility';
export * from './elevation';
export * from './chart';
export * from './motion';

// Re-export commonly used tokens at top level for convenience
import { colors, semantic } from './colors';
import { spacing, radius, shadow, maxWidth, zIndex } from './spacing';
import { typography, fontFamily, fontSize, fontWeight, lineHeight } from './typography';
import { duration, easing, transition } from './transitions';
import { accessibility } from './accessibility';
import { elevation } from './elevation';
import { chartColors } from './chart';
import { keyframes, animation, reducedMotionCSS, thinkingKeyframes, thinkingAnimation, thinkingPresets, THINKING_DEFAULT_STYLE } from './motion';

/**
 * Complete design tokens object
 */
export const tokens = {
  colors,
  semantic,
  spacing,
  radius,
  shadow,
  maxWidth,
  zIndex,
  typography,
  fontFamily,
  fontSize,
  fontWeight,
  lineHeight,
  duration,
  easing,
  transition,
  accessibility,
  elevation,
  chartColors,
  keyframes,
  animation,
  reducedMotionCSS,
  thinkingKeyframes,
  thinkingAnimation,
  thinkingPresets,
  THINKING_DEFAULT_STYLE,
} as const;

export type Tokens = typeof tokens;
