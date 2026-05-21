/**
 * Chart Color Tokens
 *
 * Semantic chart color tokens as CSS variable references with fallbacks.
 * Used for data visualizations, status indicators, and analytics charts.
 *
 * These tokens reference the DTCG theme CSS variables and provide
 * meaningful semantic names for chart elements.
 */

export const chartColors = {
  success: 'var(--ggui-color-success-500, #10b981)',
  error: 'var(--ggui-color-error-500, #ef4444)',
  warning: 'var(--ggui-color-warning-500, #f59e0b)',
  info: 'var(--ggui-color-info-500, #06b6d4)',
  primary: 'var(--ggui-color-primary-600, #0284c7)',
  gray: 'var(--ggui-color-neutral-400, #9ca3af)',
  grayLight: 'var(--ggui-color-neutral-200, #e5e7eb)',
  grayDark: 'var(--ggui-color-neutral-600, #4b5563)',
} as const;

export type ChartColors = typeof chartColors;
