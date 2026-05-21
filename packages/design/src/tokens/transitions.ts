/**
 * Transition & Animation Tokens
 *
 * Duration scale, easing curves, and transition presets.
 * Import from '@ggui-ai/design/tokens'
 */

/** Duration scale in milliseconds */
export const duration = {
  instant: '0ms',
  fast: '100ms',
  normal: '200ms',
  slow: '300ms',
  slower: '500ms',
} as const;

/** CSS easing functions */
export const easing = {
  linear: 'linear',
  easeIn: 'cubic-bezier(0.4, 0, 1, 1)',
  easeOut: 'cubic-bezier(0, 0, 0.2, 1)',
  easeInOut: 'cubic-bezier(0.4, 0, 0.2, 1)',
  spring: 'cubic-bezier(0.175, 0.885, 0.32, 1.275)',
} as const;

/** Transition presets combining duration + easing */
export const transition = {
  none: 'none',
  fast: `${duration.fast} ${easing.easeInOut}`,
  normal: `${duration.normal} ${easing.easeInOut}`,
  slow: `${duration.slow} ${easing.easeInOut}`,
  colors: `color ${duration.normal} ${easing.easeInOut}, background-color ${duration.normal} ${easing.easeInOut}, border-color ${duration.normal} ${easing.easeInOut}`,
  opacity: `opacity ${duration.normal} ${easing.easeInOut}`,
  transform: `transform ${duration.normal} ${easing.easeOut}`,
} as const;

export type Duration = typeof duration;
export type Easing = typeof easing;
export type Transition = typeof transition;
