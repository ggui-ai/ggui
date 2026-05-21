import { useState } from 'react';
import type { CSSProperties } from 'react';
import type { AvatarProps } from './types';

const sizeMap: Record<string, number> = {
  xs: 24,
  sm: 32,
  md: 40,
  lg: 48,
  xl: 64,
};

const avatarColors = [
  'var(--ggui-color-primary-500, #0ea5e9)',
  'var(--ggui-color-success-500, #22c55e)',
  'var(--ggui-color-warning-500, #f59e0b)',
  'var(--ggui-color-error-500, #ef4444)',
  'var(--ggui-color-info-500, #06b6d4)',
];

/**
 * Avatar - A user or entity representation with image or initials
 */
export function Avatar({
  src,
  name,
  size = 'md',
  shape = 'circle',
  style,
  className,
}: AvatarProps) {
  const [imageError, setImageError] = useState(false);
  const resolvedSize = typeof size === 'number' ? size : sizeMap[size] || 40;

  // Generate initials from name
  const initials = name
    ? name
        .split(' ')
        .map((n) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : '?';

  // Generate a consistent background color based on name
  const getColorFromName = (name: string | undefined) => {
    if (!name) return 'var(--ggui-color-outline, #d4d4d8)';
    const hash = name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return avatarColors[hash % avatarColors.length];
  };

  const showInitials = !src || imageError;

  return (
    <div
      role="img"
      aria-label={name || 'Avatar'}
      className={className}
      style={{
        width: resolvedSize,
        height: resolvedSize,
        borderRadius: shape === 'circle' ? '50%' : 'var(--ggui-shape-radius-md, 8px)',
        backgroundColor: showInitials ? getColorFromName(name) : 'transparent',
        color: '#ffffff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: resolvedSize * 0.4,
        fontWeight: 'var(--ggui-font-weight-semibold, 600)' as CSSProperties['fontWeight'],
        overflow: 'hidden',
        flexShrink: 0,
        ...style,
      }}
    >
      {showInitials ? (
        initials
      ) : (
        <img
          src={src}
          alt={name || 'Avatar'}
          onError={() => setImageError(true)}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
          }}
        />
      )}
    </div>
  );
}
