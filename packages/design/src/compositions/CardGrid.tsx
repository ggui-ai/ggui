import type { CardGridProps } from './types';

/**
 * CardGrid - A responsive grid layout for cards
 */
export function CardGrid({
  children,
  columns = 3,
  gap = 16,
  style,
  className,
}: CardGridProps) {
  // Handle responsive columns
  const getGridColumns = () => {
    if (typeof columns === 'number') {
      return `repeat(${columns}, 1fr)`;
    }
    // For responsive, we'll use a simple approach with minmax
    // In a real implementation, you'd want CSS media queries
    return `repeat(auto-fit, minmax(280px, 1fr))`;
  };

  return (
    <div
      className={className}
      style={{
        display: 'grid',
        gridTemplateColumns: getGridColumns(),
        gap: `${gap}px`,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
