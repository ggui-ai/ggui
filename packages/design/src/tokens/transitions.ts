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

/**
 * ggui#1106 — the tempo a card READS. Six CSS variables the theme layer always
 * emits (`deriveThemeVariables`): the layer-1 scale above by default, a host's
 * stated `motion.duration` / `motion.easing` when the document carries one.
 * Every `transition` a primitive declares is composed from THESE, never from the
 * constants, so a host's tempo reaches the card. Keyframe animations (spinners,
 * pulses, shimmers) are not on the tempo scale and keep the constants.
 * Literal names on purpose: the consumed-token manifest is derived by scanning
 * source for `var(--ggui-…`.
 */
export const motionVar = {
  duration: {
    fast: 'var(--ggui-motion-duration-fast)',
    base: 'var(--ggui-motion-duration-base)',
    slow: 'var(--ggui-motion-duration-slow)',
  },
  easing: {
    /** The system's ease-in-out — the default for colour, border and size changes. */
    standard: 'var(--ggui-motion-easing-standard)',
    /** The decelerating arrival — transforms and entrances. */
    emphasized: 'var(--ggui-motion-easing-emphasized)',
    /** The accelerating departure. */
    exit: 'var(--ggui-motion-easing-exit)',
  },
} as const;

/** Transition presets combining duration + easing — composed from the tempo VARIABLES (ggui#1106). */
export const transition = {
  none: 'none',
  fast: `${motionVar.duration.fast} ${motionVar.easing.standard}`,
  normal: `${motionVar.duration.base} ${motionVar.easing.standard}`,
  slow: `${motionVar.duration.slow} ${motionVar.easing.standard}`,
  colors: `color ${motionVar.duration.base} ${motionVar.easing.standard}, background-color ${motionVar.duration.base} ${motionVar.easing.standard}, border-color ${motionVar.duration.base} ${motionVar.easing.standard}`,
  opacity: `opacity ${motionVar.duration.base} ${motionVar.easing.standard}`,
  transform: `transform ${motionVar.duration.base} ${motionVar.easing.emphasized}`,
} as const;

export type Duration = typeof duration;
export type Easing = typeof easing;
export type Transition = typeof transition;
export type MotionVar = typeof motionVar;
