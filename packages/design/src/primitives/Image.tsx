import { useState } from 'react';
import type { ImageProps } from './types';
import { resolveRadius } from './radius-scale';

/**
 * Image - An image primitive with fallback support
 */
export function Image({
  src,
  alt,
  width,
  height,
  objectFit = 'cover',
  radius,
  fallback,
  style,
  className,
}: ImageProps) {
  const [error, setError] = useState(false);

  const resolveSize = (value: number | string | undefined) => {
    if (value === undefined) return undefined;
    return typeof value === 'number' ? `${value}px` : value;
  };

  if (error && fallback) {
    return <>{fallback}</>;
  }

  if (error) {
    return (
      <div
        role="img"
        aria-label={`${alt} (failed to load)`}
        className={className}
        style={{
          width: resolveSize(width) || '100%',
          height: resolveSize(height) || 'auto',
          borderRadius: resolveRadius(radius),
          backgroundColor: 'var(--ggui-color-surfaceVariant, #f4f4f5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--ggui-color-outline, #d4d4d8)',
          ...style,
        }}
      >
        <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor">
          <path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z" />
        </svg>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      onError={() => setError(true)}
      className={className}
      style={{
        width: resolveSize(width) || '100%',
        height: resolveSize(height) || 'auto',
        objectFit,
        borderRadius: resolveRadius(radius),
        display: 'block',
        ...style,
      }}
    />
  );
}
