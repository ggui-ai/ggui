import type { NavigationBarProps, NavItem } from './types';
import { colors } from '../tokens/colors';
import { radius } from '../tokens/spacing';
import { fontSize, fontWeight } from '../tokens/typography';

/**
 * NavigationBar - A horizontal or vertical navigation menu
 */
export function NavigationBar({
  items,
  activeId,
  onItemClick,
  orientation = 'horizontal',
  variant = 'default',
  style,
  className,
}: NavigationBarProps) {
  const renderItem = (item: NavItem) => {
    const isActive = activeId === item.id;

    const baseStyle: React.CSSProperties = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: orientation === 'horizontal' ? '8px 16px' : '10px 16px',
      border: 'none',
      background: 'none',
      fontSize: fontSize.sm,
      cursor: item.disabled ? 'not-allowed' : 'pointer',
      opacity: item.disabled ? 0.5 : 1,
      transition: 'all 0.15s',
      textDecoration: 'none',
      color: 'inherit',
    };

    const variantStyles: Record<string, React.CSSProperties> = {
      default: {
        fontWeight: isActive ? fontWeight.medium : fontWeight.normal,
        color: isActive ? colors.primary[600] : colors.gray[600],
      },
      pills: {
        borderRadius: radius.full,
        backgroundColor: isActive ? colors.primary[100] : 'transparent',
        color: isActive ? colors.primary[700] : colors.gray[600],
        fontWeight: isActive ? fontWeight.medium : fontWeight.normal,
      },
      underline: {
        borderBottom: isActive ? `2px solid ${colors.primary[600]}` : '2px solid transparent',
        color: isActive ? colors.primary[600] : colors.gray[600],
        fontWeight: isActive ? fontWeight.medium : fontWeight.normal,
        borderRadius: 0,
      },
    };

    const handleClick = () => {
      if (!item.disabled) {
        onItemClick?.(item);
      }
    };

    const content = (
      <>
        {item.icon && <span style={{ display: 'flex' }}>{item.icon}</span>}
        <span>{item.label}</span>
      </>
    );

    if (item.href) {
      return (
        <a
          key={item.id}
          href={item.href}
          onClick={(e) => {
            e.preventDefault();
            handleClick();
          }}
          style={{ ...baseStyle, ...variantStyles[variant] }}
        >
          {content}
        </a>
      );
    }

    return (
      <button
        key={item.id}
        onClick={handleClick}
        disabled={item.disabled}
        style={{ ...baseStyle, ...variantStyles[variant] }}
      >
        {content}
      </button>
    );
  };

  return (
    <nav
      className={className}
      style={{
        display: 'flex',
        flexDirection: orientation === 'horizontal' ? 'row' : 'column',
        gap: orientation === 'horizontal' ? '4px' : '2px',
        ...(variant === 'underline' && orientation === 'horizontal' && {
          borderBottom: `1px solid ${colors.gray[200]}`,
        }),
        ...style,
      }}
    >
      {items.map(renderItem)}
    </nav>
  );
}
