import type { ContainerProps } from './types';
import { maxWidth as maxWidthTokens } from '../tokens/spacing';
import { resolveSpacing } from './spacing-scale';

const maxWidthMap: Record<string, string> = {
  xs: maxWidthTokens.xs,
  sm: maxWidthTokens.sm,
  md: maxWidthTokens.md,
  lg: maxWidthTokens.lg,
  xl: maxWidthTokens.xl,
  '2xl': maxWidthTokens['2xl'],
  '3xl': maxWidthTokens['3xl'],
  full: maxWidthTokens.full,
};

/**
 * Container - A layout primitive for constraining content width
 */
export function Container({
  children,
  maxWidth = 'lg',
  center = true,
  padding,
  style,
  className,
}: ContainerProps) {
  const resolvedMaxWidth = maxWidthMap[maxWidth] || maxWidth;
  const resolvedPadding = resolveSpacing(padding);

  return (
    <div
      className={className}
      style={{
        maxWidth: resolvedMaxWidth,
        margin: center ? '0 auto' : undefined,
        padding: resolvedPadding,
        width: '100%',
        ...style,
      }}
    >
      {children}
    </div>
  );
}
