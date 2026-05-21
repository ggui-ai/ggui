import type { SpacerProps } from './types';

/**
 * Spacer - Creates space between elements, either fixed size or flexible
 */
export function Spacer({
  size = 16,
  style,
  className,
}: SpacerProps) {
  if (size === 'flex') {
    return (
      <div
        className={className}
        style={{
          flex: 1,
          ...style,
        }}
      />
    );
  }

  return (
    <div
      className={className}
      style={{
        width: `${size}px`,
        height: `${size}px`,
        flexShrink: 0,
        ...style,
      }}
    />
  );
}
