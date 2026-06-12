import { forwardRef, useState, type CSSProperties, type ReactNode, type MouseEvent, type KeyboardEvent } from 'react';

export interface ClickableProps {
  children?: ReactNode;
  /**
   * Activation handler. Receives the `MouseEvent` for pointer clicks
   * and the `KeyboardEvent` for Enter/Space keyboard activation — the
   * union is honest about both delivery paths.
   */
  onClick?: (e: MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>) => void;
  onDoubleClick?: (e: MouseEvent<HTMLDivElement>) => void;
  /** Style applied on hover. Merged with base style. */
  hoverStyle?: CSSProperties;
  /** Style applied while pressed/active. Merged with base style. */
  activeStyle?: CSSProperties;
  /** Cursor on hover. @default 'pointer' when onClick is set */
  cursor?: string;
  /** CSS transition. @default 'all 200ms ease' */
  transition?: string;
  /** Disable interaction */
  disabled?: boolean;
  /** ARIA role. @default 'button' when onClick is set */
  role?: string;
  /** ARIA label for accessibility */
  'aria-label'?: string;
  /** Tab index for keyboard navigation. @default 0 when onClick is set */
  tabIndex?: number;
  style?: CSSProperties;
  className?: string;
}

/**
 * Clickable — interaction wrapper for any primitive.
 *
 * Use with the `as` prop pattern: `<Card as={Clickable} onClick={...}>`
 * Or standalone: `<Clickable onClick={...}>content</Clickable>`
 *
 * Adds: click handling, hover/active styles, keyboard activation (Enter/Space),
 * cursor, transition, and ARIA attributes.
 */
export const Clickable = forwardRef<HTMLDivElement, ClickableProps>(function Clickable(
  {
    children,
    onClick,
    onDoubleClick,
    hoverStyle,
    activeStyle,
    cursor,
    transition = 'all 200ms ease',
    disabled = false,
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
  const [active, setActive] = useState(false);

  const hasClick = !!onClick;
  const resolvedCursor = disabled ? 'not-allowed' : (cursor ?? (hasClick ? 'pointer' : undefined));
  const resolvedRole = role ?? (hasClick ? 'button' : undefined);
  const resolvedTabIndex = tabIndex ?? (hasClick ? 0 : undefined);

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || !onClick) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick(e);
    }
  };

  const mergedStyle: CSSProperties = {
    ...style,
    cursor: resolvedCursor,
    transition,
    opacity: disabled ? 0.5 : undefined,
    ...(hovered && !disabled ? hoverStyle : {}),
    ...(active && !disabled ? activeStyle : {}),
  };

  return (
    <div
      ref={ref}
      className={className}
      style={mergedStyle}
      onClick={disabled ? undefined : onClick}
      onDoubleClick={disabled ? undefined : onDoubleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setActive(false); }}
      onMouseDown={() => setActive(true)}
      onMouseUp={() => setActive(false)}
      onKeyDown={handleKeyDown}
      role={resolvedRole}
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      tabIndex={resolvedTabIndex}
      {...rest}
    >
      {children}
    </div>
  );
});
