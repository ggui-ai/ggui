import { forwardRef, useState, type CSSProperties, type ReactNode, type MouseEvent, type KeyboardEvent } from 'react';

export interface PressableProps {
  children?: ReactNode | ((state: { pressed: boolean; hovered: boolean }) => ReactNode);
  /**
   * Press handler. Receives the `MouseEvent` for pointer presses and
   * the `KeyboardEvent` for Enter/Space keyboard activation — the
   * union is honest about both delivery paths.
   */
  onPress?: (e: MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>) => void;
  onLongPress?: (e: MouseEvent<HTMLDivElement>) => void;
  /** Long press duration in ms. @default 500 */
  longPressDelay?: number;
  /** Style applied on hover */
  hoverStyle?: CSSProperties;
  /** Style applied while pressed */
  pressStyle?: CSSProperties;
  /** Disable interaction */
  disabled?: boolean;
  /** CSS transition. @default 'all 150ms ease' */
  transition?: string;
  role?: string;
  'aria-label'?: string;
  tabIndex?: number;
  style?: CSSProperties;
  className?: string;
}

/**
 * Pressable — React Native-inspired press interaction.
 *
 * Supports render-as-function for dynamic children:
 * `<Pressable>{({ pressed }) => <Text>{pressed ? 'Pressing!' : 'Press me'}</Text>}</Pressable>`
 *
 * Use with `as` prop: `<Card as={Pressable} onPress={handler}>`
 */
export const Pressable = forwardRef<HTMLDivElement, PressableProps>(function Pressable(
  {
    children,
    onPress,
    onLongPress,
    longPressDelay = 500,
    hoverStyle,
    pressStyle,
    disabled = false,
    transition = 'all 150ms ease',
    role,
    'aria-label': ariaLabel,
    tabIndex,
    style,
    className,
    ...rest
  },
  ref,
) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [longPressTimer, setLongPressTimer] = useState<ReturnType<typeof setTimeout> | null>(null);

  const hasPress = !!onPress || !!onLongPress;

  const handleMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (disabled) return;
    setPressed(true);
    if (onLongPress) {
      const timer = setTimeout(() => { onLongPress(e); }, longPressDelay);
      setLongPressTimer(timer);
    }
  };

  const handleMouseUp = (e: MouseEvent<HTMLDivElement>) => {
    if (disabled) return;
    setPressed(false);
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      setLongPressTimer(null);
      onPress?.(e); // short press
    } else if (!onLongPress) {
      onPress?.(e);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || !onPress) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onPress(e);
    }
  };

  const mergedStyle: CSSProperties = {
    ...style,
    cursor: disabled ? 'not-allowed' : (hasPress ? 'pointer' : undefined),
    transition,
    opacity: disabled ? 0.5 : undefined,
    userSelect: hasPress ? 'none' : undefined,
    ...(hovered && !disabled ? hoverStyle : {}),
    ...(pressed && !disabled ? pressStyle : {}),
  };

  const content = typeof children === 'function'
    ? children({ pressed, hovered })
    : children;

  return (
    <div
      ref={ref}
      className={className}
      style={mergedStyle}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setPressed(false); if (longPressTimer) clearTimeout(longPressTimer); }}
      onKeyDown={handleKeyDown}
      role={role ?? (hasPress ? 'button' : undefined)}
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      tabIndex={tabIndex ?? (hasPress ? 0 : undefined)}
      {...rest}
    >
      {content}
    </div>
  );
});
