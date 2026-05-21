import { forwardRef, useState, type CSSProperties, type ReactNode } from 'react';

export interface HoverableProps {
  children?: ReactNode;
  /** Style applied on hover. Merged with base style. */
  hoverStyle?: CSSProperties;
  /** Called when hover state changes */
  onHoverChange?: (hovered: boolean) => void;
  /** CSS transition. @default 'all 200ms ease' */
  transition?: string;
  style?: CSSProperties;
  className?: string;
}

/**
 * Hoverable — adds hover state and style transitions.
 *
 * Use with `as` prop: `<Card as={Hoverable} hoverStyle={{ opacity: 0.8 }}>`
 * Or standalone: `<Hoverable hoverStyle={...}>content</Hoverable>`
 */
export const Hoverable = forwardRef<HTMLDivElement, HoverableProps>(function Hoverable(
  {
    children,
    hoverStyle,
    onHoverChange,
    transition = 'all 200ms ease',
    style,
    className,
    ...rest
  },
  ref,
) {
  const [hovered, setHovered] = useState(false);

  const mergedStyle: CSSProperties = {
    ...style,
    transition,
    ...(hovered ? hoverStyle : {}),
  };

  return (
    <div
      ref={ref}
      className={className}
      style={mergedStyle}
      onMouseEnter={() => { setHovered(true); onHoverChange?.(true); }}
      onMouseLeave={() => { setHovered(false); onHoverChange?.(false); }}
      {...rest}
    >
      {children}
    </div>
  );
});
