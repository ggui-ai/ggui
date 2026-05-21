/**
 * Motion Token System
 *
 * CSS keyframe definitions, animation shorthands, and reduced-motion support.
 *
 * Two categories of animations:
 * - **Entrance/exit**: GPU-composited (transform + opacity) for smooth mount/unmount
 * - **State feedback**: Color-based (background-color) for data-change highlights
 *
 * All animations are automatically disabled for `prefers-reduced-motion: reduce`
 * via the `reducedMotionCSS` block injected by `<MotionKeyframes />`.
 */

import { duration, easing } from './transitions';

/** CSS @keyframes definitions as raw strings (for injection via <style>) */
export const keyframes = {
  // ── Entrance / Exit (GPU-composited: transform + opacity) ──
  fadeIn: `@keyframes ggui-fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}`,
  fadeOut: `@keyframes ggui-fadeOut {
  from { opacity: 1; }
  to { opacity: 0; }
}`,
  slideInUp: `@keyframes ggui-slideInUp {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}`,
  slideInDown: `@keyframes ggui-slideInDown {
  from { opacity: 0; transform: translateY(-8px); }
  to { opacity: 1; transform: translateY(0); }
}`,
  scaleIn: `@keyframes ggui-scaleIn {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}`,
  scaleOut: `@keyframes ggui-scaleOut {
  from { opacity: 1; transform: scale(1); }
  to { opacity: 0; transform: scale(0.95); }
}`,

  // ── State Feedback (color-based, for data-change highlights) ──

  /** Flash highlight — brief background-color pulse then fade out.
   *  Customize color via CSS variable `--ggui-flash-color` on the element.
   *  Default: var(--ggui-color-primary-100). */
  flash: `@keyframes ggui-flash {
  0%, 15% { background-color: var(--ggui-flash-color, var(--ggui-color-primary-100)); }
  100% { background-color: transparent; }
}`,

  /** Pulse — gentle opacity breathing for "live" or "updating" indicators. */
  pulse: `@keyframes ggui-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}`,

  /** Bounce — subtle scale overshoot for success/confirmation feedback. */
  bounce: `@keyframes ggui-bounce {
  0% { transform: scale(1); }
  40% { transform: scale(1.06); }
  70% { transform: scale(0.98); }
  100% { transform: scale(1); }
}`,
} as const;

/** Animation shorthand values referencing the keyframes above */
export const animation = {
  // Entrance / exit
  fadeIn: `ggui-fadeIn ${duration.normal} ${easing.easeOut} both`,
  fadeOut: `ggui-fadeOut ${duration.normal} ${easing.easeIn} both`,
  slideInUp: `ggui-slideInUp ${duration.normal} ${easing.easeOut} both`,
  slideInDown: `ggui-slideInDown ${duration.normal} ${easing.easeOut} both`,
  scaleIn: `ggui-scaleIn ${duration.normal} ${easing.easeOut} both`,
  scaleOut: `ggui-scaleOut ${duration.fast} ${easing.easeIn} both`,
  // State feedback
  flash: `ggui-flash ${duration.slow} ${easing.easeOut}`,
  pulse: `ggui-pulse 2s ${easing.easeInOut} infinite`,
  bounce: `ggui-bounce ${duration.slow} ${easing.spring}`,
} as const;

// ── Thinking Indicator: Generation Indicator Animations ──
// Predefined animation presets for the thinking indicator shown during UI generation.
// Each preset defines how the indicator message transitions, the loading effect,
// and the progress pulse. Themes can select a preset via `thinkingIndicatorStyle`.

/** Thinking indicator keyframes — injected via <style> in shell components */
export const thinkingKeyframes = {
  // Text transition: crossfade (default)
  textIn: `@keyframes ggui-thinking-text-in {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}`,
  textOut: `@keyframes ggui-thinking-text-out {
  from { opacity: 1; transform: translateY(0); }
  to   { opacity: 0; transform: translateY(-6px); }
}`,
  // Shimmer: light sweep across indicator card
  shimmer: `@keyframes ggui-thinking-shimmer {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(200%); }
}`,
  // Pulse: subtle opacity pulse on progress label
  pulse: `@keyframes ggui-thinking-pulse {
  0%, 100% { opacity: 0.5; }
  50%      { opacity: 1; }
}`,
  // Wave: flowing wave motion (alternative to shimmer)
  wave: `@keyframes ggui-thinking-wave {
  0%   { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}`,
  // Breathe: gentle scale pulse (alternative to pulse)
  breathe: `@keyframes ggui-thinking-breathe {
  0%, 100% { transform: scale(1); opacity: 0.6; }
  50%      { transform: scale(1.02); opacity: 1; }
}`,
  // Typewriter: cursor blink for text-style indicators
  cursor: `@keyframes ggui-thinking-cursor {
  0%, 100% { border-right-color: currentColor; }
  50%      { border-right-color: transparent; }
}`,
} as const;

