import { useState } from 'react';
import type { SidebarProps, SidebarItem as SidebarItemType } from './types';
import { colors } from '../tokens/colors';
import { radius } from '../tokens/spacing';
import { fontSize, fontWeight } from '../tokens/typography';
import { Icon } from '../primitives/Icon';

function SidebarItem({
  item,
  activeId,
  onItemClick,
  collapsed,
  depth = 0,
}: {
  item: SidebarItemType;
  activeId?: string;
  onItemClick?: (item: SidebarItemType) => void;
  collapsed?: boolean;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasChildren = item.children && item.children.length > 0;
  const isActive = activeId === item.id;

  const handleClick = () => {
    if (hasChildren && !collapsed) {
      setExpanded(!expanded);
    }
    onItemClick?.(item);
  };

  return (
    <div>
      <button
        onClick={handleClick}
        disabled={item.disabled}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          width: '100%',
          padding: collapsed ? '10px' : '10px 12px',
          paddingLeft: collapsed ? '10px' : `${12 + depth * 16}px`,
          border: 'none',
          borderRadius: radius.md,
          backgroundColor: isActive ? colors.primary[50] : 'transparent',
          color: item.disabled ? colors.gray[400] : isActive ? colors.primary[700] : colors.gray[700],
          fontSize: fontSize.sm,
          fontWeight: isActive ? fontWeight.medium : fontWeight.normal,
          textAlign: 'left',
          cursor: item.disabled ? 'not-allowed' : 'pointer',
          transition: 'all 0.15s',
          justifyContent: collapsed ? 'center' : 'flex-start',
        }}
      >
        {item.icon && (
          <span style={{ display: 'flex', flexShrink: 0 }}>{item.icon}</span>
        )}
        {!collapsed && (
          <>
            <span style={{ flex: 1 }}>{item.label}</span>
            {item.badge && <span>{item.badge}</span>}
            {hasChildren && (
              <Icon
                name={expanded ? 'chevron-down' : 'chevron-right'}
                size={14}
                tone="subtle"
              />
            )}
          </>
        )}
      </button>
      {hasChildren && expanded && !collapsed && (
        <div style={{ marginTop: '4px' }}>
          {item.children!.map((child) => (
            <SidebarItem
              key={child.id}
              item={child}
              activeId={activeId}
              onItemClick={onItemClick}
              collapsed={collapsed}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Sidebar - A navigation sidebar with collapsible sections
 */
export function Sidebar({
  items,
  activeId,
  onItemClick,
  collapsed = false,
  header,
  footer,
  width = 256,
  collapsedWidth = 64,
  style,
  className,
}: SidebarProps) {
  const currentWidth = collapsed ? collapsedWidth : width;

  return (
    <aside
      className={className}
      style={{
        width: currentWidth,
        minWidth: currentWidth,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: colors.white,
        borderRight: `1px solid ${colors.gray[200]}`,
        transition: 'width 0.2s',
        overflow: 'hidden',
        ...style,
      }}
    >
      {header && (
        <div
          style={{
            padding: collapsed ? '16px 8px' : '16px',
            borderBottom: `1px solid ${colors.gray[200]}`,
          }}
        >
          {header}
        </div>
      )}
      <nav
        style={{
          flex: 1,
          padding: '8px',
          overflowY: 'auto',
          overflowX: 'hidden',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {items.map((item) => (
            <SidebarItem
              key={item.id}
              item={item}
              activeId={activeId}
              onItemClick={onItemClick}
              collapsed={collapsed}
            />
          ))}
        </div>
      </nav>
      {footer && (
        <div
          style={{
            padding: collapsed ? '16px 8px' : '16px',
            borderTop: `1px solid ${colors.gray[200]}`,
          }}
        >
          {footer}
        </div>
      )}
    </aside>
  );
}
