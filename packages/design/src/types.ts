import type { CSSProperties, ReactNode } from 'react';

/**
 * Common props shared across components
 */
export interface BaseProps {
  /** Custom CSS styles */
  style?: CSSProperties;
  /** Additional CSS class name */
  className?: string;
}

/**
 * Props for components that contain children
 */
export interface ContainerBaseProps extends BaseProps {
  children?: ReactNode;
}

/**
 * Size variants used across components
 */
export type Size = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

/**
 * Common color variants
 */
export type ColorVariant = 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'info';

/**
 * Alignment options
 */
export type Alignment = 'start' | 'center' | 'end' | 'stretch';

/**
 * Justify content options
 */
export type JustifyContent = 'start' | 'center' | 'end' | 'between' | 'around' | 'evenly';

/**
 * Flex direction
 */
export type Direction = 'horizontal' | 'vertical';

/**
 * Text alignment
 */
export type TextAlign = 'left' | 'center' | 'right';

/**
 * Font weight
 */
export type FontWeight = 'normal' | 'medium' | 'semibold' | 'bold';

/**
 * Shadow intensity
 */
export type Shadow = 'none' | 'sm' | 'md' | 'lg' | 'xl';

/**
 * Border radius
 */
export type Radius = 'none' | 'sm' | 'md' | 'lg' | 'full';
