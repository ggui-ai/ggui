import type { DividerProps } from './types';
import { resolveToneCss } from './color-slots';

/**
 * Divider - A horizontal or vertical line to separate content
 */
export function Divider({
  orientation = 'horizontal',
  margin = 'var(--ggui-spacing-md, 16px)',
  tone,
  style,
  className,
}: DividerProps) {
  const resolvedMargin = typeof margin === 'number' ? `${margin}px` : margin;
  const dividerColor = tone
    ? resolveToneCss(tone)
    : 'var(--ggui-color-outlineVariant, #e4e4e7)';

  if (orientation === 'vertical') {
    return (
      <div
        role="separator"
        aria-orientation="vertical"
        className={className}
        style={{
          width: '1px',
          backgroundColor: dividerColor,
          margin: `0 ${resolvedMargin}`,
          alignSelf: 'stretch',
          ...style,
        }}
      />
    );
  }

  return (
    <hr
      role="separator"
      aria-orientation="horizontal"
      className={className}
      style={{
        border: 'none',
        height: '1px',
        backgroundColor: dividerColor,
        margin: `${resolvedMargin} 0`,
        ...style,
      }}
    />
  );
}
