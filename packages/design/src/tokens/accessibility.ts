/**
 * Accessibility Tokens
 *
 * Focus ring, reduced motion, and high contrast overrides
 * for WCAG AA+ compliance across the ggui design system.
 */

export const focusRing = {
  color: '#0284c7',
  width: '2px',
  offset: '2px',
  style: 'solid',
} as const;

export const reducedMotion = {
  duration: '0ms',
  transition: 'none',
} as const;

export const highContrast = {
  borderWidth: '2px',
  textColor: '#000000',
  backgroundColor: '#ffffff',
  linkColor: '#0369a1',
} as const;

export const accessibility = {
  focusRing,
  reducedMotion,
  highContrast,
} as const;

export type Accessibility = typeof accessibility;
