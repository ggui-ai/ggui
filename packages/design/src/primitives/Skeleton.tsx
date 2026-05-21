import type { CSSProperties } from 'react';
import type { SkeletonProps } from './types';
import { resolveRadius } from './radius-scale';

const resolveSize = (value: number | string | undefined): string | undefined =>
  value === undefined ? undefined : typeof value === 'number' ? `${value}px` : value;

/**
 * Skeleton — a pulsing placeholder for content that hasn't loaded yet.
 *
 * ggui UIs are agent-driven: props arrive via `ggui_update` and stream
 * channels start empty, so a loading frame is the rule, not the
 * exception. Reach for `Skeleton` instead of a blank screen or a
 * hand-rolled pulsing `<div>`.
 *
 * The placeholder is decorative (`aria-hidden`) — announce the loading
 * state on the surrounding region (e.g. `aria-busy` on the container).
 */
export function Skeleton({
  variant = 'rect',
  width,
  height,
  radius = 'sm',
  style,
  className,
}: SkeletonProps) {
  const isCircle = variant === 'circle';
  const isText = variant === 'text';

  const resolvedWidth = resolveSize(width) ?? (isCircle ? '2.5rem' : '100%');
  const resolvedHeight =
    resolveSize(height) ??
    (isText ? '1em' : isCircle ? resolvedWidth : '1.25rem');

  const composedStyle: CSSProperties = {
    display: 'block',
    width: resolvedWidth,
    height: resolvedHeight,
    borderRadius: isCircle ? '9999px' : resolveRadius(radius),
    backgroundColor: 'var(--ggui-color-surfaceVariant, #f4f4f5)',
    animation: 'ggui-skeleton-pulse 1.5s ease-in-out infinite',
    ...style,
  };

  return (
    <div className={className} style={composedStyle} aria-hidden="true">
      <style>
        {`@keyframes ggui-skeleton-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }`}
      </style>
    </div>
  );
}