/** Thinking indicator animation shorthands */
export const thinkingAnimation = {
  textIn: `ggui-thinking-text-in ${duration.slow} ${easing.easeOut} forwards`,
  textOut: `ggui-thinking-text-out ${duration.normal} ${easing.easeIn} forwards`,
  shimmer: `ggui-thinking-shimmer 3s ${easing.easeInOut} infinite`,
  pulse: `ggui-thinking-pulse 2s ${easing.easeInOut} infinite`,
  wave: `ggui-thinking-wave 2s ${easing.linear} infinite`,
  breathe: `ggui-thinking-breathe 3s ${easing.easeInOut} infinite`,
  cursor: `ggui-thinking-cursor 1s step-end infinite`,
} as const;

/**
 * Thinking indicator style presets.
 * Each preset selects which animations to use for different indicator parts.
 * Themes can override the default by specifying `thinkingIndicatorStyle`.
 */
export type ThinkingIndicatorStyle = 'shimmer' | 'wave' | 'pulse' | 'breathe' | 'minimal';

export interface ThinkingIndicatorPreset {
  /** CSS animation for the background loading effect */
  background: string;
  /** CSS animation for the progress label */
  progressLabel: string;
  /** CSS animation for message entering */
  messageIn: string;
  /** CSS animation for message exiting */
  messageOut: string;
  /** Keyframes CSS to inject (combined string) */
  keyframesCss: string;
}

export const thinkingPresets: Record<ThinkingIndicatorStyle, ThinkingIndicatorPreset> = {
  shimmer: {
    background: thinkingAnimation.shimmer,
    progressLabel: thinkingAnimation.pulse,
    messageIn: thinkingAnimation.textIn,
    messageOut: thinkingAnimation.textOut,
    keyframesCss: [thinkingKeyframes.shimmer, thinkingKeyframes.pulse, thinkingKeyframes.textIn, thinkingKeyframes.textOut].join('\n'),
  },
  wave: {
    background: thinkingAnimation.wave,
    progressLabel: thinkingAnimation.pulse,
    messageIn: thinkingAnimation.textIn,
    messageOut: thinkingAnimation.textOut,
    keyframesCss: [thinkingKeyframes.wave, thinkingKeyframes.pulse, thinkingKeyframes.textIn, thinkingKeyframes.textOut].join('\n'),
  },
  pulse: {
    background: thinkingAnimation.pulse,
    progressLabel: thinkingAnimation.breathe,
    messageIn: thinkingAnimation.textIn,
    messageOut: thinkingAnimation.textOut,
    keyframesCss: [thinkingKeyframes.pulse, thinkingKeyframes.breathe, thinkingKeyframes.textIn, thinkingKeyframes.textOut].join('\n'),
  },
  breathe: {
    background: thinkingAnimation.breathe,
    progressLabel: thinkingAnimation.pulse,
    messageIn: thinkingAnimation.textIn,
    messageOut: thinkingAnimation.textOut,
    keyframesCss: [thinkingKeyframes.breathe, thinkingKeyframes.pulse, thinkingKeyframes.textIn, thinkingKeyframes.textOut].join('\n'),
  },
  minimal: {
    background: 'none',
    progressLabel: thinkingAnimation.pulse,
    messageIn: `ggui-fadeIn ${duration.normal} ${easing.easeOut} both`,
    messageOut: `ggui-fadeOut ${duration.fast} ${easing.easeIn} both`,
    keyframesCss: [thinkingKeyframes.pulse, keyframes.fadeIn, keyframes.fadeOut].join('\n'),
  },
};

/** Default thinking indicator style */
export const THINKING_DEFAULT_STYLE: ThinkingIndicatorStyle = 'shimmer';

/** CSS block that disables all animations/transitions for reduced-motion users */
export const reducedMotionCSS = `@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}`;

/**
 * Returns 'none' if user prefers reduced motion, otherwise returns the transition string.
 * Only works at runtime (requires window.matchMedia).
 */
export function motionSafe(transitionValue: string): string {
  if (typeof window === 'undefined') return transitionValue;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 'none'
    : transitionValue;
}
